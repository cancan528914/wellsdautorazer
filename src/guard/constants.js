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
  MEMBER_TIMEOUT: { audit: AuditLogEvent.MemberUpdate, category: 'MEMBER', label: 'Üye Susturma (Timeout)' },
  WEBHOOK_CREATE: { audit: AuditLogEvent.WebhookCreate, category: 'WEBHOOK', label: 'Webhook Oluşturma' },
  WEBHOOK_UPDATE: { audit: AuditLogEvent.WebhookUpdate, category: 'WEBHOOK', label: 'Webhook Düzenleme' },
  WEBHOOK_DELETE: { audit: AuditLogEvent.WebhookDelete, category: 'WEBHOOK', label: 'Webhook Silme' },
  EMOJI_CREATE: { audit: AuditLogEvent.EmojiCreate, category: 'GUILD', label: 'Emoji Oluşturma' },
  EMOJI_UPDATE: { audit: AuditLogEvent.EmojiUpdate, category: 'GUILD', label: 'Emoji Düzenleme' },
  EMOJI_DELETE: { audit: AuditLogEvent.EmojiDelete, category: 'GUILD', label: 'Emoji Silme' },
  STICKER_CREATE: { audit: AuditLogEvent.StickerCreate, category: 'GUILD', label: 'Sticker Oluşturma' },
  STICKER_UPDATE: { audit: AuditLogEvent.StickerUpdate, category: 'GUILD', label: 'Sticker Düzenleme' },
  STICKER_DELETE: { audit: AuditLogEvent.StickerDelete, category: 'GUILD', label: 'Sticker Silme' },
  THREAD_CREATE: { audit: AuditLogEvent.ThreadCreate, category: 'GUILD', label: 'Konu (Thread) Oluşturma' },
  THREAD_DELETE: { audit: AuditLogEvent.ThreadDelete, category: 'GUILD', label: 'Konu (Thread) Silme' },
  GUILD_UPDATE: { audit: AuditLogEvent.GuildUpdate, category: 'GUILD', label: 'Sunucu Ayarı Değişikliği' },
};

// Seviye -> izinli aksiyon setleri (açık registry; numeric karşılaştırma yok)
const ROLE_ACTIONS = new Set(['ROLE_CREATE', 'ROLE_DELETE', 'ROLE_UPDATE', 'MEMBER_ROLE_UPDATE']);
const CHANNEL_ACTIONS = new Set([
  'CHANNEL_CREATE',
  'CHANNEL_DELETE',
  'CHANNEL_UPDATE',
  'CHANNEL_OVERWRITE_CREATE',
  'CHANNEL_OVERWRITE_UPDATE',
  'CHANNEL_OVERWRITE_DELETE',
]);
const BANKICK_ACTIONS = new Set(['MEMBER_BAN_ADD', 'MEMBER_BAN_REMOVE', 'MEMBER_KICK', 'MEMBER_TIMEOUT']);
// FULL_TRUST: GUARD_ACTION içindeki TÜM aksiyonlar (yeni eklenen dahil otomatik)
const FULL_TRUST_ACTIONS = new Set(Object.keys(GUARD_ACTION));

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
// Aynı saldırının tekrar cezalandırılmaması için dedupe penceresi
const DEDUPE_TTL_MS = 30000;
// Incident log toplama penceresi: aynı saldırganın bu süre içindeki tüm
// aksiyonları TEK incident logunda birleşir (sabit pencere, kaymaz).
const INCIDENT_LOG_WINDOW_MS = 5000;
// Aynı audit kaydının tekrar işlenmemesi için entry-ID önbellek süresi
const DEDUPE_ENTRY_TTL_MS = 60000;
// actor+action+target(+zaman) ikinci katman dedup penceresi
const COMBO_TTL_MS = 60000;
// Devam eden ban varken ikinci ban denemesini engelleyen kilit süresi
const PUNISH_TTL_MS = 60000;

// /guardsetup + startup permission raporu
const REQUIRED_PERMS = [
  { flag: PermissionFlagsBits.ViewAuditLog, label: 'Denetim Kaydını Görüntüle (Audit Log)' },
  { flag: PermissionFlagsBits.BanMembers, label: 'Üyeleri Yasakla (Ban)' },
  { flag: PermissionFlagsBits.KickMembers, label: 'Üyeleri At (Kick)' },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Rolleri Yönet' },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Kanalları Yönet' },
  { flag: PermissionFlagsBits.ManageGuild, label: 'Sunucuyu Yönet' },
  { flag: PermissionFlagsBits.ManageWebhooks, label: 'Webhookları Yönet' },
  { flag: PermissionFlagsBits.ManageEvents, label: 'Etkinlikleri Yönet' },
  { flag: PermissionFlagsBits.ManageThreads, label: 'Konuları Yönet' },
  { flag: PermissionFlagsBits.ViewChannel, label: 'Kanalları Görüntüle' },
  { flag: PermissionFlagsBits.SendMessages, label: 'Mesaj Gönder' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Bağlantı Yerleştir (Embed)' },
];

// ===================== LOG KANALLARI ENVANTERİ =====================
// Yeni log mimarisinin TEK doğruluk kaynağı. /guardlogsetup bu listeyi okur,
// DB'deki kayıtlarla eşleştirir, eksikleri oluşturur.
// - key: kanal tipi (config/env anahtarı suffix'i ve DB log_type değeri)
// - name: Discord kanal adı (kural: düşük harf, ASCII, tire)
// - critical: true ise olay ASLA spam-gruplamaya girmez, tek tek kaydedilir
const LOG_CHANNELS = [
  { key: 'role', name: 'rol-log', label: 'Rol İşlemleri', emoji: '🎭', color: 0x9b59b6, critical: true },
  { key: 'ban_kick', name: 'ban-kick-log', label: 'Ban / Kick', emoji: '🔨', color: 0xe74c3c, critical: true },
  { key: 'channel', name: 'kanal-log', label: 'Kanal İşlemleri', emoji: '📁', color: 0x3498db, critical: true },
  { key: 'message', name: 'mesaj-log', label: 'Mesaj İşlemleri', emoji: '💬', color: 0x95a5a6, critical: false },
  { key: 'member', name: 'uye-log', label: 'Üye İşlemleri', emoji: '👤', color: 0x1abc9c, critical: false },
  { key: 'bot', name: 'bot-log', label: 'Bot İşlemleri', emoji: '🤖', color: 0xe67e22, critical: true },
  { key: 'guild', name: 'sunucu-log', label: 'Sunucu Ayarları', emoji: '🏛️', color: 0xf1c40f, critical: false },
  { key: 'webhook', name: 'webhook-log', label: 'Webhook İşlemleri', emoji: '🪝', color: 0x8e44ad, critical: true },
  { key: 'emoji_sticker', name: 'emoji-sticker-log', label: 'Emoji / Sticker', emoji: '😀', color: 0x16a085, critical: false },
  { key: 'voice', name: 'ses-log', label: 'Ses Hareketleri', emoji: '🔊', color: 0x16a085, critical: false },
  { key: 'invite', name: 'davet-log', label: 'Davet İşlemleri', emoji: '📨', color: 0xd35400, critical: true },
  { key: 'guard', name: 'guard-log', label: 'Guard Sistem Hareketleri', emoji: '🛡️', color: 0xe74c3c, critical: true },
];

// Log kategorisi (tüm kanalların altında toplandığı üst kanal)
const LOG_CATEGORY = { name: 'guard-logs', label: 'GUARD LOGS' };

// key -> meta (hızlı erişim)
const LOG_CHANNEL_MAP = new Map(LOG_CHANNELS.map((c) => [c.key, c]));

// GRUP-SAFE kanallar (critical:false olanlar) — bunlar spam pencereyle toplanır.
const GROUPABLE_LOG_KEYS = LOG_CHANNELS.filter((c) => !c.critical).map((c) => c.key);
// GRUP-SAFE olmayanlar: her olay anında tek embed gider, asla kaybolmaz.
const IMMEDIATE_LOG_KEYS = LOG_CHANNELS.filter((c) => c.critical).map((c) => c.key);

/**
 * Bir log tipinin adı geçerli mi? (env/config anahtarı üretimi için güvenlik)
 * @param {string} key
 */
function isValidLogKey(key) {
  return LOG_CHANNEL_MAP.has(String(key || '').trim());
}

// Kanal adı Discord kurallarına uygun mu? (küçük harf, ASCII, tire, 1-100)
function isValidChannelName(name) {
  return typeof name === 'string' && /^[\p{Ll}\p{N}_-]{1,100}$/u.test(name);
}

module.exports = {
  GUARD_LEVEL,
  LEVEL_META,
  GUARD_CATEGORY,
  CATEGORY_LABEL,
  GUARD_ACTION,
  ROLE_ACTIONS,
  CHANNEL_ACTIONS,
  BANKICK_ACTIONS,
  FULL_TRUST_ACTIONS,
  DEDUPE_TTL_MS,
  INCIDENT_LOG_WINDOW_MS,
  DEDUPE_ENTRY_TTL_MS,
  COMBO_TTL_MS,
  PUNISH_TTL_MS,
  AUDIT_RETRY_ATTEMPTS,
  AUDIT_RETRY_DELAY_MS,
  AUDIT_MATCH_WINDOW_MS,
  AUDIT_CACHE_TTL_MS,
  LOGCHANNEL_CACHE_TTL_MS,
  TRACK_TTL_MS,
  WEBHOOK_RECENT_MS,
  REQUIRED_PERMS,
  // Yeni log mimarisi
  LOG_CHANNELS,
  LOG_CHANNEL_MAP,
  LOG_CATEGORY,
  GROUPABLE_LOG_KEYS,
  IMMEDIATE_LOG_KEYS,
  isValidLogKey,
  isValidChannelName,
  // Log kanal env anahtarı: GUARD_LOG_ROLE_CHANNEL_ID gibi
  logEnvKey: (key) => `GUARD_LOG_${String(key).toUpperCase()}_CHANNEL_ID`,
};
