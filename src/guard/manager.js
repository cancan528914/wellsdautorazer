/**
 * Guard merkezi: event → audit doğrulama → whitelist → rollback → ceza → log.
 * - Kurulum yoksa SESSİZ (yanlış ban yok).
 * - DB erişilemiyorsa FAIL-CLOSED: ceza yok, açık log var.
 * - Aynı saldırı 30sn içinde tekrar cezalandırılmaz (dedupe).
 * - Aynı kullanıcıya eşzamanlı 2. ban denenmez (punishing kilidi).
 * - Botun kendi işlemleri / sahip işlemleri yoksayılır.
 */
const logger = require('../utils/logger');
const { GUARD_ACTION, CATEGORY_LABEL, DEDUPE_TTL_MS } = require('./constants');
const { findExecutor } = require('./audit');
const { levelOf, isAllowed } = require('./permissions');
const { isBotAction } = require('./tracker');
const { punishExecutor, beginPunish, endPunish } = require('./punishment');
const { sendBanLog, sendUnresolvedLog, sendAllowedLog } = require('./logger');
const { noteEvent } = require('./health');
const db = require('../database/database');

// `${guildId}:${action}:${targetId}:${executorId}` -> expiry (dedupe penceresi)
const recentPunishments = new Map();

function sweepDedupe(now = Date.now()) {
  try {
    for (const [k, exp] of recentPunishments) {
      if (exp <= now) recentPunishments.delete(k);
    }
    if (recentPunishments.size > 500) {
      const sorted = [...recentPunishments.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of sorted.slice(0, recentPunishments.size - 500)) recentPunishments.delete(k);
    }
  } catch {
    /* ignore */
  }
}

function alreadyPunished(guildId, action, targetId, executorId) {
  try {
    const key = `${guildId}:${action}:${targetId}:${executorId}`;
    const exp = recentPunishments.get(key);
    if (exp && exp > Date.now()) return true;
    if (exp) recentPunishments.delete(key);
    return false;
  } catch {
    return false;
  }
}

function markPunished(guildId, action, targetId, executorId) {
  try {
    recentPunishments.set(`${guildId}:${action}:${targetId}:${executorId}`, Date.now() + DEDUPE_TTL_MS);
    if (recentPunishments.size % 20 === 0 || recentPunishments.size > 500) sweepDedupe();
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} p
 * @param {object} p.client - discord client (bot id için)
 * @param {object} p.guild
 * @param {string} p.action - GUARD_ACTION anahtarı
 * @param {string} p.targetId - audit hedef ID
 * @param {string} p.targetDesc - logda görünecek hedef
 * @param {function} [p.doRollback] - async (ctx) => ({ok, detail}|null)
 * @param {object} [p.auditOpts] - findExecutor opsiyonları
 * @param {object} [p.resolved] - önceden çözülmüş { executor, entry } (tekrar audit çekilmez)
 * @param {boolean} [p.sensitive] - botun kritik rolü hedefte (logda vurgulanır)
 */
async function handleGuardEvent({ client, guild, action, targetId, targetDesc, doRollback = null, auditOpts = {}, resolved = null, sensitive = false }) {
  const def = GUARD_ACTION[action];
  if (!def || !guild) return { handled: false };

  try {
    // 0a. DB down ise FAIL-CLOSED: rastgele allow/ban YOK, açık log var
    let dbOk = false;
    try {
      dbOk = db.dbHealthy();
    } catch {
      dbOk = false;
    }
    if (!dbOk) {
      logger.error('Guard: database erişilemiyor — fail-closed, ceza uygulanmıyor.');
      await sendUnresolvedLog(guild, {
        actionLabel: def.label,
        targetDesc,
        reason: 'Database erişilemiyor (fail-closed: ceza yok).',
      }).catch(() => {});
      return { handled: true, punished: false, reason: 'db-down' };
    }

    // 0b. Guard kurulu değilse hiçbir şey yapma (güvenli varsayılan)
    const settings = db.getGuardSettings(guild.id);
    if (!settings?.enabled) return { handled: false, reason: 'disabled' };

    // 1. Executor'ı audit logdan doğrula (önceden çözülmüşse tekrar çekme)
    const found = resolved || (await findExecutor(guild, def.audit, targetId, auditOpts));
    noteEvent(action, !!found);
    if (!found) {
      logger.warn(`Guard: executor doğrulanamadı (${def.label} → ${targetId}). Ceza yok.`);
      await sendUnresolvedLog(guild, {
        actionLabel: def.label,
        targetDesc,
        reason: 'Audit Log’da işlem/hedef/zaman eşleşmesi bulunamadı.',
      }).catch(() => {});
      return { handled: true, punished: false, reason: 'unresolved' };
    }
    const { executor, entry } = found;
    const execId = String(executor.id);

    // 2. Botun kendi işlemi / sahip → yoksay
    const botId = String(client?.user?.id || '');
    if ((botId && execId === botId) || executor.bot || isBotAction(guild.id, def.audit, String(targetId))) {
      return { handled: false, reason: 'self' };
    }
    if (execId === String(guild.ownerId)) {
      logger.info(`Guard: sunucu sahibi işlemi yoksayıldı (${def.label}).`);
      return { handled: false, reason: 'owner' };
    }

    // 3. Whitelist kontrolü (registry: açık izin seti)
    const level = levelOf(guild.id, execId);
    if (isAllowed(level, def.category)) {
      // URL Guard: sessiz değil, YEŞİL internal kayıt (ban logu değil)
      if (level === 4) {
        const { LEVEL_META } = require('./constants');
        await sendAllowedLog(guild, {
          executor: { id: execId, tag: executor.tag },
          levelLabel: `${LEVEL_META[4].emoji} ${LEVEL_META[4].label}`,
          actionLabel: def.label,
          targetDesc,
        }).catch(() => {});
      }
      return { handled: false, reason: 'allowed' };
    }

    // 3b. Dedupe: aynı saldırı kısa sürede tekrar cezalandırılmaz
    if (alreadyPunished(guild.id, action, String(targetId), execId)) {
      logger.info(`Guard: duplicate saldırı yoksayıldı (${def.label} → ${execId}).`);
      return { handled: true, punished: false, reason: 'duplicate' };
    }

    // 4. Ban snapshot'ı ÖNCEDEN yakala (ban sonrası veri kaybolmasın)
    const execSnap = { id: execId, tag: executor.tag || 'Bilinmeyen', bot: !!executor.bot };

    // 5. Ceza ÖNCE (hız için), rollback sonra — TEK İSTİSNA: üye-rol işlemi.
    const memberFirst = action === 'MEMBER_ROLE_UPDATE';
    const runRollback = async () => {
      if (typeof doRollback !== 'function') return null;
      try {
        return (await doRollback({ entry, executor })) || null;
      } catch (err) {
        return { ok: false, detail: `Rollback hatası: ${err.code || err.message}` };
      }
    };

    let rollback = null;
    let punishment;
    // Eşzamanlı duplicate ban kilidi
    const lockOk = beginPunish(guild.id, execId);
    try {
      if (!lockOk) {
        logger.info(`Guard: eşzamanlı ban zaten sürüyor (${execId}) — duplicate atlandı.`);
        return { handled: true, punished: false, reason: 'duplicate' };
      }
      markPunished(guild.id, action, String(targetId), execId);
      if (memberFirst) {
        rollback = await runRollback();
        punishment = await punishExecutor(guild, execId, `WELLSD GUARD: yetkisiz işlem (${def.label})`);
      } else {
        punishment = await punishExecutor(guild, execId, `WELLSD GUARD: yetkisiz işlem (${def.label})`);
        rollback = await runRollback();
      }
    } finally {
      endPunish(guild.id, execId);
    }

    // 6. Log (ban BAŞARILI → BANNED, değilse → THREAT DETECTED)
    await sendBanLog(guild, {
      executor: execSnap,
      actionLabel: def.label,
      guardLabel: CATEGORY_LABEL[def.category] || def.category,
      targetDesc,
      punishment,
      rollback,
      sensitive,
    }).catch(() => {});

    logger.success(`Guard: ${execSnap.tag} cezalandırıldı (${def.label}) — ban=${punishment.ok} rollback=${rollback?.ok ?? 'yok'}`);
    return { handled: true, punished: punishment.ok, rollback };
  } catch (err) {
    logger.error(`Guard manager hatası (${action}).`, err);
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleGuardEvent, _recentPunishments: recentPunishments };
