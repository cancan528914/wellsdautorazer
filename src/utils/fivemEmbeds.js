/**
 * FiveM canlı sorgu embed tasarımları — koyu, modern, gaming temalı.
 * Footer: "FiveM Live Query • <cfxId>" + timestamp (spec §28).
 * GÜVENLİK: isimler parser.sanitizeName ile temizlenmiş gelir; burada ek kaçış yok.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { FIRST, PREV, NEXT, LAST, pageSlice } = require('../services/fivem/pagination');

/**
 * Sorgu hatası için kullanıcı dostu metin — hata türüne göre AYRI mesaj (§9, §10, §30).
 * Teknik detay YOK; sunucu adresi bilgi amaçlı eklenir.
 * @param {{status:string, detail:string, base?:string}} query
 * @param {string} [base]
 */
function errorTextFor(query, base) {
  const d = query?.detail || 'unknown';
  const b = shortBase(base || query?.base);
  const srv = b ? `\n\nSunucu:\n\`${b}\`` : '';
  if (d === 'no_endpoint') {
    return `❌ **FiveM sunucusuna bağlanılamadı.**\nSunucu adresi oluşturulamadı. Bir yetkili \`FIVEM_SERVER_HOST\` / \`FIVEM_SERVER_PORT\` değerlerini kontrol etmeli.${srv}`;
  }
  if (d === 'timeout') {
    return `⚠️ **FiveM sunucusu zamanında cevap vermedi.**\nSunucu geç yanıt veriyor olabilir. Lütfen biraz bekleyip tekrar deneyin.${srv}`;
  }
  if (d === 'connection_refused' || d === 'dns_error' || d === 'connection_reset' || d === 'unreachable') {
    return `❌ **FiveM sunucusuna bağlanılamadı.**${srv}\n\nDurum:\n🔴 Ulaşılamıyor`;
  }
  if (d === 'forbidden') {
    return `🔒 **FiveM sunucusu oyuncu endpointine erişimi engelliyor (403).**${srv}\n\nSunucuda \`sv_requestParanoia\` 2+ olabilir veya liste kısıtlıdır. Sunucu yetkilisiyle görüşün.`;
  }
  if (d === 'not_found') {
    return `⚠️ **FiveM sorgu endpointi bulunamadı (404).**${srv}\n\nBir yetkili \`FIVEM_SERVER_PORT\` değerini kontrol etmeli.`;
  }
  if (d === 'rate_limited') {
    return `⏳ **FiveM sunucusu çok fazla istek aldı (429).**\nLütfen biraz bekleyip tekrar deneyin.${srv}`;
  }
  if (d === 'server_error' || d === 'bad_status') {
    return `🔴 **FiveM sunucusu hata döndürdü (5xx).**${srv}\n\nLütfen daha sonra tekrar deneyin.`;
  }
  if (d === 'invalid_json' || d === 'invalid_players') {
    return `⚠️ **FiveM sunucusundan geçersiz oyuncu verisi geldi.**${srv}\n\nSunucu beklenmedik formatta cevap verdi.`;
  }
  if (d === 'anonymized') {
    return `🔒 **Oyuncu listesi anonimleştirilmiş.**${srv}\n\nGerçek liste için \`sv_playersToken\` + \`FIVEM_PLAYERS_TOKEN\` gerekir.`;
  }
  // --- RCON detayları (§16, §38) ---
  if (d === 'not_configured') {
    return '⚠️ **FiveM sorgusu yapılandırılmamış.**\nRCON parolası eksik — sunucu sahibi `FIVEM_RCON_PASSWORD` değerini eklemeli (`set rcon_password` + `ensure rconlog`).';
  }
  if (d === 'rcon_timeout') {
    return '⚠️ **FiveM sorgusu gerçekleştirilemedi.**\nReason:\nRCON connection timeout.';
  }
  if (d === 'rcon_unreachable') {
    return `❌ **FiveM sunucusuna ulaşılamıyor (RCON/UDP).**${srv}\n\nReason:\nRCON unreachable.`;
  }
  if (d === 'server_offline') {
    return `🔴 **FiveM sunucusu kapalı görünüyor (RCON/UDP).**${srv}\n\nReason:\nServer offline / port kapalı.`;
  }
  if (d === 'auth_failed') {
    return '🔒 **RCON kimlik doğrulama başarısız.**\nParola yanlış olabilir veya sunucuda `rconlog` eksik. Sunucu sahibi kontrol etmeli.';
  }
  if (d === 'malformed' || d === 'rcon_error') {
    return '⚠️ **FiveM sunucusundan geçersiz RCON yanıtı geldi.**\nLütfen daha sonra tekrar deneyin.';
  }
  return `🔴 **FiveM sunucusu offline**\nSunucuya şu anda erişilemiyor. Lütfen daha sonra tekrar deneyin.${srv}`;
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
      serverReported: session.serverReported,
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
      serverReported: session.serverReported,
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

/** "http://5.231.120.202:30120" / "udp://..." → "5.231.120.202:30120" (görüntü için). */
function shortBase(base) {
  if (!base) return null;
  return String(base).replace(/^(https?|udp):\/\//i, '').replace(/\/+$/, '');
}

/** Tek oyuncu satırı: "**3. Name**\nID: 12 • Ping: 31ms" */
function playerLine(globalIndex, player) {
  return `**${globalIndex}. ${player.name}**\nID: ${player.id} • Ping: ${fmtPing(player.ping)}`;
}

/** /id bulundu (§23: Server + FiveM alanları dahil) */
function buildPlayerEmbed({ player, hostname, onlineCount, maxClients, latencyMs, base }) {
  const embed = baseEmbed(ONLINE_GREEN)
    .setTitle('🎮 FIVE M OYUNCU SORGUSU')
    .setDescription(
      `👤 **${player.name}**\n\n${serverLine(hostname)}\n🟢 **Durum:** Aktif`,
    )
    .addFields(
      { name: '🆔 Server ID', value: `\`${player.id}\``, inline: true },
      { name: '🏓 Ping', value: fmtPing(player.ping), inline: true },
      { name: '👥 Sunucu', value: fmtCount(onlineCount, maxClients), inline: true },
      { name: '⏱️ Sorgu', value: `${latencyMs}ms`, inline: true },
    );
  const sb = shortBase(base);
  if (sb) embed.addFields({ name: '🌐 Server', value: `\`${sb}\``, inline: true });
  embed.addFields({ name: 'FiveM', value: `\`${config.fivem.cfxId}\``, inline: true });
  return embed;
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
function buildPlayerListEmbed({ kind, title, headerLines, players, page, totalPages, total, startIndex, onlineCount, maxClients, latencyMs, serverReported }) {
  const lines = players.map((p, i) => playerLine(startIndex + i + 1, p));
  const head = [...headerLines, `📄 Sayfa **${page} / ${totalPages}** • Toplam **${total}**`].join('\n');
  const body = lines.length ? lines.join('\n\n') : '*Bu sayfada oyuncu yok.*';
  const embed = baseEmbed(FIVEM_ORANGE).setTitle(title).setDescription(`${head}\n\n────────────────\n\n${body}`);
  if (kind === 'players') {
    embed.addFields({ name: '👥 Aktif', value: fmtCount(onlineCount, maxClients), inline: true });
    // dynamic.json farklı sayı bildirirse küçük bilgi satırı (§31) — liste her zaman players.json'dandır.
    if (serverReported !== null && serverReported !== undefined && serverReported !== onlineCount) {
      embed.addFields({ name: '📡 Sunucu Bildirimi', value: `${serverReported}`, inline: true });
    }
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

/**
 * /fivemstatus debug embed'i (§27). Teknik detay içerir (sadece yetkililere gösterilir).
 * @param {object} h getEndpointHealth() sonucu
 */
/**
 * /fivemstatus debug embed'i (§14, §27): RCON (PRIMARY) + direct HTTP (bağımsız).
 * Parola ASLA gösterilmez — sadece CONFIGURED/NOT SET.
 */
function buildStatusEmbed(h) {
  const r = h.rcon || {};
  const t = r.test || null;
  const rconLine = !r.configured
    ? '❌ NOT CONFIGURED'
    : !t
      ? '—'
      : t.ok
        ? `✅ CONNECTED (${t.ms}ms)`
        : `❌ ${t.error || t.kind || '?'} (${t.ms}ms)`;
  const statusLine = !r.configured
    ? '❌ NO PASSWORD'
    : !t
      ? '—'
      : t.ok
        ? '✅ OK'
        : `❌ ${t.error || t.kind || '?'}`;
  const ep = (e) => {
    if (!e) return '—';
    if (e.ok) return `✅ HTTP ${e.status} (${e.ms}ms)`;
    return `❌ ${e.error || e.kind || '?'}${e.status ? ` (HTTP ${e.status})` : ''} (${e.ms}ms)`;
  };
  const http = h.http || {};
  const queryEmoji =
    h.queryStatus === 'LIVE'
      ? '🟢 ONLINE'
      : h.queryStatus === 'ANONYMIZED'
        ? '🟡 ANONYMIZED'
        : '🔴 OFFLINE/ERROR';
  const lines = [
    `**CFX:** \`${h.cfxId || config.fivem.cfxId}\``,
    `**RCON Host:** \`${r.host || '?'}\``,
    `**RCON Port:** \`${r.port || '?'}\``,
    `**Transport:** \`UDP\``,
    '',
    '────────────────',
    '',
    `**RCON:** ${rconLine}`,
    `**STATUS:** ${statusLine}`,
    `**Players:** ${t && typeof t.players === 'number' ? t.players : '—'}`,
    `**Latency:** ${typeof h.ms === 'number' ? h.ms : '—'}ms`,
    `**Query Source:** 🟢 RCON STATUS`,
    `**Password:** ${r.configured ? '✅ CONFIGURED' : '❌ NOT SET'}`,
    '',
    '────────────────',
    '',
    `**Direct HTTP:** ${http.base ? `\`${String(http.base).replace(/^https?:\/\//i, '')}\`` : '—'}`,
    `**Info:** ${ep(http.endpoints?.['/info.json'])}`,
    `**Dynamic:** ${ep(http.endpoints?.['/dynamic.json'])}`,
    `**Players:** ${ep(http.endpoints?.['/players.json'])}`,
    '',
    `**Query:** ${queryEmoji}${h.queryDetail && h.queryDetail !== 'init' ? ` (${h.queryDetail})` : ''}`,
  ];
  const okAll = t?.ok;
  return baseEmbed(okAll ? ONLINE_GREEN : OFFLINE_RED)
    .setTitle('🎮 FiveM Query Status')
    .setDescription(lines.join('\n'));
}

/** ANONYMIZED: liste placeholder — gerçek isimler için token gerekir (§26). Public sonuç embed'i. */
function buildAnonymizedEmbed({ hostname, onlineCount, maxClients, latencyMs, base }) {
  const sb = shortBase(base);
  return baseEmbed(FIVEM_ORANGE)
    .setTitle('🎮 AKTİF OYUNCULAR')
    .setDescription(
      `${serverLine(hostname)}\n🟢 **Sunucu Online** — 👥 **${fmtCount(onlineCount, maxClients)}**\n\n` +
        '🔒 **Oyuncu listesi anonimleştirilmiş (`PUBLIC_ANONYMIZED`).**\n' +
        'Sunucu gerçek oyuncu isimlerini herkese açık vermiyor.\n' +
        'Gerçek liste için sunucuda `sv_playersToken` yapılandırılıp bota `FIVEM_PLAYERS_TOKEN` olarak eklenmeli.' +
        (sb ? `\n\nSunucu:\n\`${sb}\`` : ''),
    )
    .addFields({ name: '⏱️ Sorgu', value: `${latencyMs}ms`, inline: true });
}

module.exports = {
  FIVEM_ORANGE,
  ONLINE_GREEN,
  OFFLINE_RED,
  fmtPing,
  fmtCount,
  playerLine,
  shortBase,
  buildPlayerEmbed,
  buildPlayerNotFoundEmbed,
  buildPlayerListEmbed,
  playersHeader,
  tagHeader,
  buildTagEmptyEmbed,
  buildOnlineEmptyEmbed,
  buildListUnavailableEmbed,
  buildAnonymizedEmbed,
  buildPaginationRow,
  errorTextFor,
  buildPagedPayload,
  buildStatusEmbed,
};
