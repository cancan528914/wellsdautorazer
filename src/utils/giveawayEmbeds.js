/**
 * Çekiliş embed + süre yardımcıları (tek merkez).
 * Tasarım: koyu embed + altın accent, sade field yapısı.
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');

const GIVEAWAY_EMOJI = '🎉';
const COLOR_ACTIVE = 0xffc800; // altın
const COLOR_ENDED = 0x808080; // gri
const COLOR_RESULT = 0x57f287; // yeşil

const MIN_DURATION_SEC = 30;
const MAX_DURATION_SEC = 30 * 24 * 3600; // 30 gün
const MAX_WINNERS = 20;
const MAX_LIMIT = 10000;
const MAX_PRIZE_LEN = 200;

function brandFooter() {
  return `${config.botName} | Çekiliş Sistemi`;
}

function baseEmbed(color) {
  return new EmbedBuilder().setColor(color).setFooter({ text: brandFooter() }).setTimestamp();
}

/**
 * Süre metnini saniyeye çevirir. Kabul: 30s 5m 2h 3d 7d + TR varyantlar.
 * Dönüş: saniye (number) veya null (geçersiz).
 */
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const m = String(input)
    .trim()
    .toLowerCase()
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .match(/^(\d+)\s*([a-z]*)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || '';
  let mult = null;
  if (['s', 'sn', 'sec', 'saniye'].includes(unit)) mult = 1;
  else if (['m', 'dk', 'min', 'dakika'].includes(unit)) mult = 60;
  else if (['h', 'saat'].includes(unit)) mult = 3600;
  else if (['d', 'gun'].includes(unit)) mult = 86400; // 'gün' normalize ile 'gun' olur
  if (mult === null) return null;
  const sec = n * mult;
  if (sec < MIN_DURATION_SEC || sec > MAX_DURATION_SEC) return null;
  return sec;
}

/** Desteklenen süre formatlarının kullanıcıya açıklaması (README + hata mesajı). */
function durationHelp() {
  return 'Geçerli formatlar: `30s` (saniye), `5m` (dakika), `2h` (saat), `3d` (gün). TR: `sn`, `dk`, `dakika`, `saat`, `gün`. En az 30 saniye, en fazla 30 gün.';
}

/** Saniyeyi kısa TR metne çevirir (örn. 3 gün 2 saat). */
function formatDurationShort(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} gün`);
  if (h) parts.push(`${h} saat`);
  if (m && !d) parts.push(`${m} dakika`);
  if (!parts.length) parts.push(`${s % 60} saniye`);
  return parts.slice(0, 2).join(' ');
}

function roleLine(requiredRoleId) {
  return requiredRoleId ? `<@&${requiredRoleId}>` : 'Herkes';
}

function countLine(count, max) {
  return max > 0 ? `${count} / ${max}` : `${count}`;
}

/**
 * Aktif çekiliş paneli. g: giveaway DB satırı, count: güncel katılımcı sayısı.
 */
function buildGiveawayEmbed(g, count) {
  const endUnix = Math.floor(Number(g.end_at) / 1000);
  const embed = baseEmbed(COLOR_ACTIVE)
    .setTitle('🎉 Çekiliş Başladı! 🎉')
    .setDescription(`🎁 **Ödül:** ${String(g.prize).slice(0, MAX_PRIZE_LEN)}\n\nKatılmak için aşağıdaki ${GIVEAWAY_EMOJI} tepkisine tıkla!`)
    .addFields(
      { name: '⏰ Kalan Süre', value: `<t:${endUnix}:R> (<t:${endUnix}:F>)`, inline: false },
      { name: '👤 Başlatan', value: `<@${g.host_id}>`, inline: true },
      { name: '🏆 Kazanan Sayısı', value: `${Number(g.winner_count)}`, inline: true },
      { name: '🎭 Gerekli Rol', value: roleLine(g.required_role_id), inline: true },
      { name: '👥 Katılımcı', value: countLine(count, Number(g.max_participants)), inline: false },
    );
  return embed;
}

/** Sona ermiş panel (orijinal mesaj düzenlenir). */
function buildGiveawayEndedEmbed(g, count, winners) {
  const list = (winners || []).filter(Boolean);
  const embed = baseEmbed(COLOR_ENDED)
    .setTitle('🎉 Çekiliş Sona Erdi!')
    .setDescription(`🎁 **Ödül:** ${String(g.prize).slice(0, MAX_PRIZE_LEN)}`)
    .addFields(
      { name: '👤 Başlatan', value: `<@${g.host_id}>`, inline: true },
      { name: '👥 Katılımcı', value: `${count}`, inline: true },
      {
        name: list.length > 1 ? '🏆 Kazananlar' : '🏆 Kazanan',
        value: list.length ? list.map((id, i) => (list.length > 1 ? `${i + 1}. <@${id}>` : `<@${id}>`)).join('\n') : 'Katılımcı olmadığı için kazanan seçilemedi.',
        inline: false,
      },
    );
  return embed;
}

/** Sonuç mesajı (+ reroll butonu handler tarafında eklenir). */
function buildGiveawayResultEmbed(g, winners) {
  const list = (winners || []).filter(Boolean);
  const embed = baseEmbed(COLOR_RESULT)
    .setTitle('🎉 ÇEKİLİŞ SONUCU 🎉')
    .setDescription(`🎁 **Ödül:** ${String(g.prize).slice(0, MAX_PRIZE_LEN)}\n\nTebrikler! 🎉`)
    .addFields(
      {
        name: list.length > 1 ? '🏆 Kazananlar' : '🏆 Kazanan',
        value: list.length ? list.map((id, i) => (list.length > 1 ? `${i + 1}. <@${id}>` : `<@${id}>`)).join('\n') : 'Katılımcı olmadığı için kazanan seçilemedi.',
        inline: false,
      },
      { name: '👑 Çekilişi başlatan', value: `<@${g.host_id}>`, inline: false },
    );
  return embed;
}

module.exports = {
  GIVEAWAY_EMOJI,
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
  MAX_WINNERS,
  MAX_LIMIT,
  MAX_PRIZE_LEN,
  parseDuration,
  durationHelp,
  formatDurationShort,
  buildGiveawayEmbed,
  buildGiveawayEndedEmbed,
  buildGiveawayResultEmbed,
};
