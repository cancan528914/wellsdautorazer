/**
 * Incident log kuyruğu — TEK LOG garantisinin merkezi (§1, §2, §4, §8, §9, §11, §13).
 *
 * Akış: punish + rollback HEMEN uygulanır (hız korunur), LOG 5sn'lik sabit
 * pencerede toplanır ve TEK embed olarak atılır. Aynı incident'e (guild+actor)
 * pencere içinde gelen her aksiyon detaya eklenir, ayrı log basılmaz.
 *
 * - Pencere SABİTTİR (kaymaz): sonsuz birleşme yok (§12).
 * - logSent SADECE başarılı gönderimde true olur; hata → tek retry → vazgeç (§13).
 * - Timer'lar unref'lidir (process asılı kalmaz).
 *
 * Item: { action, actionLabel, guardLabel, targetId, targetKind, targetDesc,
 *         punishment, rollback, sensitive, at }
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { INCIDENT_LOG_WINDOW_MS } = require('./constants');
const { getLogChannel } = require('./logger');

// `${guildId}:${executorId}` -> { timer, guild, execSnap, items, startedAt, logSent }
const pending = new Map();

const MAX_ITEMS = 25;

const trDate = (ts) => new Date(ts || Date.now()).toLocaleString('tr-TR', { hour12: false });

function baseEmbed(color) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `${config.botName} | Guard System` })
    .setTimestamp();
}

/** Aksiyon adından hedef türü: user | role | channel | null */
function targetKindFor(action) {
  try {
    const a = String(action || '');
    if (a.startsWith('MEMBER_')) return 'user';
    if (a.startsWith('ROLE_')) return 'role';
    if (a.startsWith('CHANNEL_') || a.startsWith('THREAD_')) return 'channel';
  } catch {
    /* ignore */
  }
  return null;
}

function isSnowflake(id) {
  return /^\d{5,25}$/.test(String(id || ''));
}

function targetMention(item) {
  try {
    const id = String(item?.targetId || '');
    if (!isSnowflake(id)) return null;
    if (item?.targetKind === 'user') return `<@${id}>`;
    if (item?.targetKind === 'role') return `<@&${id}>`;
    if (item?.targetKind === 'channel') return `<#${id}>`;
  } catch {
    /* ignore */
  }
  return null;
}

function esc(s, n) {
  return String(s ?? '—').slice(0, n);
}

/**
 * TEK incident embed'i (§1 + §9 + §11).
 * - Kişiler MUTLAKA mention (§8); ID satırları ek bilgi.
 * - 🔨 bölümü SADECE gerçekten banlandıysa görünür.
 * - Rollback hatası HATA satırıyla görünür (§13 in-embed).
 */
function buildIncidentEmbed(execSnap, items) {
  const execId = String(execSnap?.id || '');
  const punished = (items || []).some((i) => i?.punishment?.ok);
  const multi = (items || []).length > 1;
  const embed = baseEmbed(punished ? 0xe74c3c : 0xe67e22).setTitle('🛡️ GUARD TETİKLENDİ');

  embed.addFields({ name: '👤 İşlemi Yapan', value: isSnowflake(execId) ? `<@${execId}>\nID: \`${execId}\`` : '`bilinmiyor`', inline: false });

  if (!multi) {
    const it = items[0] || {};
    embed.addFields({ name: '⚠️ Yapılan İşlem', value: esc(it.actionLabel, 200), inline: false });
  } else {
    const labels = [...new Set((items || []).map((i) => String(i?.actionLabel || 'Bilinmeyen işlem').slice(0, 100)))];
    embed.addFields({ name: '⚠️ Tespit Edilen İşlemler', value: labels.map((l) => `• ${l}`).join('\n').slice(0, 1000), inline: false });
    const lines = (items || []).slice(0, 10).map((i) => {
      const m = targetMention(i);
      return `• ${esc(i?.actionLabel, 80)} → ${m || esc(i?.targetDesc, 80)}`;
    });
    if ((items || []).length > 10) lines.push(`• +${items.length - 10} işlem daha…`);
    embed.addFields({ name: '📋 İşlemler', value: lines.join('\n').slice(0, 1000), inline: false });
  }

  // Hedefler (mention + ID)
  const seen = new Set();
  const targetLines = [];
  for (const it of items || []) {
    const key = `${it?.targetKind || '?'}:${it?.targetId || '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = targetMention(it);
    const idLine = it?.targetId ? `\nID: \`${it.targetId}\`` : '';
    const desc = it?.targetDesc && (!m || !String(it.targetDesc).includes(String(it.targetId))) ? `\n${esc(it.targetDesc, 100)}` : '';
    targetLines.push(`${m || esc(it?.targetDesc, 100)}${idLine}${desc}`);
    if (targetLines.length >= 5) break;
  }
  const extraTargets = new Set((items || []).map((i) => `${i?.targetKind}:${i?.targetId}`).filter(Boolean)).size - seen.size;
  embed.addFields({
    name: multi ? '🎯 Hedefler' : '🎯 Hedef',
    value: (targetLines.join('\n\n') || '—').slice(0, 1000) + (extraTargets > 0 ? `\n+${extraTargets} hedef daha…` : ''),
    inline: false,
  });

  const guards = [...new Set((items || []).map((i) => String(i?.guardLabel || '').slice(0, 60)).filter(Boolean))];
  if (guards.length) embed.addFields({ name: '🛡️ Guard', value: guards.join(', ').slice(0, 200), inline: false });

  // Geri alma sonuçları (her aksiyon için ayrı satır)
  const rbLines = (items || []).map((i) => {
    const rb = i?.rollback;
    if (!rb) return `• ${esc(i?.actionLabel, 60)}: geri alma uygulanamaz`;
    if (rb.ok) return `• ${esc(rb.detail || 'geri alındı', 120)}`;
    return `• ❌ ${esc(rb.detail || 'geri alınamadı', 150)}`;
  });
  embed.addFields({ name: '🔄 Guard İşlemleri', value: (rbLines.join('\n') || '—').slice(0, 1000), inline: false });

  if (punished) {
    embed.addFields({ name: '🔨 Sonuç', value: isSnowflake(execId) ? `<@${execId}> guard banı ile uzaklaştırıldı` : 'Guard banı uygulandı', inline: false });
  } else {
    const why = (items || []).map((i) => i?.punishment?.detail).find(Boolean);
    embed.addFields({ name: '🔨 Sonuç', value: `Ban uygulanamadı${why ? `: ${esc(why, 200)}` : ''}`, inline: false });
  }

  embed.addFields({ name: '🕒 Zaman', value: trDate(), inline: false });
  return embed;
}

async function sendOnce(guild, embed) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard incident logu gönderilemedi.', err);
    return false;
  }
}

async function flushIncident(guildId, executorId, isRetry = false) {
  const key = `${guildId}:${executorId}`;
  const p = pending.get(key);
  if (!p) return false;
  // logSent + sending kontrolleri SENKRON yapılır (çift gönderim yarışı yok).
  if (p.logSent) {
    pending.delete(key);
    return true;
  }
  if (p.sending) return false;
  p.sending = true;
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const embed = buildIncidentEmbed(p.execSnap, p.items);
  const ok = await sendOnce(p.guild, embed);
  p.sending = false;
  if (ok) {
    // logSent SADECE başarılı gönderimde true olur (§13).
    p.logSent = true;
    pending.delete(key);
    return true;
  }
  if (!isRetry) {
    // Tek retry: yeni timer kur, bekleyen item'lar aynı kuyrukta kalır.
    logger.warn(`Guard incident logu başarısız, 5sn sonra tek retry: ${key}`);
    p.timer = setTimeout(() => {
      p.timer = null;
      flushIncident(guildId, executorId, true).catch(() => {});
    }, 5000);
    if (typeof p.timer.unref === 'function') p.timer.unref();
    return false;
  }
  logger.error(`Guard incident logu kalıcı başarısız, düşürüldü: ${key}`);
  pending.delete(key);
  return false;
}

/**
 * Incident log kuyruğuna ekle. Aynı incident penceresi içinde TEK timer çalışır;
 * pencere dolunca TEK log atılır. Dönen değer bilgi amaçlıdır.
 */
function queueIncidentLog(guild, execSnap, item, opts = {}) {
  try {
    if (!guild || !execSnap?.id || !item) return { queued: false };
    const key = `${guild.id}:${execSnap.id}`;
    const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : INCIDENT_LOG_WINDOW_MS;
    let p = pending.get(key);
    if (!p || p.logSent) {
      p = { timer: null, guild, execSnap: { id: String(execSnap.id), tag: execSnap.tag || 'Bilinmeyen' }, items: [], startedAt: Date.now(), logSent: false };
      pending.set(key, p);
    }
    p.items.push({ ...item, at: item.at || Date.now() });
    if (p.items.length > MAX_ITEMS) p.items.splice(0, p.items.length - MAX_ITEMS);
    if (!p.timer && !p.logSent) {
      p.timer = setTimeout(() => {
        flushIncident(guild.id, String(execSnap.id)).catch(() => {});
      }, windowMs);
      if (typeof p.timer.unref === 'function') p.timer.unref();
    }
    return { queued: true, logSent: !!p.logSent, pending: p.items.length };
  } catch (err) {
    logger.error('Guard incident kuyruk hatası.', err);
    return { queued: false };
  }
}

module.exports = {
  queueIncidentLog,
  flushIncident,
  buildIncidentEmbed,
  targetKindFor,
  targetMention,
  _pending: pending,
};
