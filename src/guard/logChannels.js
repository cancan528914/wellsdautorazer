/**
 * Log kanal yöneticisi — idempotent kanal altyapısı.
 *
 * Sorumlulukları:
 *  - GUARD LOGS kategorisini ve altındaki 12 log kanalını bulur/oluşturur
 *  - Her kanalın izinlerini doğru şekilde uygular (@everyone deny, bot + yetkili allow)
 *  - Kanal silinmişse bir sonraki çağrıda yeniden oluşturur
 *  - Discord'daki kanalları DB'deki kayıtlarla eşleştirir (duplicate oluşmaz)
 *
 * Güvenlik:
 *  - Tüm fonksiyonlar hata yutar; çağıran (guardLogSetup) yakalar
 *  - Bot yapmış olduğu kanal oluşturmaları tracker'a işaretlenir → Guard kendini saldırı sanmaz
 *  - Kanallara @everyone ViewChannel DENY verilir
 */
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const { LOG_CHANNELS, LOG_CHANNEL_MAP, LOG_CATEGORY, isValidChannelName } = require('./constants');
const { markBotAction } = require('./tracker');
const db = require('../database/database');

const { AuditLogEvent } = require('discord.js');

/** Bot rolü + @everyone için gereken izinler. */
function baseOverwrites(guild, meId) {
  return [
    // Normal üyeler: göremez, yazamaz.
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    {
      id: meId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
}

/**
 * Kategoriyi bul veya oluştur (idempotent).
 * @returns {Promise<{ channel: object|null, created: boolean }>}
 */
async function ensureCategory(guild) {
  const me = guild.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return { channel: null, created: false, error: 'bot-permission' };
  }

  // 1) DB'de kayıtlı kategori var mı ve hâlâ geçerli mi?
  const existing = getExistingByName(guild, LOG_CATEGORY.name, ChannelType.GuildCategory);
  if (existing) {
    await applyOverwritesSafe(existing, guild, me.id);
    return { channel: existing, created: false };
  }

  // 2) Yoksa oluştur.
  try {
    markBotAction(guild.id, AuditLogEvent.ChannelCreate, LOG_CATEGORY.name, 'guard-log-category');
    const created = await guild.channels.create({
      name: LOG_CATEGORY.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: baseOverwrites(guild, me.id),
      reason: 'Javrex Guard: log kategorisi',
    });
    logger.success(`Guard log kategorisi oluşturuldu: ${LOG_CATEGORY.name}`);
    return { channel: created, created: true };
  } catch (err) {
    logger.error('Guard log kategorisi oluşturulamadı.', err);
    return { channel: null, created: false, error: err.code || err.message };
  }
}

/**
 * İsimle mevcut kanalı bul (cache + fetch).
 * @returns {Promise<object|null>}
 */
function getExistingByName(guild, name, type) {
  if (!isValidChannelName(name)) return null;
  // Önce cache (hızlı, API çağrısı yok).
  const cached = guild.channels.cache?.find((c) => c.name === name && c.type === type);
  if (cached) return cached;
  // Cache'te yoksa isim bazlı arama yapma (API çağrısı pahalı, gereksiz).
  return null;
}

/** Kanal izinlerini güvenle uygular (hata yutmaz). */
async function applyOverwritesSafe(channel, guild, meId) {
  try {
    await channel.permissionOverwrites.set(baseOverwrites(guild, meId), 'Javrex Guard: log kanalı izinleri');
    return true;
  } catch (err) {
    logger.warn(`Guard log kanalı izinleri uygulanamadı (#${channel.name}): ${err.code || err.message}`);
    return false;
  }
}

/**
 * Tek bir log kanalını bul veya oluştur (idempotent).
 * @param {object} guild
 * @param {object} meta - LOG_CHANNELS içindeki bir kayıt
 * @param {object|null} category - üst kategori (yoksa oluşturulmaz, kanal kök seviyede kalır)
 * @returns {Promise<{ channel: object|null, created: boolean, error: string|null }>}
 */
async function ensureLogChannel(guild, meta, category) {
  const me = guild.members?.me;

  // 1) DB kaydı geçerli mi? (varsa fetch ile doğrula, silinmişse yeniden oluştur)
  const recordedId = db.getGuardLogChannel(guild.id, meta.key);
  if (recordedId) {
    const found = await guild.channels.fetch(recordedId).catch(() => null);
    if (found?.isTextBased?.() && found.type === ChannelType.GuildText) {
      // İzinleri de tazele (drift düzeltme).
      await applyOverwritesSafe(found, guild, me.id);
      return { channel: found, created: false, error: null };
    }
    // Kayıt var ama kanal yok/silinmiş → kaydı temizle, yeniden oluştur.
    db.deleteGuardLogChannel(guild.id, meta.key);
    logger.warn(`Guard log kanalı silinmiş, yeniden oluşturuluyor: ${meta.name}`);
  }

  // 2) İsimle mevcut kanal var mı? (DB kaydı yoksa duplicate oluşmaz — devral)
  const byName = getExistingByName(guild, meta.name, ChannelType.GuildText);
  if (byName) {
    await applyOverwritesSafe(byName, guild, me.id);
    db.setGuardLogChannel(guild.id, meta.key, byName.id, category?.id || null);
    return { channel: byName, created: false, error: null };
  }

  // 3) Yoksa oluştur.
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return { channel: null, created: false, error: 'bot-permission' };
  }
  try {
    markBotAction(guild.id, AuditLogEvent.ChannelCreate, meta.name, `guard-log-${meta.key}`);
    const created = await guild.channels.create({
      name: meta.name,
      type: ChannelType.GuildText,
      ...(category?.id ? { parent: category.id } : {}),
      topic: `Javrex Guard • ${meta.label}`,
      permissionOverwrites: baseOverwrites(guild, me.id),
      reason: `Javrex Guard: ${meta.label} kanalı`,
    });
    db.setGuardLogChannel(guild.id, meta.key, created.id, category?.id || null);
    logger.success(`Guard log kanalı oluşturuldu: ${meta.name}`);
    return { channel: created, created: true, error: null };
  } catch (err) {
    logger.error(`Guard log kanalı oluşturulamadı: ${meta.name}`, err);
    return { channel: null, created: false, error: err.code || err.message };
  }
}

/**
 * Tüm log altyapısını idempotent olarak kurar.
 * 2. ve 3. çalıştırmada hiçbir yeni kanal OLUŞTURMAZ (yalnızca eksik olanı tamamlar).
 *
 * @param {object} guild
 * @returns {Promise<{ ok: boolean, created: string[], existing: string[], failed: Array<{key,name,error}> }>}
 */
async function ensureAllLogChannels(guild) {
  const result = { ok: false, created: [], existing: [], failed: [] };

  const cat = await ensureCategory(guild);
  const category = cat.channel || null;
  if (!category && cat.error === 'bot-permission') {
    return { ...result, error: 'bot-permission' };
  }

  for (const meta of LOG_CHANNELS) {
    try {
      const r = await ensureLogChannel(guild, meta, category);
      if (r.channel) {
        (r.created ? result.created : result.existing).push(meta.name);
      } else {
        result.failed.push({ key: meta.key, name: meta.name, error: r.error || 'bilinmiyor' });
      }
    } catch (err) {
      // Tek kanal hatası diğerlerini engellemez.
      logger.error(`Guard log kanalı hatasi: ${meta.name}`, err);
      result.failed.push({ key: meta.key, name: meta.name, error: err.code || err.message });
    }
  }

  result.ok = result.failed.length === 0;
  return result;
}

/**
 * Bir log tipinin kanalını çözer: DB -> (kayıt/kanal yoksa) oluştur.
 * Log gönderiminden ÖNCE çağrılır; kanal yoksa kendi kendine onarır.
 * @returns {Promise<object|null>} Discord kanalı veya null
 */
async function resolveLogChannel(guild, logType) {
  const meta = LOG_CHANNEL_MAP.get(logType);
  if (!meta) return null;
  try {
    // 1) DB kaydı geçerli mi?
    const recordedId = db.getGuardLogChannel(guild.id, logType);
    if (recordedId) {
      const found = await guild.channels.fetch(recordedId).catch(() => null);
      if (found?.isTextBased?.()) return found;
      db.deleteGuardLogChannel(guild.id, logType);
    }
    // 2) İsimle bul (DB kaydı kaybolmuşsa duplicate oluşturmadan devral)
    const byName = getExistingByName(guild, meta.name, ChannelType.GuildText);
    if (byName) {
      db.setGuardLogChannel(guild.id, logType, byName.id, null);
      return byName;
    }
    // 3) Hiçbiri yoksa oluştur (ilk kurulumda olur).
    const cat = await ensureCategory(guild);
    const r = await ensureLogChannel(guild, meta, cat.channel || null);
    return r.channel;
  } catch (err) {
    logger.error(`Log kanalı çözülemedi: ${logType}`, err);
    return null;
  }
}

module.exports = {
  ensureCategory,
  ensureLogChannel,
  ensureAllLogChannels,
  resolveLogChannel,
  getExistingByName,
  baseOverwrites,
};