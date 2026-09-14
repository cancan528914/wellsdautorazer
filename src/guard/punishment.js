/**
 * Ceza sistemi: executor'ı güvenli şekilde banlar. Asla crash etmez.
 * Hız için: önce keşif çağrısı YOK — doğrudan ban denenir, hata koduna göre raporlanır.
 * (Zaten banlı kullanıcıya ban idempotent'tir; hiyerarşi sorunu 50013 olarak döner.)
 */
const { AuditLogEvent } = require('discord.js');
const { markBotAction } = require('./tracker');

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

module.exports = { punishExecutor };
