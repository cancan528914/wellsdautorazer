/**
 * Log kanal yöneticisi — idempotent kanal altyapısı.
 *
 * ⚠️ İKİ AYRI YOL (sonsuz döngüye karşı en önemli kural):
 *   1) MUTASYON YOLU (cold): ensureAllLogChannels() — /guardlogsetup çağırır.
 *      Kanal oluşturur, izin yazar. Yazmadan ÖNCE internalOps ile işaretlenir.
 *   2) OKUMA YOLU (hot): resolveLogChannel() — her log gönderiminde çağrılır.
 *      SADECE bulur. HİÇBİR ZAMAN oluşturmaz/yazmaz.
 *   Bu ayrım olmazsa: log → izin yaz → channelUpdate → log → izin yaz → ♾️
 *
 * Güvenlik:
 *  - Tüm fonksiyonlar hata yutar
 *  - Botun kendi işlemleri internalOps + tracker ile elenir → kendini saldırı sanmaz
 *  - Kanallara @everyone ViewChannel DENY verilir
 *  - İzinler sadece GERÇEKTEN bozuksa yazılır (drift kontrolü)
 */
const { ChannelType, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const logger = require('../utils/logger');
const { LOG_CHANNELS, LOG_CHANNEL_MAP, LOG_CATEGORY, isValidChannelName } = require('./constants');
const { markBotAction } = require('./tracker');
const { markInternalOp } = require('./internalOps');
const db = require('../database/database');

// Kanal önbelleği: `${guildId}:${logType}` -> { channel, id, exp }
// Log gönderim yolunda REST çağrısını (fetch) ve tekrar DB okumasını azaltır.
const chanCache = new Map();
const CHAN_CACHE_TTL_MS = 60000;   // 60sn — yeterince uzun, yeterince kısa
const MISS_CACHE_TTL_MS = 10000;   // kanal yoksa 10sn tekrar arama (spam koruması)

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
    await ensureOverwrites(existing, guild, me.id);
    return { channel: existing, created: false };
  }

  // 2) Yoksa oluştur.
  try {
    markBotAction(guild.id, AuditLogEvent.ChannelCreate, LOG_CATEGORY.name, 'guard-log-category');
    markInternalOp(guild.id, 'create', LOG_CATEGORY.name);
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
 * Kanalın izinleri ZATEN doğru mu? (drift kontrolü)
 *
 * KRİTİK: Bu kontrol olmadan bot her log gönderiminde izinleri yeniden yazar →
 * permissionOverwrites.set() → channelUpdate eventi → tekrar kontrol → ...
 * SONSUZ DÖNGÜ. Sadece gerçekten bozuksa dokunuruz.
 */
function overwritesNeedFix(channel, guild, meId) {
  try {
    const everyone = guild.roles?.everyone?.id;
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
    const cache = channel.permissionOverwrites?.cache;
    if (!cache || !everyone) return false; // cache yoksa dokunma (belirsizlikte güvenli taraf)

    const everyoneOv = cache.get(String(everyone));
    // @everyone için gerekli DENY'ler uygulanmamışsa düzelt
    if (!everyoneOv) return true;
    for (const flag of need) {
      if (!everyoneOv.deny?.has?.(flag)) return true;
    }

    // Bot için gerekli ALLOW'lar uygulanmamışsa düzelt
    const botOv = cache.get(String(meId));
    if (!botOv) return true;
    for (const flag of [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ]) {
      if (!botOv.allow?.has?.(flag)) return true;
    }
    return false;
  } catch {
    return false; // kontrol edilemiyorsa dokunma
  }
}

/**
 * Sadece gerçekten bozuksa izinleri yazar.
 * @returns {Promise<boolean>} yazıldı mı
 */
async function ensureOverwrites(channel, guild, meId) {
  if (!overwritesNeedFix(channel, guild, meId)) return false; // zaten doğru → dokunma
  // Yazmadan ÖNCE işaretle: oluşacak channelUpdate event'ini eleriz (döngü kırılır)
  markInternalOp(guild.id, 'perm', channel.id);
  return applyOverwritesSafe(channel, guild, meId);
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
      // Sadece gerçekten bozuksa izinleri düzelt (yoksa dokunma → döngü yok).
      await ensureOverwrites(found, guild, me.id);
      return { channel: found, created: false, error: null };
    }
    // Kayıt var ama kanal yok/silinmiş → kaydı temizle, yeniden oluştur.
    db.deleteGuardLogChannel(guild.id, meta.key);
    logger.warn(`Guard log kanalı silinmiş, yeniden oluşturuluyor: ${meta.name}`);
  }

  // 2) İsimle mevcut kanal var mı? (DB kaydı yoksa duplicate oluşmaz — devral)
  const byName = getExistingByName(guild, meta.name, ChannelType.GuildText);
  if (byName) {
    await ensureOverwrites(byName, guild, me.id);
    db.setGuardLogChannel(guild.id, meta.key, byName.id, category?.id || null);
    return { channel: byName, created: false, error: null };
  }

  // 3) Yoksa oluştur.
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return { channel: null, created: false, error: 'bot-permission' };
  }
  try {
    markBotAction(guild.id, AuditLogEvent.ChannelCreate, meta.name, `guard-log-${meta.key}`);
    markInternalOp(guild.id, 'create', meta.name);
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
  // Kurulum sonrası önbelleği düşür: yeni/onarılan kanallar hemen geçerli olsun.
  // (Aksi hâlde hot path eski "yok" sonucunu cache'leyip logları atardı.)
  invalidateLogChannel(guild.id);
  return result;
}

/**
 * Bir log tipinin kanalını çözer — **SALT OKUNUR**.
 *
 * ⚠️ MİMARİ KURAL: Bu fonksiyon HİÇBİR ZAMAN kanal oluşturmaz, izin yazmaz,
 * hiçbir Discord mutation yapmaz. Sadece mevcut kanalı bulur.
 *
 * Neden? Bu fonksiyon LOG GÖNDERİM YOLUNDA (hot path) çağrılır. Eğer burada
 * izin yazılırsa → channelUpdate eventi → tekrar log → tekrar buraya → sonsuz döngü.
 * Kanal oluşturma/onarma işi TEK yerde: ensureAllLogChannels() (/guardlogsetup).
 *
 * @returns {Promise<object|null>} Discord kanalı veya null
 */
async function resolveLogChannel(guild, logType) {
  const meta = LOG_CHANNEL_MAP.get(logType);
  if (!meta || !guild) return null;
  const cacheKey = `${guild.id}:${logType}`;

  try {
    // 1) Önbellek (aynı olayda 12 kanal çözülürken REST çağrısı yapmamak için)
    const hit = chanCache.get(cacheKey);
    if (hit && Date.now() < hit.exp && hit.channel) {
      // Kanal hâlâ cache'te mi?
      if (guild.channels?.cache?.get(hit.id)) return hit.channel;
      chanCache.delete(cacheKey);
    }

    // 2) DB kaydı → cache'den doğrula (REST yok: cache yeterliyse yeter)
    const recordedId = db.getGuardLogChannel(guild.id, logType);
    let found = null;
    if (recordedId) {
      found = guild.channels?.cache?.get(recordedId) || null;
      // Cache'te yoksa tek seferlik fetch (nadir: restart sonrası ilk çağrı)
      if (!found) {
        found = await guild.channels.fetch(recordedId).catch(() => null);
      }
      if (found?.isTextBased?.() && found.type === ChannelType.GuildText) {
        chanCache.set(cacheKey, { channel: found, id: found.id, exp: Date.now() + CHAN_CACHE_TTL_MS });
        return found;
      }
      // Kayıt var ama kanal yok → kaydı temizle (SADECE DB yazımı, Discord'a dokunma)
      db.deleteGuardLogChannel(guild.id, logType);
    }

    // 3) İsimle bul (DB kaydı kaybolmuşsa, duplicate oluşturmadan devral)
    const byName = getExistingByName(guild, meta.name, ChannelType.GuildText);
    if (byName) {
      db.setGuardLogChannel(guild.id, logType, byName.id, null);
      chanCache.set(cacheKey, { channel: byName, id: byName.id, exp: Date.now() + CHAN_CACHE_TTL_MS });
      return byName;
    }

    // 4) Kanal yok. BURADA BİTİYORUZ — oluşturma YOK, izin yazma YOK.
    //    Onarım /guardlogsetup ile yapılır (tek yerden, kullanıcı kontrollü).
    logger.debug(`Log kanalı yok: ${meta.name} (${logType}) — /guardlogsetup çalıştırılmalı.`);
    chanCache.set(cacheKey, { channel: null, id: null, exp: Date.now() + MISS_CACHE_TTL_MS });
    return null;
  } catch (err) {
    logger.error(`Log kanalı çözülemedi: ${logType}`, err);
    return null;
  }
}

/** Kanal önbelleğini temizler (kanal silinince çağrılır). */
function invalidateLogChannel(guildId, logType) {
  try {
    if (logType) chanCache.delete(`${guildId}:${logType}`);
    else for (const k of [...chanCache.keys()]) if (k.startsWith(`${guildId}:`)) chanCache.delete(k);
  } catch {
    /* ignore */
  }
}

module.exports = {
  ensureCategory,
  ensureLogChannel,
  ensureAllLogChannels,
  resolveLogChannel,
  invalidateLogChannel,
  getExistingByName,
  baseOverwrites,
  overwritesNeedFix,
  ensureOverwrites,
};