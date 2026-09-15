/**
 * Ceza sistemi: executor'ı güvenli şekilde banlar. Asla crash etmez.
 * Hız için: önce keşif çağrısı YOK — doğrudan ban denenir, hata koduna göre raporlanır.
 * (Zaten banlı kullanıcıya ban idempotent'tir; hiyerarşi sorunu 50013 olarak döner.)
 */
const { AuditLogEvent } = require('discord.js');
const { markBotAction } = require('./tracker');
const { PUNISH_TTL_MS } = require('./constants');

// Devam eden banlar: `${guildId}:${userId}` -> expiry. Aynı kullanıcıya
// eşzamanlı ikinci ban denemesi engellenir (duplicate punishment yok).
const punishing = new Map();

function sweepPunishing(now = Date.now()) {
  try {
    for (const [k, exp] of punishing) {
      if (exp <= now) punishing.delete(k);
    }
  } catch {
    /* ignore */
  }
}

/** Ban zaten sürüyorsa false döner (çağıran atlamalı). */
function beginPunish(guildId, userId) {
  try {
    sweepPunishing();
    const key = `${guildId}:${userId}`;
    const exp = punishing.get(key);
    if (exp && exp > Date.now()) return false;
    punishing.set(key, Date.now() + PUNISH_TTL_MS);
    return true;
  } catch {
    return true; // kilit hatası banı engellemesin
  }
}

function endPunish(guildId, userId) {
  try {
    punishing.delete(`${guildId}:${userId}`);
  } catch {
    /* ignore */
  }
}

/**
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function punishExecutor(guild, executorId, reason) {
  const id = String(executorId);
  try {
    if (id === String(guild.ownerId)) {
      return { ok: false, detail: 'Hedef sunucu sahibi (banlanamaz).' };
    }
    markBotAction(guild.id, AuditLogEvent.MemberBanAdd, id);
    await guild.members.ban(id, { reason: String(reason || 'WELLSD GUARD: yetkisiz kritik işlem').slice(0, 512), deleteMessageSeconds: 0 });
    return { ok: true, detail: 'Sunucudan banlandı.' };
  } catch (err) {
    if (err?.code === 50013) return { ok: false, detail: 'Ban atılamadı (yetki/hiyerarşi: BanMembers veya rol sıralaması).' };
    if (err?.code === 30035) return { ok: false, detail: 'Ban limiti aşıldı (rate limit).' };
    if (err?.code === 404 || err?.code === 10013 || err?.code === 10007) return { ok: false, detail: 'Kullanıcı bulunamadı.' };
    return { ok: false, detail: `Ban başarısız: ${err.code || err.message}` };
  }
}

module.exports = { punishExecutor, beginPunish, endPunish, _punishing: punishing };
