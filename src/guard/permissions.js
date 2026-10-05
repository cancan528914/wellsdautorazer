/**
 * Guard izin sistemi: seviye bazlı AÇIK izinler (numeric karşılaştırma YOK).
 * Her seviye yalnızca kendi alanından muaftır; URL Guard her şeyden muaftır.
 * Yönetim komutları (/guardekle vb.) SADECE şunlara açıktır:
 *   - config.GUARD_MANAGER_ROLE_ID rolüne sahip olanlar
 *   - config.GUARD_MANAGER_USER_IDS istisna listesindeki kişiler (rol verilemeyenler için)
 * Administrator / ManageGuild / ADMIN_ROLE_ID / eski guard rolleri tek başına erişim
 * VERMEZ; whitelist seviyesi (1-4) komut erişimi VERMEZ (koruma ≠ yönetim).
 * Botun API permissionları etkilenmez.
 *
 * NOT: Değiştirmek için src/config.js → GUARD_MANAGER_ROLE_ID ve
 * GUARD_MANAGER_USER_IDS_DEFAULT. Rol değeri config.guardManagerRoleIds ve
 * guard/events.js → isSensitiveTarget (botun kritik rol koruması) tarafından da kullanılır.
 */
const config = require('../config');
const { getGuardLevel } = require('../database/database');
const { GUARD_ACTION, ROLE_ACTIONS, CHANNEL_ACTIONS, BANKICK_ACTIONS, FULL_TRUST_ACTIONS } = require('./constants');

function levelOf(guildId, userId) {
  try {
    return getGuardLevel(guildId, userId);
  } catch {
    return 0;
  }
}

function isAllowed(level, category) {
  if (level === 4) return true; // URL Guard = FULL TRUST
  if (level === 1) return category === 'ROLE';
  if (level === 2) return category === 'CHANNEL';
  if (level === 3) return category === 'MEMBER';
  return false;
}

/** Seviyenin BU aksiyona açık izni var mı? (registry authoritative kaynaktır) */
function levelActions(level) {
  if (level === 4) return FULL_TRUST_ACTIONS;
  if (level === 1) return ROLE_ACTIONS;
  if (level === 2) return CHANNEL_ACTIONS;
  if (level === 3) return BANKICK_ACTIONS;
  return new Set();
}

function isActionAllowed(level, action) {
  try {
    return levelActions(level).has(action);
  } catch {
    return false;
  }
}

/**
 * Kullanıcı guard yönetimi istisna listesinde mi?
 * GuildMember.id === user.id; APIInteractionGuildMember'da user.id kullanılır.
 * @returns {boolean}
 */
function isGuardManagerUser(member) {
  if (!member) return false;
  const ids = config.GUARD_MANAGER_USER_IDS;
  if (!Array.isArray(ids) || !ids.length) return false;
  try {
    const userId = String(member.user?.id || member.id || '');
    if (!userId) return false;
    return ids.some((id) => String(id) === userId);
  } catch {
    return false;
  }
}

/**
 * Guard yönetim komutlarını kullanabilir mi?
 * KURAL: guard-yönetici ROLÜ veya config.GUARD_MANAGER_USER_IDS istisna listesindeki kişi.
 * Administrator / ManageGuild / ADMIN_ROLE_ID / eski guard rolleri tek başına VERMEZ.
 * Whitelist seviyesi (1-4) komut erişimi vermez (koruma ≠ yönetim).
 */
function canManageGuard(member) {
  if (!member) return false;
  // Rol kontrolü (ana kural)
  try {
    const cache = member.roles?.cache;
    if (cache && typeof cache.has === 'function' && cache.has(config.GUARD_MANAGER_ROLE_ID)) {
      return true;
    }
  } catch {
    /* rol kontrolü hatası aşağıdaki kullanıcı kontrolüne düşer */
  }
  // İstisna kullanıcı listesi
  return isGuardManagerUser(member);
}

/**
 * Ban/kick uygulayan kişinin guard korumasını anlatan uyarı metni.
 * Koruması yoksa dolu döner (komut sonucuna eklenir) — yetkili yanlışlıkla
 * guard'a yakalanmasın diye.
 */
function guardCoverNote(guildId, userId) {
  try {
    if (isAllowed(levelOf(guildId, userId), 'MEMBER')) return '';
    return '\n⚠️ Guard koruman yok (Ban & Kick / URL seviyesi gerekli) — bu işlemden sonra Guard seni banlayabilir. Bir yöneticiden whitelist eklemesini iste.';
  } catch {
    return '';
  }
}

module.exports = { levelOf, isAllowed, levelActions, isActionAllowed, canManageGuard, isGuardManagerUser, guardCoverNote };
