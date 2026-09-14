/**
 * Ticket transkripti: kanal mesajlarını okunabilir Markdown dosyasına çevirir.
 * Kapatılan/silinen ticket'ların log mesajına dosya olarak eklenir.
 */
const { AttachmentBuilder } = require('discord.js');
const logger = require('./logger');

const MAX_TRANSCRIPT_MESSAGES = 500; // üst sınır (yavaş ağlarda log akışını kilitlememek için)
const MAX_CHARS_PER_MESSAGE = 1000;

const fmtTime = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/**
 * Kanalın mesajlarını eskten yeniye toplar (sayfalı, üst sınırlı).
 * @returns {Promise<Array>} kronolojik mesaj dizisi
 */
async function fetchChannelMessages(channel, max = MAX_TRANSCRIPT_MESSAGES) {
  const out = [];
  let before = undefined;
  while (out.length < max) {
    const requested = Math.min(100, max - out.length);
    const batch = await channel.messages.fetch({ limit: requested, ...(before ? { before } : {}) });
    const arr = [...(batch?.values?.() || [])];
    if (!arr.length) break; // kanal bitti
    out.push(...arr);
    if (arr.length < requested) break; // son sayfa
    before = arr[arr.length - 1].id; // en eski mesajdan geriye
  }
  return out
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .slice(0, max);
}

function formatMessageLine(m) {
  const tag = m.author?.bot ? `${m.author?.tag || 'Bot'} [BOT]` : m.author?.tag || 'Bilinmeyen';
  const uid = m.author?.id ? ` (${m.author.id})` : '';
  let body = String(m.content || '').trim();
  const attachments = [...(m.attachments?.values?.() || [])];
  if (!body && (m.embeds?.length || 0) > 0 && !attachments.length) body = '[gömülü içerik (embed)]';
  if (!body && !attachments.length) body = '(boş mesaj)';
  if (body.length > MAX_CHARS_PER_MESSAGE) body = body.slice(0, MAX_CHARS_PER_MESSAGE) + '… [kısaltıldı]';
  const lines = [`[${fmtTime(m.createdTimestamp)}] ${tag}${uid}: ${body}`];
  for (const a of attachments.slice(0, 5)) {
    lines.push(`  📎 Ek: ${a.name || 'dosya'} — ${a.url || ''}`);
  }
  return lines.join('\n');
}

/**
 * @returns {{ attachment: AttachmentBuilder, truncated: boolean } | null}
 */
function buildTranscriptFile(ticket, messages, { guildName = '', statusText = '' } = {}) {
  try {
    const list = [...(messages || [])];
    const truncated = list.length >= MAX_TRANSCRIPT_MESSAGES;
    const head = [
      'TICKET TRANSKRİPTİ',
      `Ticket: #${ticket?.id ?? '?'} (${ticket?.category_label || '—'})`,
      `Sunucu: ${guildName || ticket?.guild_id || '—'}`,
      `Sahip: ${ticket?.user_id ? `<@${ticket.user_id}> (${ticket.user_id})` : '—'}`,
      `Durum: ${statusText || ticket?.status || '—'}`,
      `Açılma: ${ticket?.created_at ? fmtTime(ticket.created_at) : '—'}`,
      `Dışa aktarma: ${fmtTime(Date.now())}`,
      `Mesaj sayısı: ${list.length}${truncated ? ` (ilk ${MAX_TRANSCRIPT_MESSAGES} mesaj)` : ''}`,
      '='.repeat(40),
      '',
    ];
    const body = list.length ? list.map(formatMessageLine).join('\n') : '(kanalda mesaj bulunamadı)';
    const text = head.join('\n') + body + '\n';
    const attachment = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
      name: `ticket-${ticket?.id ?? 'bilinmiyor'}-transcript.md`,
    });
    return { attachment, truncated };
  } catch (err) {
    logger.warn(`Transkript dosyası üretilemedi: ${err.message}`);
    return null;
  }
}

module.exports = { MAX_TRANSCRIPT_MESSAGES, fetchChannelMessages, formatMessageLine, buildTranscriptFile };
