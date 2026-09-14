/**
 * Yetki sistemi. Tüm ID'ler config/.env üzerinden gelir, hard-code yoktur.
 */
const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');

/**
 * Üye admin sayılır mı?
 * - Administrator flag'i varsa -> evet
 * - ADMIN_ROLE_ID rolüne sahipse -> evet
 * - ManageGuild varsa -> evet (ADMIN_ROLE_ID boşken pratik fallback)
 */
function isAdmin(member) {
  if (!member) return false;
  try {
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    if (config.adminRoleId && member.roles?.cache?.has(config.adminRoleId)) return true;
    return false;
  } catch {
    return false;
  }
}

/** /dmmesaj kullanabilir mi? (sadece yetkililer) */
function canUseDm(member) {
  return isAdmin(member);
}

/** Üye, verilen rol ID'lerinden en az birine sahip mi? */
function hasAnyRole(member, ids) {
  try {
    if (!ids || !ids.length) return false;
    const cache = member?.roles?.cache;
    if (!cache) return false;
    return ids.some((id) => cache.has(id));
  } catch {
    return false;
  }
}

/** /clear kullanabilir mi? ManageMessages VEYA admin */
function canUseClear(member) {
  if (!member) return false;
  try {
    if (isAdmin(member)) return true;
    if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Opsiyonel: /ingame kilidi (INGAME_ROLE_ID boşsa herkes) */
function canUseIngame(member) {
  if (!config.permissions.ingameRoleId) return true;
  if (!member) return false;
  try {
    if (isAdmin(member)) return true;
    return !!member.roles?.cache?.has(config.permissions.ingameRoleId);
  } catch {
    return false;
  }
}

/** Opsiyonel: /aktiflik kilidi (AKTIFLIK_ROLE_ID boşsa herkes) */
function canUseAktiflik(member) {
  if (!config.permissions.aktiflikRoleId) return true;
  if (!member) return false;
  try {
    if (isAdmin(member)) return true;
    return !!member.roles?.cache?.has(config.permissions.aktiflikRoleId);
  } catch {
    return false;
  }
}

/** Ekip komutları (ticket/mazeret/ses/setup/komutlarpng): admin VEYA staff rollerinden biri */
function canManageTickets(member) {
  if (!member) return false;
  try {
    if (isAdmin(member)) return true;
    if (hasAnyRole(member, config.staffRoleIds)) return true;
    // geriye uyumluluk: tekil TICKET_STAFF_ROLE_ID
    if (config.ticket?.staffRoleId && member.roles?.cache?.has(config.ticket.staffRoleId)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Rol komutları (/rolver, /rolal): admin VEYA rol-yönetici rollerinden biri */
function canManageRoles(member) {
  if (!member) return false;
  try {
    if (isAdmin(member)) return true;
    return hasAnyRole(member, config.roleManagerRoleIds);
  } catch {
    return false;
  }
}

/** Ban komutları (/ban, /unban): admin VEYA ban-yetkili rollerinden biri */
function canManageBan(member) {
  if (!member) return false;
  try {
    if (isAdmin(member)) return true;
    return hasAnyRole(member, config.banManagerRoleIds);
  } catch {
    return false;
  }
}

/**
 * Global komut erişimi: BOT_ALLOWED_ROLE_IDS doluysa SADECE listedeki
 * roller + adminler slash komut kullanabilir. Liste boşsa kısıtlama yok.
 */
function hasCommandAccess(member) {
  try {
    const allowed = config.globalAllowedRoleIds || [];
    if (!allowed.length) return true;
    if (!member) return false;
    if (isAdmin(member)) return true;
    return hasAnyRole(member, allowed);
  } catch {
    return false;
  }
}

module.exports = { isAdmin, canUseDm, canUseClear, canUseIngame, canUseAktiflik, canManageTickets, canManageRoles, canManageBan, hasAnyRole, hasCommandAccess };
