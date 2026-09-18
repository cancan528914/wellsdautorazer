/**
 * FiveM canlı sorgu embed tasarımları — koyu, modern, gaming temalı.
 * Footer: "FiveM Live Query • <cfxId>" + timestamp (spec §28).
 * GÜVENLİK: isimler parser.sanitizeName ile temizlenmiş gelir; burada ek kaçış yok.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { FIRST, PREV, NEXT, LAST, pageSlice } = require('../services/fivem/pagination');

/**
 * Sorgu hatası için kullanıcı dostu metin (teknik detay YOK — spec §22, §48).
 * @param {{status:string, detail:string}} query
 */
function errorTextFor(query) {
  const d = query?.detail || 'unknown';
  if (d === 'no_endpoint') {
    return '❌ **FiveM sunucusuna bağlanılamadı.**\nSunucu adresi çözülemedi. Bir yetkili `FIVEM_SERVER_ENDPOINT` değerini kontrol etmeli.';
  }
  if (d === 'timeout') {
    return '⚠️ **FiveM sunucusundan zamanında cevap alınamadı.**\nLütfen biraz bekleyip tekrar deneyin.';
  }
  if (d === 'forbidden') {
    return '⚠️ **FiveM sunucusu oyuncu listesi erişimini kısıtlamış (403).**\nListe herkese açık değil; sunucu yetkilisiyle görüşün.';
  }
  if (d === 'not_found') {
    return '⚠️ **FiveM sorgu endpointi bulunamadı (404).**\nBir yetkili `FIVEM_SERVER_ENDPOINT` değerini kontrol etmeli.';
  }
  if (d === 'rate_limited') {
    return '⚠️ **FiveM sunucusu hız limiti uyguluyor (429).**\nLütfen biraz bekleyip tekrar deneyin.';
  }
  if (d === 'invalid_json' || d === 'invalid_players') {
    return '⚠️ **FiveM oyuncu verisi okunamadı.**\nSunucu beklenmedik formatta cevap verdi.';
  }
  // timeout/unreachable/server_error/bad_status → OFFLINE
  return '🔴 **FiveM sunucusu offline**\nSunucuya şu anda erişilemiyor. Lütfen daha sonra tekrar deneyin.';
}

/**
 * Pagination oturumundan sayfa payload'u üretir (komut ilk cevabı + buton handler ortak).
 * @param {object} session {type, term, players, hostname, onlineCount, maxClients, latencyMs}
 */
function buildPagedPayload(session, page, totalPages) {
  const slice = pageSlice(session.players, page);
  const base = (page - 1) * config.fivem.pageSize;
  let embed;
  if (session.type === 'tag') {
    embed = buildPlayerListEmbed({
      kind: 'tag',
      title: '🔎 TAG SORGUSU',
      headerLines: tagHeader(session.term, session.players.length),
      players: slice,
      page,
      totalPages,
      total: session.players.length,
      startIndex: base,
      onlineCount: session.onlineCount,
      maxClients: session.maxClients,
      latencyMs: session.latencyMs,
    });
  } else {
    embed = buildPlayerListEmbed({
      kind: 'players',
      title: '🎮 AKTİF OYUNCULAR',
      headerLines: playersHeader(session.hostname),
      players: slice,
      page,
      totalPages,
      total: session.players.length,
      startIndex: base,
      onlineCount: session.onlineCount,
      maxClients: session.maxClients,
      latencyMs: session.latencyMs,
    });
  }
  const row = buildPaginationRow(page, totalPages);
  return row ? { embeds: [embed], components: [row] } : { embeds: [embed] };
}

const FIVEM_ORANGE = 0xff8c1a;
const ONLINE_GREEN = 0x2ecc71;
const OFFLINE_RED = 0xe74c3c;

function footer() {
  return `FiveM Live Query • ${config.fivem.cfxId}`;
}

function baseEmbed(color) {
  return new EmbedBuilder().setColor(color).setFooter({ text: footer() }).setTimestamp();
}

function fmtPing(ping) {
  return ping === null || ping === undefined ? 'N/A' : `${ping}ms`;
}

function fmtCount(online, max) {
  const o = online === null || online === undefined ? '?' : String(online);
  const m = max === null || max === undefined ? '?' : String(max);
  return `${o} / ${m}`;
}

function serverLine(hostname) {
  return hostname ? `🎮 **${hostname}**` : '🎮 Sunucu adı alınamadı';
}

/** Tek oyuncu satırı: "**3. Name**\nID: 12 • Ping: 31ms" */
function playerLine(globalIndex, player) {
  return `**${globalIndex}. ${player.name}**\nID: ${player.id} • Ping: ${fmtPing(player.ping)}`;
}

/** /id bulundu */
function buildPlayerEmbed({ player, hostname, onlineCount, maxClients, latencyMs }) {
  return baseEmbed(ONLINE_GREEN)
    .setTitle('🎮 FIVE M OYUNCU SORGUSU')
    .setDescription(
      `👤 **${player.name}**\n\n${serverLine(hostname)}\n🟢 **ONLINE** — Sunucuda aktif`,
    )
    .addFields(
      { name: '🆔 Server ID', value: `\`${player.id}\``, inline: true },
      { name: '🏓 Ping', value: fmtPing(player.ping), inline: true },
      { name: '👥 Online', value: fmtCount(onlineCount, maxClients), inline: true },
      { name: '⏱️ Sorgu', value: `${latencyMs}ms`, inline: true },
    );
}

/** /id bulunamadı (public sonuç embed'i — spec §17) */
function buildPlayerNotFoundEmbed({ id, hostname, onlineCount, maxClients, latencyMs }) {
  return baseEmbed(FIVEM_ORANGE)
    .setTitle('🎮 FIVE M OYUNCU SORGUSU')
    .setDescription(`${serverLine(hostname)}\n\n🔴 **ID \`${id}\` şu anda sunucuda bulunmuyor.**`)
    .addFields(
      { name: '👥 Online', value: fmtCount(onlineCount, maxClients), inline: true },
      { name: '⏱️ Sorgu', value: `${latencyMs}ms`, inline: true },
    );
}

/**
 * Sayfalı oyuncu listesi (/aktifoyuncular + /tag ortak).
 * kind: 'players' | 'tag'
 */
function buildPlayerListEmbed({ kind, title, headerLines, players, page, totalPages, total, startIndex, onlineCount, maxClients, latencyMs }) {
  const lines = players.map((p, i) => playerLine(startIndex + i + 1, p));
  const head = [...headerLines, `📄 Sayfa **${page} / ${totalPages}** • Toplam **${total}**`].join('\n');
  const body = lines.length ? lines.join('\n\n') : '*Bu sayfada oyuncu yok.*';
  const embed = baseEmbed(FIVEM_ORANGE).setTitle(title).setDescription(`${head}\n\n────────────────\n\n${body}`);
  if (kind === 'players') {
    embed.addFields({ name: '👥 Aktif', value: fmtCount(onlineCount, maxClients), inline: true });
  }
  embed.addFields({ name: '⏱️ Sorgu', value: `${latencyMs}ms`, inline: true });
  return embed;
}

/** /aktifoyuncular başlığı (bu embed sadece LIVE iken kurulur) */
function playersHeader(hostname) {
  return [serverLine(hostname), '🟢 **Sunucu Online**'];
}

/** /tag başlığı (toplam sayı HER ZAMAN — spec §15) */
function tagHeader(term, total) {
  return [`🔎 Aranan: \`${term.slice(0, 64)}\``, total > 0 ? `🟢 **${total} aktif oyuncu bulundu**` : ''];
}

/** /tag boş sonuç (public — spec §16) */
function buildTagEmptyEmbed({ term }) {
  return baseEmbed(FIVEM_ORANGE)
    .setTitle('🔎 TAG SORGUSU')
    .setDescription(`🔎 Aranan: \`${term.slice(0, 64)}\`\n\n❌ **Sonuç bulunamadı.**\nŞu anda isminde \`${term.slice(0, 64)}\` geçen aktif oyuncu bulunmuyor.`);
}

/** Sunucu online ama 0 oyuncu (OFFLINE ile karıştırma — spec §34) */
function buildOnlineEmptyEmbed({ hostname, maxClients, latencyMs }) {
  return baseEmbed(ONLINE_GREEN)
    .setTitle('🎮 AKTİF OYUNCULAR')
    .setDescription(`${serverLine(hostname)}\n🟢 **Sunucu Online**\n\n👥 Aktif oyuncu yok (**0 / ${maxClients ?? '?'}**).`)
    .addFields({ name: '⏱️ Sorgu', value: `${latencyMs}ms`, inline: true });
}

/** PARTIAL: sunucu erişilebilir ama liste alınamıyor (spec §50) */
function buildListUnavailableEmbed({ hostname, onlineCount, maxClients, latencyMs, detail }) {
  const why =
    detail === 'forbidden'
      ? 'Oyuncu listesi sunucu tarafından kısıtlanmış (403).'
      : detail === 'rate_limited'
        ? 'Hız limiti aşıldı (429). Biraz bekleyip tekrar deneyin.'
        : 'Oyuncu listesi endpointine ulaşılamıyor.';
  return baseEmbed(FIVEM_ORANGE)
    .setTitle('🎮 AKTİF OYUNCULAR')
    .setDescription(`${serverLine(hostname)}\n🟢 **Sunucu Online** — 👥 **${fmtCount(onlineCount, maxClients)}**\n\n⚠️ **Oyuncu listesi şu anda alınamıyor.**\n${why}`);
}

/** Pagination buton satırı: ⏮ ◀ ▶ ⏭ (tek sayfada buton yok) */
function buildPaginationRow(page, totalPages) {
  if (totalPages <= 1) return null;
  const btn = (id, emoji, label, disabled) =>
    new ButtonBuilder().setCustomId(id).setEmoji(emoji).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  return new ActionRowBuilder().addComponents(
    btn(FIRST, '⏮', 'İlk', page <= 1),
    btn(PREV, '◀', 'Önceki', page <= 1),
    btn(NEXT, '▶', 'Sonraki', page >= totalPages),
    btn(LAST, '⏭', 'Son', page >= totalPages),
  );
}

module.exports = {
  FIVEM_ORANGE,
  ONLINE_GREEN,
  OFFLINE_RED,
  fmtPing,
  fmtCount,
  playerLine,
  buildPlayerEmbed,
  buildPlayerNotFoundEmbed,
  buildPlayerListEmbed,
  playersHeader,
  tagHeader,
  buildTagEmptyEmbed,
  buildOnlineEmptyEmbed,
  buildListUnavailableEmbed,
  buildPaginationRow,
  errorTextFor,
  buildPagedPayload,
};
