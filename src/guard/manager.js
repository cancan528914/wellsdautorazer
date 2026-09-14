/**
 * Guard merkezi: event → audit doğrulama → whitelist → rollback → ceza → log.
 * Kurulum yapılmamış sunucuda SESSİZ kalır (yanlış ban yok).
 * Botun kendi işlemleri ve sahip işlemleri yoksayılır.
 */
const logger = require('../utils/logger');
const { GUARD_ACTION, CATEGORY_LABEL } = require('./constants');
const { findExecutor } = require('./audit');
const { levelOf, isAllowed } = require('./permissions');
const { isBotAction } = require('./tracker');
const { punishExecutor } = require('./punishment');
const { sendBanLog, sendUnresolvedLog } = require('./logger');
const { getGuardSettings } = require('../database/database');

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
 */
async function handleGuardEvent({ client, guild, action, targetId, targetDesc, doRollback = null, auditOpts = {}, resolved = null }) {
  const def = GUARD_ACTION[action];
  if (!def || !guild) return { handled: false };

  try {
    // 0. Guard kurulu değilse hiçbir şey yapma (güvenli varsayılan)
    const settings = getGuardSettings(guild.id);
    if (!settings?.enabled) return { handled: false, reason: 'disabled' };

    // 1. Executor'ı audit logdan doğrula (önceden çözülmüşse tekrar çekme)
    const found = resolved || (await findExecutor(guild, def.audit, targetId, auditOpts));
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

    // 3. Whitelist kontrolü (açık izinler — numeric karşılaştırma yok)
    const level = levelOf(guild.id, execId);
    if (isAllowed(level, def.category)) {
      return { handled: false, reason: 'allowed' }; // sessiz: log YOK (spec 22)
    }

    // 4. Ceza ÖNCE (hız için), rollback sonra — TEK İSTİSNA: üye-rol işlemi.
    // Rol rollback'i üyenin sunucuda olmasını gerektirir; ban önce atılırsa
    // API rol düzenlemeyi reddeder. Diğer tüm rollbackler üyelikten bağımsızdır.
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
    if (memberFirst) {
      rollback = await runRollback();
      punishment = await punishExecutor(guild, execId, `WELLSD GUARD: yetkisiz işlem (${def.label})`);
    } else {
      punishment = await punishExecutor(guild, execId, `WELLSD GUARD: yetkisiz işlem (${def.label})`);
      rollback = await runRollback();
    }

    // 5. Log (ban BAŞARILI → BANNED, değilse → THREAT DETECTED)
    await sendBanLog(guild, {
      executor,
      actionLabel: def.label,
      guardLabel: CATEGORY_LABEL[def.category] || def.category,
      targetDesc,
      punishment,
      rollback,
    }).catch(() => {});

    logger.success(`Guard: ${executor.tag || execId} cezalandırıldı (${def.label}) — ban=${punishment.ok} rollback=${rollback?.ok ?? 'yok'}`);
    return { handled: true, punished: punishment.ok, rollback };
  } catch (err) {
    logger.error(`Guard manager hatası (${action}).`, err);
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleGuardEvent };
