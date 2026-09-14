/**
 * Guard sabitleri: seviyeler, kategoriler, aksiyonlar, audit type'ları, limitler.
 * Magic number/string yasaktır — tüm eşleşmeler buradan yapılır.
 */
const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');

const GUARD_LEVEL = { NONE: 0, ROLE: 1, CHANNEL: 2, BAN_KICK: 3, URL: 4 };

const LEVEL_META = {
  1: { key: 'ROLE', label: 'Rol Guard', emoji: '🎭' },
  2: { key: 'CHANNEL', label: 'Kanal Guard', emoji: '📁' },
  3: { key: 'BAN_KICK', label: 'Ban & Kick Guard', emoji: '🔨' },
  4: { key: 'URL', label: 'URL Guard', emoji: '👑' },
};

const GUARD_CATEGORY = { ROLE: 'ROLE', CHANNEL: 'CHANNEL', MEMBER: 'MEMBER', WEBHOOK: 'WEBHOOK', GUILD: 'GUILD' };

const CATEGORY_LABEL = {
  ROLE: 'Rol Guard',
  CHANNEL: 'Kanal Guard',
  MEMBER: 'Ban & Kick Guard',
  WEBHOOK: 'Webhook Guard',
  GUILD: 'Sunucu Guard',
};

// Aksiyon -> { audit, category, label }
const GUARD_ACTION = {
  ROLE_CREATE: { audit: AuditLogEvent.RoleCreate, category: 'ROLE', label: 'Rol Oluşturma' },
  ROLE_DELETE: { audit: AuditLogEvent.RoleDelete, category: 'ROLE', label: 'Rol Silme' },
  ROLE_UPDATE: { audit: AuditLogEvent.RoleUpdate, category: 'ROLE', label: 'Rol Düzenleme' },
  MEMBER_ROLE_UPDATE: { audit: AuditLogEvent.MemberRoleUpdate, category: 'ROLE', label: 'Üyeye Rol Verme/Alma' },
  CHANNEL_CREATE: { audit: AuditLogEvent.ChannelCreate, category: 'CHANNEL', label: 'Kanal Oluşturma' },
  CHANNEL_DELETE: { audit: AuditLogEvent.ChannelDelete, category: 'CHANNEL', label: 'Kanal Silme' },
  CHANNEL_UPDATE: { audit: AuditLogEvent.ChannelUpdate, category: 'CHANNEL', label: 'Kanal Düzenleme' },
  CHANNEL_OVERWRITE_CREATE: { audit: AuditLogEvent.ChannelOverwriteCreate, category: 'CHANNEL', label: 'Kanal İzni Oluşturma' },
  CHANNEL_OVERWRITE_UPDATE: { audit: AuditLogEvent.ChannelOverwriteUpdate, category: 'CHANNEL', label: 'Kanal İzni Düzenleme' },
  CHANNEL_OVERWRITE_DELETE: { audit: AuditLogEvent.ChannelOverwriteDelete, category: 'CHANNEL', label: 'Kanal İzni Silme' },
  MEMBER_BAN_ADD: { audit: AuditLogEvent.MemberBanAdd, category: 'MEMBER', label: 'Üye Banlama' },
  MEMBER_BAN_REMOVE: { audit: AuditLogEvent.MemberBanRemove, category: 'MEMBER', label: 'Ban Kaldırma' },
  MEMBER_KICK: { audit: AuditLogEvent.MemberKick, category: 'MEMBER', label: 'Üye Kickleme' },
  WEBHOOK_CREATE: { audit: AuditLogEvent.WebhookCreate, category: 'WEBHOOK', label: 'Webhook Oluşturma' },
  WEBHOOK_UPDATE: { audit: AuditLogEvent.WebhookUpdate, category: 'WEBHOOK', label: 'Webhook Düzenleme' },
  WEBHOOK_DELETE: { audit: AuditLogEvent.WebhookDelete, category: 'WEBHOOK', label: 'Webhook Silme' },
  GUILD_UPDATE: { audit: AuditLogEvent.GuildUpdate, category: 'GUILD', label: 'Sunucu Ayarı Değişikliği' },
};

const AUDIT_RETRY_ATTEMPTS = 3;
const AUDIT_RETRY_DELAY_MS = 700;
const AUDIT_MATCH_WINDOW_MS = 20000;
// Aynı tipte peş peşe olaylarda API'ye tekrar gitmemek için kısa ömürlü audit cache'i.
// Hedef+zaman eşleşmesi aynen uygulanır (yanlış executor riski yok).
const AUDIT_CACHE_TTL_MS = 5000;
// Log kanalı obje cache'i (her ihlalde 1 GET kazanır).
const LOGCHANNEL_CACHE_TTL_MS = 60000;
const TRACK_TTL_MS = 25000;
const WEBHOOK_RECENT_MS = 90000;

// /guardsetup + startup permission raporu
const REQUIRED_PERMS = [
  { flag: PermissionFlagsBits.ViewAuditLog, label: 'Denetim Kaydını Görüntüle (Audit Log)' },
  { flag: PermissionFlagsBits.BanMembers, label: 'Üyeleri Yasakla (Ban)' },
  { flag: PermissionFlagsBits.KickMembers, label: 'Üyeleri At (Kick)' },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Rolleri Yönet' },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Kanalları Yönet' },
  { flag: PermissionFlagsBits.ManageGuild, label: 'Sunucuyu Yönet' },
  { flag: PermissionFlagsBits.ManageWebhooks, label: 'Webhookları Yönet' },
];

module.exports = {
  GUARD_LEVEL,
  LEVEL_META,
  GUARD_CATEGORY,
  CATEGORY_LABEL,
  GUARD_ACTION,
  AUDIT_RETRY_ATTEMPTS,
  AUDIT_RETRY_DELAY_MS,
  AUDIT_MATCH_WINDOW_MS,
  AUDIT_CACHE_TTL_MS,
  LOGCHANNEL_CACHE_TTL_MS,
  TRACK_TTL_MS,
  WEBHOOK_RECENT_MS,
  REQUIRED_PERMS,
};
