/**
 * Sunucu takip botu embed'leri (oyuncu SAYISI tabanlı).
 *
 * Sunucu sahibi oyuncu isimlerini paylaşmadığı için bu modül isim/ID listesi
 * ÜRETMEZ. Erişilebilen gerçek veriyi gösterir:
 *   • anlık oyuncu sayısı, ortalama, zirve, trend
 *   • katılma/ayrılma SAYIM olayları (kimin katıldığı bilinmez)
 *   • erişilemeyen veri açıkça söylenir (gizleme yok)
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');

const FIVEM_ORANGE = 0xff8c1a;
const ONLINE_GREEN = 0x2ecc71;
const OFFLINE_RED = 0xe74c3c;

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function baseEmbed(color) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `FiveM Takip • ${config.fivem.cfxId}` })
    .setTimestamp();
}

function serverLine(hostname) {
  return hostname ? `🎮 **${hostname}**` : '🎮 Sunucu adı alınamadı';
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' });
}

/**
 * Erişilemeyen veri bildirimi — bu botun dürüst cevabı.
 * @param {object|null} q sorgu sonucu (sayı gösterilebilirse)
 * @param {'search'|'id'|'offline'} reason
 */
function buildPrivacyNoticeEmbed(q, reason) {
  const count = q ? q.onlineCount : null;
  const hasCount = count !== null && count !== undefined;

  let why;
  if (reason === 'search') {
    why = 'İsimle arama yapılamaz — sunucu oyuncu isimlerini herkese açık vermiyor.';
  } else if (reason === 'id') {
    why = 'Server ID ile sorgu yapılamaz — sunucu oyuncu ID’lerini gizliyor.';
  } else if (reason === 'offline') {
    why = 'Sunucuya ulaşılamıyor.';
  } else {
    why = 'Sunucu oyuncu verisini paylaşmıyor.';
  }

  const lines = [];
  if (q && q.hostname) lines.push(serverLine(q.hostname));
  lines.push('🔴 **' + why + '**');
  if (hasCount) lines.push('👥 Yine de **aktif oyuncu sayısı** verilebiliyor: **' + count + '**');
  lines.push('');
  lines.push('**Bu bir bot hatası değil.** Sunucu sahibi `players.json` çıktısını gizliyor');
  lines.push('(her kayıt `id=0`, ad `Player` olarak dönüyor).');

  return baseEmbed(FIVEM_ORANGE)
    .setTitle('🔒 Oyuncu Verisi Paylaşılmıyor')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: '✅ Erişebildiğimiz', value: 'Aktif oyuncu **sayısı**, sunucu adı, durum, kapasite, harita', inline: false },
      { name: '🚫 Erişemediğimiz', value: 'Oyuncu **isimleri** ve FiveM **Server ID**’leri', inline: false },
      { name: '📌 Durum', value: 'Panel ve `/sunucudurum` her zaman çalışır.', inline: false },
    );
}

/**
 * Hareketlilik özeti.
 * @param {object} t tracker.summary()
 */
function buildActivityEmbed(t) {
  // Kesinti VARSA bunu ayrıca göster: oyuncu çıkışı değil, sunucuya erişilemiyor.
  if (t && t.outage) {
    const mins = t.outageSince ? Math.round((Date.now() - t.outageSince) / 60000) : null;
    const since = mins === null ? '' : mins >= 1 ? mins + ' dakikadır' : 'birkaç saniye oldu';
    return baseEmbed(OFFLINE_RED)
      .setTitle('⛔ Sunucuya Erişilemiyor')
      .setDescription(
        [
          '🔴 FiveM sunucusuna şu anda ulaşılamıyor.',
          '',
          since ? '⏱️ Kesinti süresi: **' + since + '**' : '',
          '',
          '**Bu bir oyuncu çıkışı DEĞİLDİR** — sunucu kapanmadı, bot sunucuya ulaşamadı.',
          'Bu yüzden katılma/ayrılma sayacına **hiçbir şey eklenmez**.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .addFields({
        name: '📌 Durum',
        value: 'Sunucu tekrar erişilebilir olduğunda takip otomatik devam eder.',
        inline: false,
      });
  }

  if (!t || t.current === null || t.current === undefined) {
    return buildPrivacyNoticeEmbed(null, 'offline');
  }

  const mins = Math.round(t.uptimeMs / 60000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} sa ${mins % 60} dk` : `${mins} dk`;

  const trendEmoji =
    t.trend === null || t.trend === undefined ? '➖' : t.trend > 0 ? '📈' : t.trend < 0 ? '📉' : '➖';
  const trendText =
    t.trend === null || t.trend === undefined
      ? 'veri yok'
      : t.trend === 0
        ? 'değişim yok'
        : `${t.trend > 0 ? '+' : ''}${t.trend} (son 30 dk)`;

  const fields = [
    { name: '👥 Şu an', value: String(t.current), inline: true },
    { name: '📊 Ortalama', value: t.avg === null ? '—' : String(t.avg), inline: true },
    { name: `${trendEmoji} Trend`, value: trendText, inline: true },
  ];

  if (t.peak.count > 0) {
    fields.push({
      name: '🚀 Zirve',
      value: `${t.peak.count} kişi (${clock(t.peak.at)})`,
      inline: true,
    });
  }
  fields.push(
    { name: '⬆️ Toplam artış', value: `+${t.joined || 0}`, inline: true },
    { name: '⬇️ Toplam azalış', value: `−${t.left || 0}`, inline: true },
  );

  let lastLine = '—';
  if (t.outage) {
    lastLine = '⛔ Sunucu erişilemiyor (kesinti sayıldı, oyuncu çıkışı değil)';
  } else if (t.lastEvent) {
    const e = t.lastEvent;
    const ago = Math.max(0, Math.round((Date.now() - e.at) / 1000));
    lastLine =
      e.delta > 0
        ? `⬆️ ${e.delta} kişi katıldı — ${ago} sn önce (${e.from} → ${e.to})`
        : `⬇️ ${Math.abs(e.delta)} kişi ayrıldı — ${ago} sn önce (${e.from} → ${e.to})`;
  }

  const embed = baseEmbed(ONLINE_GREEN)
    .setTitle('📈 Sunucu Hareketliliği')
    .setDescription(`Takip süresi: **${dur}** • Örnek: **${t.sampleCount || 0}**`)
    .addFields(fields);

  embed.addFields({ name: '🕒 Son hareket', value: lastLine, inline: false });

  const s = t.samples || [];
  if (s.length >= 4) {
    const counts = s.map((x) => x.count);
    const max = Math.max(...counts, 1);
    const min = Math.min(...counts, 0);
    const range = Math.max(1, max - min);
    const spark = s
      .slice(-40)
      .map((x) => SPARK[Math.min(7, Math.max(0, Math.floor(((x.count - min) / range) * 7)))])
      .join('');
    embed.addFields({ name: '📊 Grafik (son 40 örnek)', value: spark, inline: false });
  }

  embed.setFooter({ text: 'Sayısal takip • isimler sunucu tarafından paylaşılmıyor' });
  return embed;
}

/**
 * /oyuncular karşılığı: isim listesi yerine SAYI + hareketlilik.
 * @param {object} q sorgu sonucu
 * @param {object} t tracker.summary()
 */
function buildCountEmbed(q, t) {
  const online = q.onlineCount ?? (q.players ? q.players.length : null);
  const max = q.maxClients;
  const pct = max && online !== null ? Math.min(100, Math.round((online / max) * 100)) : null;

  const barLen = 20;
  const filled = pct === null ? 0 : Math.round((pct / 100) * barLen);
  const bar = pct === null ? '—' : '█'.repeat(filled) + '░'.repeat(barLen - filled);

  const lines = [];
  if (q.hostname) lines.push(serverLine(q.hostname));
  lines.push(`👥 **${online ?? '—'}** / ${max ?? '—'} oyuncu${pct !== null ? `  (${pct}%)` : ''}`);
  if (pct !== null) lines.push('`' + bar + '`');
  lines.push('');
  lines.push('🔒 **Oyuncu isimleri ve Server ID’leri sunucu tarafından paylaşılmıyor.**');
  lines.push('Gösterilebilen tek veri oyuncu **sayısı** ve **hareketlilik** verisidir.');

  const embed = baseEmbed(ONLINE_GREEN)
    .setTitle('👥 Aktif Oyuncu Sayısı')
    .setDescription(lines.join('\n'));

  if (t && t.current !== null) {
    embed.addFields(
      { name: '📊 Ortalama', value: t.avg === null ? '—' : String(t.avg), inline: true },
      { name: '🚀 Zirve', value: t.peak.count ? String(t.peak.count) : '—', inline: true },
      {
        name: '📈 Son 30 dk',
        value: t.trend === null || t.trend === undefined ? '—' : `${t.trend > 0 ? '+' : ''}${t.trend}`,
        inline: true,
      },
    );
  }

  embed.addFields({
    name: '📌 Not',
    value:
      'Sunucu sahibi isimleri gizlediği için liste gösterilemiyor. ' +
      'Bu bir bot hatası değil, sunucunun gizlilik ayarı. ' +
      '`/sunucudurum` ile tüm sunucu bilgilerini görebilirsin.',
    inline: false,
  });

  return embed;
}

module.exports = {
  buildPrivacyNoticeEmbed,
  buildActivityEmbed,
  buildCountEmbed,
};