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
const rcon = require('./rcon');
const rconParser = require('./rconParser');

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

/** Geliştirici logu: URL (redakte), süre, status, kind, snippet. Token ASLA yazılmaz. */
function logFetchError(where, base, path, r) {
  const url = client.redactUrl(`${base}${path}`);
  const extra = r.snippet ? ` | body: ${JSON.stringify(r.snippet)}` : '';
  logger.warn(
    `FiveM ${where} başarısız → ${client.describeKind(r.kind, r.status)} | URL: ${url} | ` +
      `Elapsed: ${r.ms}ms | HTTP: ${r.status ?? '-'}${extra}`,
  );
}

// Negatif sonuç önbelleği: OFFLINE/ERROR bu süre boyunca hedefe tekrar
// sorulmadan aynı mesajla döner (komut spam'i karşı tarafı yormaz).
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

/** RCON status metninden hostname çıkarmaya çalışır (yoksa null). */
function extractRconHostname(text) {
  try {
    const m = String(text || '').match(/^hostname\s*:\s*(.+?)\s*$/im);
    if (m && m[1]) return m[1].trim().slice(0, 128) || null;
  } catch {}
  return null;
}

/** RCON kind → { status, detail } eşlemesi (§16). */
function mapRconKind(kind) {
  switch (kind) {
    case 'timeout':
      return { status: 'OFFLINE', detail: 'rcon_timeout' };
    case 'unreachable':
    case 'dns_error':
      return { status: 'OFFLINE', detail: 'rcon_unreachable' };
    case 'server_offline':
      return { status: 'OFFLINE', detail: 'server_offline' };
    case 'auth_failed':
      return { status: 'ERROR', detail: 'auth_failed' };
    case 'malformed':
      return { status: 'ERROR', detail: 'malformed' };
    case 'not_configured':
    case 'bad_password':
      return { status: 'ERROR', detail: 'not_configured' };
    default:
      return { status: 'ERROR', detail: 'rcon_error' };
  }
}

/**
 * Tam sunucu sorgusu — PRIMARY: RCON (UDP) `status` (§1).
 * HTTP player endpointlerine düşülmez (§32). Asla throw etmez.
 * İmza eskisiyle aynıdır → /id, /tag, /aktifoyuncular değişmeden çalışır.
 */
async function queryServer() {
  const t0 = Date.now();
  const rHost = String(config.fivem.rcon.host || '').trim() || '5.231.120.202';
  const rPort = Number(config.fivem.rcon.port) || 30120;
  const rBase = `udp://${rHost}:${rPort}`;
  // Negatif önbellek: kısa süre önce başarısız olan hedefe tekrar sorulmaz.
  const neg = negCached(rBase);
  if (neg) return neg;

  const baseOut = {
    players: null, playersSkipped: 0, dynamic: null, info: null,
    hostname: null, onlineCount: null, maxClients: null, serverReported: null,
    latencyMs: 0, base: rBase, baseSource: 'rcon_status',
  };
  const fail = (status, detail, lastError) => {
    const out = { ...baseOut, status, detail, latencyMs: Date.now() - t0 };
    setHealth({ status, detail, players: 0, latencyMs: out.latencyMs, source: 'rcon_status', base: rBase, lastError });
    negStore(rBase, out);
    return out;
  };

  // Parola yoksa RCON kapalıdır (FiveM kuralı) → ağa hiç çıkmadan dürüst hata.
  if (!config.fivem.rcon.password) {
    logger.warn('FiveM RCON parolası yok (FIVEM_RCON_PASSWORD) — oyuncu sorgusu yapılamıyor.');
    return fail('ERROR', 'not_configured', 'RCON_NOT_CONFIGURED');
  }

  let r = null;
  try {
    r = await rcon.status();
  } catch (err) {
    logger.error('RCON status beklenmedik hata.', err);
    return fail('ERROR', 'rcon_error', 'RCON_EXCEPTION');
  }
  const latencyMs = Date.now() - t0;

  if (!r.ok) {
    const m = mapRconKind(r.kind);
    // Geliştirici logu: host/port/command/latency/error — PAROLA YOK (§38).
    logger.warn(
      `FiveM RCON başarısız → ${r.kind} | Host: ${rHost} | Port: ${rPort} | ` +
        `Transport: UDP | Command: status | Elapsed: ${r.ms}ms`,
    );
    const out = { ...baseOut, status: m.status, detail: m.detail, latencyMs };
    setHealth({ status: m.status, detail: m.detail, players: 0, latencyMs, source: 'rcon_status', base: rBase, lastError: `RCON_${r.kind.toUpperCase()}` });
    negStore(rBase, out);
    return out;
  }

  // Başarılı yanıt → parse. Boş yanıt = 0 oyunculu LIVE (TEST 9).
  const parsed = rconParser.parseStatus(r.text || '');
  const hostname = extractRconHostname(r.text) || `CFX ${config.fivem.cfxId}`;
  if (parsed.anonymized) {
    const out = {
      ...baseOut, status: 'ANONYMIZED', detail: 'anonymized', players: [],
      hostname, onlineCount: 0, latencyMs,
    };
    setHealth({ status: 'ANONYMIZED', detail: 'anonymized', players: 0, latencyMs, source: 'rcon_status', base: rBase, lastError: 'PUBLIC_ANONYMIZED' });
    return out;
  }
  const out = {
    ...baseOut, status: 'LIVE', detail: 'ok', players: parsed.players, playersSkipped: parsed.skipped,
    hostname, onlineCount: parsed.players.length, latencyMs,
  };
  setHealth({ status: 'LIVE', detail: 'ok', players: parsed.players.length, latencyMs, source: 'rcon_status', base: rBase });
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

// ---------- Tekil kaynak getter'ları (§26) ----------

/** HTTP teşhis bazı (RCON'dan bağımsız — §33). */
async function currentBase() {
  const { primary } = client.resolveBases();
  return primary || { base: null, source: null };
}

/** Oyuncu listesi — RCON `status` üzerinden (§26 getPlayers). */
async function getPlayers() {
  const q = await queryServer();
  if (q.status !== 'LIVE') return { ok: false, kind: q.detail, players: [], skipped: 0 };
  return { ok: true, kind: 'ok', players: q.players, skipped: q.playersSkipped };
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
 * Birleşik sağlık (/fivemstatus + geliştirici teşhisi, §14):
 * RCON (UDP) testi + direct HTTP teşhisi BİRBİRİNDEN BAĞIMSIZ (§33).
 */
async function getEndpointHealth() {
  const t0 = Date.now();
  const rHost = String(config.fivem.rcon.host || '').trim() || '5.231.120.202';
  const rPort = Number(config.fivem.rcon.port) || 30120;

  // RCON testi (password yoksa ağa çıkılmaz).
  let rconHealth = {
    host: rHost, port: rPort, transport: 'UDP', configured: !!config.fivem.rcon.password,
    test: null,
  };
  if (rconHealth.configured) {
    try {
      const r = await rcon.status();
      let players = null;
      if (r.ok) {
        const parsed = rconParser.parseStatus(r.text || '');
        players = parsed.ok && !parsed.anonymized ? parsed.players.length : parsed.anonymized ? 0 : null;
      }
      rconHealth.test = {
        ok: r.ok, kind: r.kind, ms: r.ms, players,
        error: r.ok ? null : r.kind.toUpperCase(),
      };
    } catch (err) {
      rconHealth.test = { ok: false, kind: 'rcon_error', ms: Date.now() - t0, players: null, error: 'EXCEPTION' };
      logger.error('RCON health testi hata.', err);
    }
  }

  // Direct HTTP teşhisi (bağımsız — oyuncu sorgusunu ETKİLEMEZ).
  const { base, source } = await currentBase();
  let http = { base, source, host: null, port: null, dns: null, tcp: null, endpoints: {} };
  if (base) {
    const diag = await client.diagnoseBase(base);
    http = { ...diag, source };
  }

  const h = getHealth();
  return {
    cfxId: config.fivem.cfxId,
    rcon: rconHealth,
    http,
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
