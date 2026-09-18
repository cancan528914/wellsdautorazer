/**
 * FiveM sorgu servisi — komutların tek giriş noktası (§26).
 *
 * queryServer() akışı:
 *   aday bazlar (endpoint > host:port > connect_endpoint) → players.json (zorunlu,
 *   sıralı ilk istek) → dynamic.json (best-effort ikinci istek: hostname/sayı).
 *   info.json hot path'te çağrılmaz (embed'lerde kullanılmıyor); /fivemstatus
 *   teşhisinde kontrol edilir.
 *
 * Durumlar (internal): LIVE | PARTIAL | OFFLINE | ERROR (+ STALE takibi health'te)
 * - LIVE:    players.json taze ve geçerli.
 * - PARTIAL: players alınamadı AMA dynamic ile sunucu erişilebilir
 *            (403/404/429/bozuk-liste) → isim listesi yok, sayı/hostname var.
 * - OFFLINE: sunucuya ulaşılamıyor (timeout/refused/dns/reset/unreachable).
 * - ERROR:   istek reddi/bozuk veri/sunucu hatası (403/404/429/5xx/invalid).
 *
 * Başarısız taze sorguda eski önbellek BAŞARI gibi sunulmaz.
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const client = require('./client');
const parser = require('./parser');

const health = {
  status: 'UNKNOWN',
  detail: 'init',
  players: 0,
  latencyMs: null,
  source: null, // aday base kaynağı: config_endpoint | host_port | connect_endpoint
  base: null,
  updatedAt: 0,
  lastGoodAt: 0,
  lastError: null, // son hatanın teknik özeti (log/teşhis için)
};

function setHealth(next) {
  const prev = health.status;
  health.status = next.status;
  health.detail = next.detail;
  health.players = next.players ?? health.players;
  health.latencyMs = next.latencyMs ?? null;
  health.source = next.source ?? health.source;
  health.base = next.base ?? health.base;
  health.updatedAt = Date.now();
  const reachable = next.status === 'LIVE' || next.status === 'PARTIAL' || next.status === 'ANONYMIZED';
  health.lastError = next.lastError ?? (reachable ? null : health.lastError);
  if (reachable) health.lastGoodAt = Date.now();
  if (prev !== next.status) {
    const line =
      `🎮 FiveM Query Service | Status: ${prev} → ${next.status} (${next.detail}) | ` +
      `Players: ${health.players} | Latency: ${health.latencyMs ?? '-'}ms | Base: ${health.base || '-'}`;
    if (next.status === 'LIVE') logger.success(line);
    else logger.warn(line);
  }
}

// Ağ kaynaklı türler: connect fallback denemeye değer + OFFLINE sınıfı.
const NETWORK_KINDS = new Set(['timeout', 'unreachable', 'connection_refused', 'dns_error', 'connection_reset']);

/** Geliştirici logu: URL (redakte), süre, status, kind, snippet. Token ASLA yazılmaz. */
function logFetchError(where, base, path, r) {
  const url = client.redactUrl(`${base}${path}`);
  const extra = r.snippet ? ` | body: ${JSON.stringify(r.snippet)}` : '';
  logger.warn(
    `FiveM ${where} başarısız → ${client.describeKind(r.kind, r.status)} | URL: ${url} | ` +
      `Elapsed: ${r.ms}ms | HTTP: ${r.status ?? '-'}${extra}`,
  );
}

function pickHostname(dynamic, fallbackHostname) {
  return dynamic?.hostname || fallbackHostname || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Negatif sonuç önbelleği: OFFLINE/ERROR/PARTIAL bu süre boyunca sunucuya
// tekrar sorulmadan aynı mesajla döner (komut spam'i blok uzatamaz).
let lastFailure = null; // { at, base, out }

/** Base değişmedikçe taze sayılan negatif sonuç varsa döndürür. */
function negCached(base) {
  if (!lastFailure) return null;
  if (lastFailure.base !== base) return null;
  if (Date.now() - lastFailure.at > config.fivem.negCacheMs) {
    lastFailure = null;
    return null;
  }
  return lastFailure.out;
}

function negStore(base, out) {
  lastFailure = { at: Date.now(), base, out };
}

function pickMaxClients(dynamic) {
  return dynamic?.maxClients ?? null;
}

/**
 * Tam sunucu sorgusu. Asla throw etmez.
 */
async function queryServer() {
  const t0 = Date.now();
  const { primary, fallback } = client.resolveBases();
  // Negatif önbellek: kısa süre önce başarısız olan base'e tekrar sorulmaz.
  if (primary) {
    const neg = negCached(primary.base);
    if (neg) return neg;
  }
  if (!primary) {
    const out = {
      status: 'OFFLINE',
      detail: 'no_endpoint',
      players: null,
      playersSkipped: 0,
      dynamic: null,
      info: null,
      hostname: null,
      onlineCount: null,
      maxClients: null,
      serverReported: null,
      latencyMs: Date.now() - t0,
      base: null,
      baseSource: null,
    };
    setHealth({ status: 'OFFLINE', detail: 'no_endpoint', players: 0, latencyMs: out.latencyMs, source: null, base: null, lastError: 'NO_ENDPOINT' });
    return out;
  }

  // --- players.json: primary'de dene; ağ-hatası + explicit fallback varsa oraya geç ---
  const tried = [primary, ...(fallback ? [fallback] : [])];
  let pRes = null;
  let usedBase = primary.base;
  let usedSource = primary.source;
  for (const c of tried) {
    let r = null;
    try {
      r = await client.getPlayersRaw(c.base);
    } catch {
      r = { ok: false, kind: 'unreachable', status: null, ms: 0, data: null, snippet: null };
    }
    if (r.ok || !NETWORK_KINDS.has(r.kind) || c === tried[tried.length - 1]) {
      pRes = r;
      usedBase = c.base;
      usedSource = c.source;
      if (!r.ok) logFetchError('players', c.base, '/players.json', r);
      if (c !== tried[0]) logger.info(`FiveM connect fallback kullanıldı: ${c.base} (${c.source})`);
      break;
    }
    logFetchError('players', c.base, '/players.json', r);
    logger.info(`FiveM primary erişilemedi, connect fallback deneniyor (${c.source} → devam)`);
  }

  // --- dynamic.json: best-effort (LIVE metası veya PARTIAL ayrımı için) ---
  let dRes = { ok: false, kind: 'skipped', status: null, ms: 0, data: null, snippet: null };
  const needDynamic =
    pRes.ok || pRes.kind === 'forbidden' || pRes.kind === 'not_found' || pRes.kind === 'rate_limited' || pRes.kind === 'invalid_json';
  if (needDynamic && usedBase) {
    // Burst korumasına karşı pacing: art arda istekler arasına nefes payı.
    const gap = config.fivem.requestGapMs;
    if (gap > 0) await sleep(gap);
    try {
      dRes = await client.getDynamicRaw(usedBase);
    } catch {
      dRes = { ok: false, kind: 'unreachable', status: null, ms: 0, data: null, snippet: null };
    }
    if (!dRes.ok && dRes.kind !== 'skipped') logFetchError('dynamic', usedBase, '/dynamic.json', dRes);
  }
  const latencyMs = Date.now() - t0;

  const dynamic = dRes.ok ? parser.parseDynamic(dRes.data) : null;
  const hostname = pickHostname(dynamic, null);
  const maxClients = pickMaxClients(dynamic);

  const baseHealth = { latencyMs, source: usedSource, base: usedBase };

  // --- players BAŞARILI ---
  if (pRes.ok) {
    const parsed = parser.parsePlayers(pRes.data);
    // ANONYMIZED: liste placeholder (id:0/Player) → gerçek isimler için token gerekir (§26 TEST F).
    if (parsed.ok && parsed.anonymized) {
      const out = {
        status: 'ANONYMIZED', detail: 'anonymized', players: [], playersSkipped: 0,
        dynamic, info: null, hostname, onlineCount: dynamic?.clients ?? null, maxClients,
        serverReported: null, latencyMs, base: usedBase, baseSource: usedSource,
      };
      setHealth({ ...baseHealth, status: 'ANONYMIZED', detail: 'anonymized', players: dynamic?.clients ?? 0, lastError: 'PUBLIC_ANONYMIZED' });
      return out;
    }
    if (!parsed.ok) {
      const out = {
        status: 'ERROR', detail: 'invalid_players', players: null, playersSkipped: 0,
        dynamic, info: null, hostname, onlineCount: null, maxClients,
        serverReported: dynamic?.clients ?? null, latencyMs, base: usedBase, baseSource: usedSource,
      };
      setHealth({ ...baseHealth, status: 'ERROR', detail: 'invalid_players', players: 0, lastError: 'INVALID_PLAYERS_BODY' });
      negStore(primary.base, out);
      return out;
    }
    const serverReported = dynamic?.clients ?? null;
    const out = {
      status: 'LIVE', detail: 'ok', players: parsed.players, playersSkipped: parsed.skipped,
      dynamic, info: null, hostname, onlineCount: parsed.players.length, maxClients,
      serverReported: serverReported !== null && serverReported !== parsed.players.length ? serverReported : null,
      latencyMs, base: usedBase, baseSource: usedSource,
    };
    setHealth({ ...baseHealth, status: 'LIVE', detail: 'ok', players: parsed.players.length });
    return out;
  }

  // --- players BAŞARISIZ ---
  const kind = pRes.kind;
  if ((kind === 'forbidden' || kind === 'not_found' || kind === 'rate_limited' || kind === 'invalid_json') && dynamic) {
    const out = {
      status: 'PARTIAL', detail: kind, players: null, playersSkipped: 0,
      dynamic, info: null, hostname, onlineCount: dynamic.clients, maxClients,
      serverReported: null, latencyMs, base: usedBase, baseSource: usedSource,
    };
    setHealth({ ...baseHealth, status: 'PARTIAL', detail: kind, players: dynamic.clients ?? 0, lastError: client.describeKind(kind, pRes.status) });
    negStore(primary.base, out);
    return out;
  }

  const status = NETWORK_KINDS.has(kind) ? 'OFFLINE' : 'ERROR';
  const out = {
    status, detail: kind, players: null, playersSkipped: 0,
    dynamic, info: null, hostname, onlineCount: dynamic?.clients ?? null, maxClients,
    serverReported: null, latencyMs, base: usedBase, baseSource: usedSource,
  };
  setHealth({ ...baseHealth, status, detail: kind, players: 0, lastError: `${client.describeKind(kind, pRes.status)} @ ${usedBase}` });
  negStore(primary.base, out);
  return out;
}

/** FiveM server ID ile oyuncu bul. Asla throw etmez. */
async function findPlayerById(id) {
  const q = await queryServer();
  if (q.status !== 'LIVE') return { found: false, query: q, player: null };
  const player = parser.findById(q.players, id);
  return { found: !!player, query: q, player: player || null };
}

/** İsimde geçen terimle oyuncu ara (case-insensitive substring). Asla throw etmez. */
async function searchPlayers(term) {
  const q = await queryServer();
  if (q.status !== 'LIVE') return { query: q, term, matches: [] };
  const matches = parser.searchByName(q.players, term);
  return { query: q, term, matches };
}

/** ANONYMIZED durumu için kullanıcı metni (§26: token yönlendirmesi). */
function anonymizedText(base) {
  const b = base ? String(base).replace(/^https?:\/\//i, '').replace(/\/+$/, '') : null;
  return (
    `🔒 **Oyuncu listesi anonimleştirilmiş.**${b ? `\n\nSunucu:\n\`${b}\`` : ''}\n\n` +
    'Sunucu gerçek oyuncu isimlerini herkese açık vermiyor (`PUBLIC_ANONYMIZED`).\n' +
    'Gerçek liste için sunucuda `sv_playersToken` yapılandırılıp bota `FIVEM_PLAYERS_TOKEN` olarak eklenmeli.'
  );
}

// ---------- Tekil kaynak getter'ları (§26) — önbellek farkında ----------

async function currentBase() {
  const { primary } = client.resolveBases();
  return primary || { base: null, source: null };
}

async function getPlayers() {
  const { base } = await currentBase();
  if (!base) return { ok: false, kind: 'no_endpoint', players: [], skipped: 0 };
  let r = null;
  try {
    r = await client.getPlayersRaw(base);
  } catch {
    r = { ok: false, kind: 'unreachable' };
  }
  if (!r.ok) {
    logFetchError('players', base, '/players.json', r);
    return { ok: false, kind: r.kind, players: [], skipped: 0 };
  }
  const parsed = parser.parsePlayers(r.data);
  return { ok: parsed.ok, kind: parsed.ok ? 'ok' : 'invalid_players', players: parsed.players, skipped: parsed.skipped };
}

async function getDynamic() {
  const { base } = await currentBase();
  if (!base) return { ok: false, kind: 'no_endpoint', dynamic: null };
  let r = null;
  try {
    r = await client.getDynamicRaw(base);
  } catch {
    r = { ok: false, kind: 'unreachable' };
  }
  if (!r.ok) {
    logFetchError('dynamic', base, '/dynamic.json', r);
    return { ok: false, kind: r.kind, dynamic: null };
  }
  return { ok: true, kind: 'ok', dynamic: parser.parseDynamic(r.data) };
}

async function getInfo() {
  const { base } = await currentBase();
  if (!base) return { ok: false, kind: 'no_endpoint', info: null };
  let r = null;
  try {
    r = await client.getInfoRaw(base);
  } catch {
    r = { ok: false, kind: 'unreachable' };
  }
  if (!r.ok) {
    logFetchError('info', base, '/info.json', r);
    return { ok: false, kind: r.kind, info: null };
  }
  return { ok: true, kind: 'ok', info: parser.parseInfo(r.data) };
}

/**
 * Katmanlı endpoint sağlığı (/fivemstatus + geliştirici teşhisi).
 * DNS → TCP → HTTP(info/dynamic/players) + JSON parse, hepsi ayrı raporlanır.
 */
async function getEndpointHealth() {
  const { base, source } = await currentBase();
  if (!base) {
    return { base: null, source: null, host: null, port: null, dns: null, tcp: null, endpoints: {}, ms: 0 };
  }
  const t0 = Date.now();
  const diag = await client.diagnoseBase(base);
  const h = getHealth();
  return {
    ...diag,
    source,
    ms: Date.now() - t0,
    tokenConfigured: !!config.fivem.playersToken,
    queryStatus: h.status,
    queryDetail: h.detail,
  };
}

function getHealth() {
  const stale = health.lastGoodAt > 0 && Date.now() - health.lastGoodAt > config.fivem.cacheTtlMs * 3;
  return { ...health, stale, cfxId: config.fivem.cfxId, host: config.fivem.host, port: config.fivem.port };
}

module.exports = {
  queryServer,
  findPlayerById,
  searchPlayers,
  getPlayers,
  getDynamic,
  getInfo,
  getEndpointHealth,
  getHealth,
  anonymizedText,
  _resetNegCache: () => {
    lastFailure = null;
  },
  STATUS: { LIVE: 'LIVE', PARTIAL: 'PARTIAL', OFFLINE: 'OFFLINE', ERROR: 'ERROR', STALE: 'STALE', ANONYMIZED: 'ANONYMIZED' },
};
