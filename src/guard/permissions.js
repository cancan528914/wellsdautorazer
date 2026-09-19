/**
 * Guard izin sistemi: seviye bazlı AÇIK izinler (numeric karşılaştırma YOK).
 * Her seviye yalnızca kendi alanından muaftır; URL Guard her şeyden muaftır.
 * Yönetim komutları (/guardekle vb.) SADECE 1533434495750111403 rolune açıktır
 * (config.GUARD_MANAGER_ROLE_ID). Administrator / ManageGuild / ADMIN_ROLE_ID /
 * eski guard rolleri tek başına erişim VERMEZ; whitelist seviyesi (1-4) komut
 * erişimi VERMEZ (koruma ≠ yönetim). Botun API permissionları etkilenmez.
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

/** Guard yönetim komutlarını kullanabilir mi? TEK KURAL: guard-yönetici rolü. */
function canManageGuard(member) {
  if (!member) return false;
  try {
    const cache = member.roles?.cache;
    if (!cache || typeof cache.has !== 'function') return false;
    return cache.has(config.GUARD_MANAGER_ROLE_ID);
  } catch {
    return false;
  }
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

module.exports = { levelOf, isAllowed, levelActions, isActionAllowed, canManageGuard, guardCoverNote };
