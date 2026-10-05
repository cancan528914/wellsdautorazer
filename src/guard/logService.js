/**
 * Guard Log Servisi — TEK gönderim kapısı.
 *
 * Yeni mimarinin merkezi. Tüm loglar buradan geçer:
 *   - Audit Log doğrulaması (asla yanlış kişiyi suçlama)
 *   - Doğru kanala yönlendirme (kanal bazlı)
 *   - Spam kontrolü (kritik = anında, diğerleri = gruplanır)
 *   - Hata yönetimi (log hatası Guard'ı ASLA düşürmez)
 *
 * Katmanlar:
 *   logService.js  → bu dosya (gönderim + gruplama + audit)
 *   logChannels.js → kanal altyapısı (oluşturma/izin/çözümleme)
 *   logEmbeds.js   → görsel tasarım
 *   constants.js   → kanal envanteri
 */
const { AuditLogEvent } = require('discord.js');
const logger = require('../utils/logger');
const { findExecutor } = require('./audit');
const { isBotAction } = require('./tracker');
const {
  LOG_CHANNEL_MAP,
  GROUPABLE_LOG_KEYS,
  IMMEDIATE_LOG_KEYS,
  AUDIT_RETRY_ATTEMPTS,
  AUDIT_RETRY_DELAY_MS,
  AUDIT_MATCH_WINDOW_MS,
} = require('./constants');
const { resolveLogChannel } = require('./logChannels');
const { buildLogEmbed, buildGuardActionEmbed, buildGroupEmbed } = require('./logEmbeds');

// ---------- GRUP-SAFE SPAM KONTROLÜ ----------
// Non-critical kanallar için olay toplama penceresi.
const GROUP_WINDOW_MS = 8000;
const MAX_GROUP_ITEMS = 25;
// `${guildId}:${logType}` -> { timer, entries, flushFn }
const pendingGroups = new Map();

/** Pending grup zamanlayıcılarını temizle (memory leak yok). */
function sweepGroups(now = Date.now()) {
  for (const [k, g] of pendingGroups) {
    if (!g || (g.lastAt && now - g.lastAt > GROUP_WINDOW_MS * 4)) {
      if (g.timer) clearTimeout(g.timer);
      pendingGroups.delete(k);
    }
  }
}

/**
 * Bir log tipinin anında mı yoksa gruplanarak mı gönderileceğini belirler.
 * @param {string} logType
 * @returns {'immediate'|'group'}
 */
function deliveryMode(logType) {
  if (IMMEDIATE_LOG_KEYS.includes(logType)) return 'immediate';
  if (GROUPABLE_LOG_KEYS.includes(logType)) return 'group';
  return 'immediate';
}

/** Bir audit tipinin hangi log kanalına gideceğini bilen harita (event katmanı doldurur). */
// Audit doğrulaması gereken aksiyonların audit tipi → kanal eşleşmesi burada yaşar.

/**
 * Audit Log'dan executor'ı doğrular.
 * Bulunamazsa null döner — çağıran "doğrulanamadı" olarak loglar (uydurma yok).
 */
async function verifyActor(guild, auditType, targetId) {
  if (!guild || !auditType || !targetId) return null;
  try {
    const found = await findExecutor(guild, auditType, String(targetId), { attempts: AUDIT_RETRY_ATTEMPTS, delayMs: AUDIT_RETRY_DELAY_MS });
    if (!found?.executor) return null;
    return { executor: found.executor, entry: found.entry };
  } catch (err) {
    logger.warn(`Audit doğrulama hatası (${auditType}): ${err.code || err.message}`);
    return null;
  }
}

/** Executor nesnesini embed formatına çevirir. */
function normalizeActor(executor) {
  if (!executor) return null;
  return {
    id: String(executor.id),
    username: executor.username || executor.tag || '',
    bot: !!executor.bot,
  };
}

/** Botun kendi mi yaptığını anla (self-loop koruması + doğru log etiketi). */
function detectActorKind(guildId, auditType, targetId, clientUserId) {
  try {
    if (isBotAction(guildId, auditType, String(targetId))) return 'bot';
    if (clientUserId && targetId && String(clientUserId) === String(targetId)) return 'bot';
  } catch {
    /* ignore */
  }
  return 'user';
}

/**
 * TEK log gönderim kapısı.
 *
 * @param {object} p
 * @param {object} p.guild
 * @param {string} p.logType       - LOG_CHANNELS key
 * @param {string} [p.title]
 * @param {object} [p.actor]       - executor (doğrulanmış veya ham)
 * @param {boolean} [p.verified]   - audit doğrulaması
 * @param {object} [p.target]      - { kind, id, label, extra }
 * @param {string} [p.action]
 * @param {string} [p.reason]
 * @param {string} [p.actorKind]   - 'user'|'bot'|'unknown'
 * @param {number} [p.color]
 * @param {string} [p.note]
 * @returns {Promise<boolean>} başarıyla gönderildi mi
 */
async function sendLog(p = {}) {
  const { guild, logType } = p;
  if (!guild || !logType) return false;
  const meta = LOG_CHANNEL_MAP.get(logType);
  if (!meta) {
    logger.warn(`Bilinmeyen log tipi, atlandı: ${logType}`);
    return false;
  }

  // 1) Kanal çöz (kayıp/ silinmişse otomatik onar)
  let channel = null;
  try {
    channel = await resolveLogChannel(guild, logType);
  } catch (err) {
    logger.error(`Log kanalı çözülemedi (${logType}).`, err);
  }
  if (!channel || !channel.isTextBased?.()) {
    // Kanala yazamıyoruz ama Guard çalışmaya devam eder.
    logger.warn(`Log kanalı yok/erişilemez, log atlandı: ${logType} (${meta.name})`);
    return false;
  }

  // 2) Embed üret
  let embed;
  try {
    embed = buildLogEmbed({ ...p, logType });
  } catch (err) {
    logger.error(`Log embed üretilemedi (${logType}).`, err);
    return false;
  }

  // 3) Gönder (grup kontrolü burada)
  try {
    if (deliveryMode(logType) === 'group') {
      queueGroup(guild, logType, p, channel);
      return true;
    }
    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error(`Log gönderilemedi (${logType}/${meta.name}): ${err.code || err.message}`);
    return false;
  }
}

/**
 * GRUP-SAFE olay: pencereye ekler, pencere dolunca TEK özet embed gönderir.
 * Kritik kanallar BURAYA GİRMEZ.
 */
function queueGroup(guild, logType, p, channel) {
  const key = `${guild.id}:${logType}`;
  let g = pendingGroups.get(key);
  if (!g) {
    g = { entries: [], timer: null, lastAt: Date.now() };
    pendingGroups.set(key, g);
  }

  // Kısa satır: kim/ne
  g.entries.push(compressEntry(p));
  g.lastAt = Date.now();

  // İlk kayıtta timer başlat (pencere sabit, kaymaz).
  if (!g.timer) {
    g.timer = setTimeout(() => {
      pendingGroups.delete(key);
      flushGroup(guild, logType, g, channel).catch(() => {});
    }, GROUP_WINDOW_MS);
    if (typeof g.timer.unref === 'function') g.timer.unref();
  }
}

/** Bir olayı tek satıra sıkıştırır (embed içinde gösterilecek). */
function compressEntry(p) {
  const parts = [];
  if (p.actor?.id) parts.push(`👤 <@${p.actor.id}>`);
  else if (p.verified === false) parts.push('👤 *doğrulanamadı*');
  if (p.target?.id) {
    const kindMark = p.target.kind === 'user' ? '' : p.target.kind === 'role' ? '&' : p.target.kind === 'channel' ? '#' : '';
    parts.push(`🎯 <@${kindMark}${p.target.id}>`);
  }
  const action = p.action ? String(p.action).split('\n')[0].slice(0, 80) : '';
  if (action) parts.push(action);
  return parts.join(' — ');
}

/** Grup penceresi dolunca tek özet embed gönderir. */
async function flushGroup(guild, logType, g, channel) {
  if (!g?.entries?.length) return false;
  try {
    const embed = buildGroupEmbed({
      logType,
      title: `${LOG_CHANNEL_MAP.get(logType)?.label} (toplu)`,
      entries: g.entries,
      total: g.entries.length,
      windowLabel: `${GROUP_WINDOW_MS / 1000}sn pencere`,
    });
    const ch = channel?.isTextBased?.() ? channel : await resolveLogChannel(guild, logType);
    if (!ch) return false;
    await ch.send({ embeds: [embed] });
    logger.debug(`Guard log grubu gönderildi: ${logType} (${g.entries.length} olay)`);
    return true;
  } catch (err) {
    logger.error(`Grup log gönderilemedi (${logType}): ${err.code || err.message}`);
    return false;
  }
}

/**
 * Guard'ın kendi sistem işlemleri (ceza, rollback, whitelist, setup, hata) → guard-log.
 * @param {object} p - { guild, title, action, detail, status, actor, color, note }
 */
async function sendGuardLog(p = {}) {
  const guild = p.guild;
  if (!guild) return false;
  let channel = null;
  try {
    channel = await resolveLogChannel(guild, 'guard');
  } catch (err) {
    logger.error('Guard log kanalı çözülemedi.', err);
  }
  if (!channel?.isTextBased?.()) {
    logger.warn('guard-log kanalı yok, sistem logu atlandı.');
    return false;
  }
  try {
    const embed = buildGuardActionEmbed({ ...p, logType: 'guard' });
    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error(`Guard sistem logu gönderilemedi: ${err.code || err.message}`);
    return false;
  }
}

/**
 * Yardımcı: bir event için tam log akışı.
 * Audit doğrulaması + actor/sender tespiti + hedef + işlem bilgisi.
 * manager.js'in handleGuardEvent içinden ve event katmanından çağrılır.
 *
 * @param {object} p
 * @param {object} p.guild
 * @param {string} p.logType
 * @param {number} [p.auditType]      - AuditLogEvent.*
 * @param {string} [p.targetId]       - audit eşleştirme hedefi
 * @param {object} [p.target]         - embed hedefi
 * @param {string} p.title
 * @param {string} [p.action]
 * @param {string} [p.senderId]       - event'ten gelen bilinen kişi (audit yoksa)
 * @param {string} [p.senderIsBot]
 * @param {string} [p.fallbackActorId]- audit başarısızsa bu kişi "doğrulanamadı" olarak
 * @returns {Promise<boolean>}
 */
async function logEvent(p = {}) {
  const { guild, logType, auditType, targetId } = p;
  const meta = LOG_CHANNEL_MAP.get(logType);
  if (!meta) return false;

  // 1) Bot kendi mi yaptı? (self-loop koruması: bot işlemleri user gibi loglanmaz)
  const actorKind = detectActorKind(guild.id, auditType, targetId, guild.client?.user?.id);

  // 2) Audit doğrulaması: önceden çözülmüş executor varsa tekrar API'ye gitme.
  let actor = null;
  let verified = false;
  let reason = null;

  if (p.resolvedActor) {
    // events.js bazı eventlerde audit'i önceden çözdü (kanal update gibi).
    actor = normalizeActor(p.resolvedActor);
    verified = true;
    reason = p.resolvedReason || null;
  } else if (auditType && targetId) {
    const res = await verifyActor(guild, auditType, targetId);
    if (res?.executor) {
      actor = normalizeActor(res.executor);
      verified = true;
      reason = res.entry?.reason || null;
    }
  }

  // 3) Audit yoksa event sender'ı kullan ama DOĞRULANMAMIŞ olarak işaretle
  if (!actor) {
    const fallbackId = p.senderId || p.fallbackActorId || null;
    if (fallbackId) {
      actor = { id: String(fallbackId), username: p.senderUsername || '', bot: !!p.senderIsBot };
    }
    verified = false; // kesin doğrulanamadı — embed'de belirtilecek
  }

  // 4) Gönder
  return sendLog({
    guild,
    logType,
    title: p.title,
    actor,
    verified,
    reason,
    target: p.target,
    action: p.action,
    actorKind: actor?.bot ? 'bot' : actorKind === 'bot' ? 'bot' : actor ? 'user' : 'unknown',
    note: p.note,
    color: p.color,
  });
}

module.exports = {
  sendLog,
  sendGuardLog,
  logEvent,
  verifyActor,
  normalizeActor,
  detectActorKind,
  deliveryMode,
  queueGroup,
  flushGroup,
  compressEntry,
  // test/diyagnostik
  _pendingGroups: pendingGroups,
  GROUP_WINDOW_MS,
  sweepGroups,
};