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
const { seenAuditEntry, seenCombo } = require('./dedupe');
const { punishExecutor, beginPunish, endPunish } = require('./punishment');
const { sendUnresolvedLog } = require('./logger');
const { queueIncidentLog, targetKindFor } = require('./incidentLog');
const { noteEvent } = require('./health');
const { recordIncident, markIncidentPunished } = require('./incidents');
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

    // 1a. ÖNCE internal action kontrolü: botun kendi işlemi audit'e
    // gitmeden elenir (audit çağrısı YOK, log YOK — self-loop'un kökü).
    if (isBotAction(guild.id, def.audit, String(targetId))) {
      return { handled: false, reason: 'self' };
    }

    // 1b. Executor'ı audit logdan doğrula (önceden çözülmüşse tekrar çekme).
    // Bulunamazsa TEK kısa retry (§7): başarılı olursa akışa devam edilir,
    // log SADECE en sonda (throttle'lı) atılır — retry başına log YOK.
    let found = resolved || (await findExecutor(guild, def.audit, targetId, auditOpts));
    if (!found) {
      await new Promise((r) => setTimeout(r, 700));
      found = await findExecutor(guild, def.audit, targetId, { ...auditOpts, attempts: 1 }).catch(() => null);
    }
    noteEvent(action, !!found);
    if (!found) {
      // Executor bilinmiyor: incident'a bağlanamaz → throttle'lı TEK unverified log.
      if (seenCombo(guild.id, 'unknown', action, String(targetId))) {
        return { handled: true, punished: false, reason: 'unresolved-throttled' };
      }
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

    // 1c. Aynı audit kaydı iki kez işlenmez (§11-12).
    try {
      if (entry?.id && seenAuditEntry(guild.id, entry.id)) {
        return { handled: true, punished: false, reason: 'duplicate-entry' };
      }
    } catch {
      /* dedup hatası akışı engellemez */
    }
    // 1d. actor+action+target ikinci katman (§11).
    try {
      if (seenCombo(guild.id, execId, action, String(targetId))) {
        return { handled: true, punished: false, reason: 'duplicate-combo' };
      }
    } catch {
      /* dedup hatası akışı engellemez */
    }

    // 2. Botun kendi işlemi / sahip → yoksay (tracker-first'in yedeği)
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
      // İzinli işlem: log kanalına DEĞİL, console'a iç kayıt (§14).
      logger.info(`Guard: izinli işlem (${def.label} → ${execId}, seviye ${level}).`);
      return { handled: false, reason: 'allowed' };
    }

    // 3b. Dedupe: aynı saldırı kısa sürede tekrar cezalandırılmaz
    if (alreadyPunished(guild.id, action, String(targetId), execId)) {
      logger.info(`Guard: duplicate saldırı yoksayıldı (${def.label} → ${execId}).`);
      return { handled: true, punished: false, reason: 'duplicate' };
    }

    // 3c. Incident: aynı saldırganın 5dk penceresindeki işlemleri gruplanır.
    // Bu incidentte zaten ban yediyse tekrar ban atılmaz (rollback+log devam eder).
    const incident = recordIncident(guild.id, execId, action, String(targetId));

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
      // Incident'te zaten banlandıysa ve hâlâ banlıysa tekrar deneme
      let skipPunish = false;
      if (incident.punished) {
        try {
          const stillBanned = await guild.bans.fetch(execId).catch(() => null);
          skipPunish = !!stillBanned;
        } catch {
          skipPunish = false;
        }
      }
      if (skipPunish) {
        punishment = { ok: true, detail: 'Zaten banlı (incident — tekrar ban atılmadı).' };
        rollback = await runRollback();
      } else if (memberFirst) {
        rollback = await runRollback();
        punishment = await punishExecutor(guild, execId, `Javrex Bot System Guard: yetkisiz işlem (${def.label})`);
        if (punishment.ok) markIncidentPunished(guild.id, execId);
      } else {
        punishment = await punishExecutor(guild, execId, `Javrex Bot System Guard: yetkisiz işlem (${def.label})`);
        if (punishment.ok) markIncidentPunished(guild.id, execId);
        rollback = await runRollback();
      }
    } finally {
      endPunish(guild.id, execId);
    }

    // 6. Log TEK incident kuyruğuna gider (doğrudan sendBanLog YOK — §2, §15).
    // punish + rollback yukarıda ZATEN uygulandı; burada sadece incident detayı
    // birikir, pencere sonunda TEK embed atılır (incidentLog.logSent korumalı).
    try {
      queueIncidentLog(
        guild,
        execSnap,
        {
          action,
          actionLabel: def.label,
          guardLabel: CATEGORY_LABEL[def.category] || def.category,
          targetId: String(targetId),
          targetKind: targetKindFor(action),
          targetDesc,
          punishment,
          rollback,
          sensitive: !!sensitive,
        },
      );
    } catch (err) {
      logger.error('Guard incident kuyruk hatası (ceza/rollback ETKİLENMEDİ).', err);
    }

    logger.success(`Guard: ${execSnap.tag} cezalandırıldı (${def.label}) — ban=${punishment.ok} rollback=${rollback?.ok ?? 'yok'}`);
    return { handled: true, punished: punishment.ok, rollback };
  } catch (err) {
    logger.error(`Guard manager hatası (${action}).`, err);
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleGuardEvent, _recentPunishments: recentPunishments };
