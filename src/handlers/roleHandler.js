/**
 * Rol verme/alma yetki motoru (saf karar fonksiyonu — tamamen test edilebilir).
 * Kurallar:
 * - Kendine rol verilemez / alınamaz (guild sahibi dahil).
 * - Kendi en yüksek rolünden ÜST veya EŞİT rol verilemez/alınamaz.
 * - Kendinden üst/eşit konumdaki kullanıcı yönetilemez.
 * - @everyone ve otomatik yönetilen roller (bot/booster) işlem dışı.
 * - Botun Kanalları... değil, Rolleri Yönet yetkisi + hiyerarşisi şart.
 * - Guild sahibi tüm kontrollerden muaftır (Discord'un kendi kuralı).
 */
const { PermissionFlagsBits } = require('discord.js');

const topPos = (member) => member?.roles?.highest?.position ?? 0;
const hasRole = (member, roleId) => !!member?.roles?.cache?.has(roleId);

/**
 * @param {'add'|'remove'} action
 * @returns {{ ok: true } | { ok: false, reason: string }}
 * reason: self|everyone|managed|role-above|target-above|bot-perm|bot-hierarchy|already|missing
 */
function checkRoleAction({ executor, target, role, me, guildId, guildOwnerId, action }) {
  if (!target) return { ok: false, reason: 'no-member' };
  if (!role) return { ok: false, reason: 'no-role' };
  if (executor.id === guildOwnerId) return { ok: true }; // sahip muaftır
  if (target.id === executor.id) return { ok: false, reason: 'self' };
  if (role.id === guildId) return { ok: false, reason: 'everyone' };
  if (role.managed) return { ok: false, reason: 'managed' };

  const execTop = topPos(executor);
  if (role.position >= execTop) return { ok: false, reason: 'role-above' };
  if (topPos(target) >= execTop) return { ok: false, reason: 'target-above' };

  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) return { ok: false, reason: 'bot-perm' };
  if (role.position >= topPos(me)) return { ok: false, reason: 'bot-hierarchy' };

  if (action === 'add' && hasRole(target, role.id)) return { ok: false, reason: 'already' };
  if (action === 'remove' && !hasRole(target, role.id)) return { ok: false, reason: 'missing' };
  return { ok: true };
}

const REASON_TEXT = {
  'no-member': 'Kullanıcı sunucuda bulunamadı.',
  'no-role': 'Rol bulunamadı.',
  self: 'Kendine rol veremezsin / alamazsın.',
  everyone: '@everyone rolü bu komutla yönetilemez.',
  managed: 'Bu rol otomatik yönetiliyor (bot/booster rolleri verilemez).',
  'role-above': 'Kendi rolünden üst veya eşit bir rolü yönetemezsin.',
  'target-above': 'Bu kullanıcı senden üst veya eşit konumda.',
  'bot-perm': 'Botun **Rolleri Yönet** yetkisi yok.',
  'bot-hierarchy': 'Botun rolü yetersiz — bot rolünü bu rolün üstüne taşı.',
  already: 'Kullanıcıda zaten bu rol var.',
  missing: 'Kullanıcıda bu rol zaten yok.',
};

function reasonText(reason) {
  return REASON_TEXT[reason] || 'Rol işlemi yapılamadı.';
}

module.exports = { checkRoleAction, reasonText };
