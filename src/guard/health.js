/**
 * Guard health checker: bağımlılıkların durumunu raporlar.
 * Pasif yapı — kendi başına restart atmaz, sadece ölçer.
 * Pasif izleme: manager her olayda healthState günceller (timersız).
 */
const logger = require('../utils/logger');

const healthState = {
  lastEventAt: 0,
  lastAuditOk: null,
  lastAction: null,
};

function noteEvent(action, auditOk) {
  try {
    healthState.lastEventAt = Date.now();
    healthState.lastAction = String(action || '');
    if (typeof auditOk === 'boolean') healthState.lastAuditOk = auditOk;
  } catch {
    /* izleme kritik değil */
  }
}

function checkRollbackEngine() {
  try {
    const rb = require('./rollback');
    const needed = [
      'rollbackRoleCreate', 'rollbackRoleDelete', 'rollbackRoleUpdate', 'rollbackMemberRoles',
      'rollbackChannelCreate', 'rollbackChannelDelete', 'rollbackChannelUpdate',
      'rollbackBan', 'rollbackTimeout', 'rollbackWebhook', 'rollbackGuild',
    ];
    const missing = needed.filter((k) => typeof rb[k] !== 'function');
    return { ok: missing.length === 0, detail: missing.length ? `eksik: ${missing.join(',')}` : `${needed.length} rollback hazır` };
  } catch (err) {
    return { ok: false, detail: `yüklenemedi: ${err.message}` };
  }
}

function checkListeners(client) {
  try {
    const events = [
      'roleCreate', 'roleDelete', 'roleUpdate', 'channelCreate', 'channelDelete', 'channelUpdate',
      'guildMemberUpdate', 'guildBanAdd', 'guildBanRemove', 'guildMemberRemove',
      'webhooksUpdate', 'guildUpdate', 'emojiCreate', 'emojiDelete', 'emojiUpdate',
      'stickerCreate', 'stickerDelete', 'stickerUpdate', 'threadCreate', 'threadDelete',
    ];
    const missing = events.filter((e) => !client || typeof client.listenerCount !== 'function' || client.listenerCount(e) < 1);
    return { ok: missing.length === 0, detail: missing.length ? `dinleyici yok: ${missing.join(',')}` : `${events.length} event dinleniyor` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function checkAudit(guild) {
  if (!guild) return { ok: true, detail: 'sunucu bağlamı yok (atlandı)' };
  try {
    await guild.fetchAuditLogs({ limit: 1 });
    return { ok: true, detail: 'okunabiliyor' };
  } catch (err) {
    return { ok: false, detail: `okunamıyor: ${err.code || err.message}` };
  }
}

async function checkLoggerDb(guild) {
  try {
    const { getGuardSettings, listWhitelist } = require('../database/database');
    if (!guild) {
      getGuardSettings('health-probe-never');
      return { ok: true, detail: 'DB + whitelist sorgusu OK' };
    }
    const settings = getGuardSettings(guild.id);
    listWhitelist(guild.id);
    if (!settings?.log_channel_id) return { ok: false, detail: 'log kanalı ayarlı değil' };
    const ch = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
    if (!ch?.isTextBased()) return { ok: false, detail: 'log kanalı bulunamadı' };
    return { ok: true, detail: 'DB + log kanalı OK' };
  } catch (err) {
    return { ok: false, detail: `hata: ${err.message}` };
  }
}

/**
 * @returns {Promise<{ ok: boolean, checks: Array<{key,label,ok,detail}> }>}
 */
async function checkHealth(client, guild = null) {
  const checks = [];
  try {
    const db = require('../database/database');
    let dbOk = false;
    let dbDetail = 'okunamadı';
    try {
      dbOk = db.dbHealthy();
      dbDetail = dbOk ? 'bağlantı OK' : 'ulaşılamıyor';
    } catch (err) {
      dbDetail = err.message;
    }
    checks.push({ key: 'database', label: 'Database', ok: dbOk, detail: dbDetail });
    const audit = await checkAudit(guild);
    checks.push({ key: 'audit', label: 'Audit Logs', ...audit });
    const listeners = checkListeners(client);
    checks.push({ key: 'listeners', label: 'Event Listener', ...listeners });
    const logdb = await checkLoggerDb(guild);
    checks.push({ key: 'logger', label: 'Logger', ...logdb });
    const rb = checkRollbackEngine();
    checks.push({ key: 'rollback', label: 'Rollback Engine', ...rb });
    try {
      const { listWhitelist } = require('../database/database');
      if (guild) listWhitelist(guild.id);
      checks.push({ key: 'whitelist', label: 'Whitelist', ok: true, detail: 'sorgu OK' });
    } catch (err) {
      checks.push({ key: 'whitelist', label: 'Whitelist', ok: false, detail: err.message });
    }
  } catch (err) {
    logger.error('Guard health check hatası.', err);
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

module.exports = { checkHealth, noteEvent, healthState };
