/**
 * FiveM HTTP istemcisi — doğrudan oyun sunucusu endpointleri (/players.json,
 * /dynamic.json, /info.json).
 *
 * Kurallar (kullanıcı spec'i):
 * - PRIMARY her zaman host:port'tur (varsayılan 5.231.120.202:30120). IP/port ASLA
 *   tahmin edilmez, rastgele port taranmaz, başka API'ye düşülmez (§2, §3, §16, §17, §35).
 * - CFX ID sadece metadata'dır (footer/link); oyuncu verisi için kullanılmaz (§14).
 *   HTML scraping YOKTUR (§15).
 * - Hata ayrımı kesindir: refused/timeout/dns/reset/403/429/5xx/bozuk-JSON birbirine
 *   karıştırılmaz, hepsi "timeout" diye gösterilmez (§9, §30).
 * - sv_playersToken varsa X-Players-Token header ile gönderilir; token ASLA loga,
 *   URL'e, embed'e yazılmaz (§12, §29).
 * - Hassas alanlar (endpoint/identifiers) bu katmanda taşınır ama parser'dan
 *   geçmeden Discord'a çıkmaz (§13, §33).
 */
const dns = require('dns').promises;
const net = require('net');
const { fetch, Agent } = require('undici');
const config = require('../../config');
const logger = require('../../utils/logger');
const { isNetworkError } = require('../../utils/restTransport');
const parser = require('./parser');

const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 2; // ilk deneme + 1 kontrollü retry (sadece geçici ağ hatalarında, §20)
const BODY_SNIPPET_LEN = 120;

// Sadece bu türlerde retry yapılır. refused/dns/403/404/429/bozuk-JSON kalıcıdır.
const RETRYABLE = new Set(['timeout', 'unreachable', 'connection_reset', 'server_error']);

function agent() {
  const t = Math.min(config.fivem.apiTimeoutMs, 15000);
  return new Agent({ connect: { ALPNProtocols: ['http/1.1'], timeout: t } });
}

function headers() {
  const h = { 'User-Agent': 'JavrexBotSystem/1.0 (+discord-bot)', Accept: 'application/json' };
  const token = config.fivem.playersToken;
  if (token) h['X-Players-Token'] = token; // header-only; URL'e ASLA konmaz (§12)
  return h;
}

/** Loglanacak URL'lerdeki token parametresini redakte eder (§29). Savunma amaçlıdır (token zaten URL'e konmaz). */
function redactUrl(url) {
  try {
    return String(url).replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]');
  } catch {
    return '[url]';
  }
}

/** Hata zincirindeki tüm kodları toplar (undici cause iç içe olabilir). */
function collectCodes(err, depth = 0) {
  const out = [];
  let cur = err;
  while (cur && depth < 6) {
    if (cur.code) out.push(String(cur.code));
    cur = cur.cause;
    depth++;
  }
  return out;
}

function classifyFetchError(err) {
  const msg = String(err?.message || '');
  if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(msg)) return 'timeout';
  const codes = collectCodes(err);
  if (codes.includes('ECONNREFUSED')) return 'connection_refused';
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) return 'dns_error';
  if (codes.includes('ECONNRESET')) return 'connection_reset';
  if (isNetworkError(err) || isNetworkError(err?.cause)) return 'unreachable';
  return 'unreachable';
}

// Aynı anda devam eden istekler birleştirilir (§21: 10 kullanıcı → 1 FiveM isteği).
const inflight = new Map();

// Endpoint bazında ayrı önbellek (anahtar URL; TTL kaynağa göre — §32).
// players TTL'i daha kısadır (FIVEM_PLAYERS_CACHE_TTL_MS).
const cache = new Map(); // key -> { at, ttl, value }

function ttlFor(key) {
  if (key.endsWith('/players.json')) return config.fivem.playersCacheTtlMs;
  return config.fivem.cacheTtlMs;
}

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > e.ttl) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), ttl: ttlFor(key), value });
  if (cache.size > 30) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function coalesce(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/**
 * Ham JSON GET. Tek deneme; sınıflandırılmış sonuç döner (asla throw etmez).
 * kind: ok | timeout | connection_refused | dns_error | connection_reset | unreachable
 *       | forbidden | not_found | rate_limited | server_error | bad_status | invalid_json
 */
async function fetchJsonOnce(url, { timeoutMs } = {}) {
  const t0 = Date.now();
  const timeout = timeoutMs || config.fivem.apiTimeoutMs;
  let res = null;
  try {
    res = await fetch(url, { dispatcher: agent(), signal: AbortSignal.timeout(timeout), headers: headers() });
  } catch (err) {
    return { ok: false, kind: classifyFetchError(err), status: null, data: null, ms: Date.now() - t0, snippet: null };
  }
  const ms = Date.now() - t0;
  const status = res.status;
  if (status !== 200) {
    // Hata gövdesini log için kısaca yakala (örn. "Nope." → sv_requestParanoia işareti, §11).
    // Body consumer tarafından okunmazsa bağlantı havuzu kirlenir; o yüzden tüketilir.
    let snippet = null;
    try {
      const text = await res.text();
      if (text && text.trim()) snippet = text.trim().slice(0, BODY_SNIPPET_LEN);
    } catch {
      /* body okunamadı — önemli değil */
    }
    if (status === 403) return { ok: false, kind: 'forbidden', status, data: null, ms, snippet };
    if (status === 404) return { ok: false, kind: 'not_found', status, data: null, ms, snippet };
    if (status === 429) return { ok: false, kind: 'rate_limited', status, data: null, ms, snippet };
    if (status >= 500) return { ok: false, kind: 'server_error', status, data: null, ms, snippet };
    return { ok: false, kind: 'bad_status', status, data: null, ms, snippet };
  }
  try {
    const data = await res.json();
    return { ok: true, kind: 'ok', status, data, ms, snippet: null };
  } catch {
    return { ok: false, kind: 'invalid_json', status, data: null, ms, snippet: null };
  }
}

/** Kontrollü retry: en fazla MAX_ATTEMPTS deneme, sadece geçici hatalarda (§20). */
async function fetchJson(url, { attempts = MAX_ATTEMPTS, timeoutMs } = {}) {
  let last = null;
  const n = Math.min(Math.max(1, attempts || 1), 3);
  for (let attempt = 1; attempt <= n; attempt++) {
    last = await fetchJsonOnce(url, { timeoutMs });
    if (last.ok || !RETRYABLE.has(last.kind)) return last;
    if (attempt < n) {
      logger.warn(`FiveM istek başarısız (${last.kind}), kısa retry: ${redactUrl(url)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return last;
}

/** "host:port"u doğrulanmış http(s) taban adresine çevirir. Bozuksa null (sorgu iptal, §2). */
function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u = null;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!/^[A-Za-z0-9.-]+$/.test(u.hostname)) return null;
  const port = u.port ? Number(u.port) : 30120;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${u.protocol}//${u.hostname}:${port}`;
}

function baseParts(base) {
  try {
    const u = new URL(base);
    return { host: u.hostname, port: Number(u.port) || 30120 };
  } catch {
    return { host: null, port: null };
  }
}

async function getResource(base, path, opts) {
  const key = `${base}${path}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const r = await coalesce(key, () => fetchJson(`${base}${path}`, opts));
  const out = { ...r, cached: false };
  if (r.ok) cacheSet(key, out);
  return out;
}

const getPlayersRaw = (base, opts) => getResource(base, '/players.json', opts);
const getDynamicRaw = (base, opts) => getResource(base, '/dynamic.json', opts);
const getInfoRaw = (base, opts) => getResource(base, '/info.json', opts);

// ---------- Katmanlı teşhis: DNS → TCP → HTTP → JSON (§38, §39) ----------

async function checkDns(host, timeoutMs = 5000) {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      dns.lookup(host),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('DNS_TIMEOUT'), { code: 'ETIMEOUT' })), timeoutMs)),
    ]);
    return { ok: true, ms: Date.now() - t0, address: r.address, error: null };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, address: null, error: err?.code || err?.message || 'DNS_ERROR' };
  }
}

async function checkTcp(host, port, timeoutMs = 5000) {
  const t0 = Date.now();
  return new Promise((res) => {
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {}
      res({ ok, ms: Date.now() - t0, error });
    };
    const s = net.connect(port, host);
    const timer = setTimeout(() => finish(false, 'ETIMEDOUT'), timeoutMs);
    s.on('connect', () => {
      clearTimeout(timer);
      finish(true, null);
    });
    s.on('timeout', () => {
      clearTimeout(timer);
      finish(false, 'ETIMEDOUT');
    });
    s.on('error', (e) => {
      clearTimeout(timer);
      finish(false, e.code || e.message);
    });
  });
}

/**
 * Taban adres için katmanlı teşhis. Asla throw etmez.
 * @returns {Promise<{base,host,port,dns,tcp,endpoints:{info,dynamic,players}}>}
 */
async function diagnoseBase(base, { timeoutMs } = {}) {
  const { host, port } = baseParts(base);
  const t = timeoutMs || config.fivem.apiTimeoutMs;
  const diag = { base, host, port, dns: null, tcp: null, endpoints: {} };
  if (!host || !port) {
    const err = 'BAD_BASE';
    diag.dns = { ok: false, ms: 0, address: null, error: err };
    diag.tcp = { ok: false, ms: 0, error: 'NOT_REACHED' };
    for (const p of ['/info.json', '/dynamic.json', '/players.json']) {
      diag.endpoints[p] = { ok: false, status: null, ms: 0, kind: 'not_reached', error: 'NOT_REACHED', snippet: null };
    }
    return diag;
  }
  diag.dns = await checkDns(host, Math.min(t, 5000));
  diag.tcp = await checkTcp(host, port, Math.min(t, 5000));
  // HTTP katmanı: 3 endpoint paralel, tek deneme (teşhis hızlı olmalı)
  const paths = ['/info.json', '/dynamic.json', '/players.json'];
  const results = await Promise.all(paths.map((p) => fetchJson(`${base}${p}`, { attempts: 1, timeoutMs: t })));
  paths.forEach((p, i) => {
    const r = results[i];
    diag.endpoints[p] = {
      ok: r.ok,
      status: r.status,
      ms: r.ms,
      kind: r.kind,
      error: r.ok ? null : describeKind(r.kind, r.status),
      snippet: r.snippet || null,
      summary: summarizeEndpoint(p, r.ok ? r.data : null),
    };
  });
  return diag;
}

/** Teşhis çıktısı için hafif özet (tam liste taşınmaz). */
function summarizeEndpoint(path, data) {
  try {
    if (data === null || data === undefined) return null;
    if (path === '/info.json') return parser.parseInfo(data);
    if (path === '/dynamic.json') return parser.parseDynamic(data);
    if (path === '/players.json') {
      const p = parser.parsePlayers(data);
      return p.ok ? { count: p.players.length, skipped: p.skipped } : null;
    }
  } catch {
    /* özet kritik değil */
  }
  return null;
}

/** Internal kind → kısa teknik etiket (log/teşhis için; kullanıcı mesajı değil). */
function describeKind(kind, status) {
  switch (kind) {
    case 'ok':
      return 'OK';
    case 'timeout':
      return 'ETIMEDOUT';
    case 'connection_refused':
      return 'ECONNREFUSED';
    case 'dns_error':
      return 'ENOTFOUND';
    case 'connection_reset':
      return 'ECONNRESET';
    case 'unreachable':
      return 'UNREACHABLE';
    case 'forbidden':
      return 'HTTP_403';
    case 'not_found':
      return 'HTTP_404';
    case 'rate_limited':
      return 'HTTP_429';
    case 'server_error':
      return `HTTP_${status || 500}`;
    case 'bad_status':
      return `HTTP_${status || '?'}`;
    case 'invalid_json':
      return 'INVALID_JSON';
    default:
      return String(kind || 'UNKNOWN').toUpperCase();
  }
}

/**
 * Sorgu için TEK primary + opsiyonel explicit connect fallback:
 *  - primary: FIVEM_SERVER_ENDPOINT (açık override) yoksa http://HOST:PORT.
 *  - fallback: SADECE FIVEM_CONNECT_ENDPOINT dolu ve primary'den farklıysa,
 *    ve SADECE primary ağ-hatası (timeout/refused/dns/reset/unreachable) verirse denenir.
 * Asla başka sunucuya düşülmez: explicit endpoint varken default host'a
 * fallback YAPILMAZ (§2, §35).
 * CFX discovery/list API hot path'te YOKTUR (§14, §15).
 */
function resolveBases() {
  let primary = null;
  const ep = normalizeBase(config.fivem.endpoint);
  if (ep) {
    primary = { base: ep, source: 'config_endpoint' };
  } else {
    const host = String(config.fivem.host || '').trim();
    const port = Number(config.fivem.port) || 30120;
    if (/^[A-Za-z0-9.-]+$/.test(host) && Number.isInteger(port) && port >= 1 && port <= 65535) {
      primary = { base: `http://${host}:${port}`, source: 'host_port' };
    }
  }
  let fallback = null;
  const ce = normalizeBase(config.fivem.connectEndpoint);
  if (ce && (!primary || ce !== primary.base)) fallback = { base: ce, source: 'connect_endpoint' };
  return { primary, fallback };
}

module.exports = {
  fetchJson,
  normalizeBase,
  baseParts,
  redactUrl,
  classifyFetchError,
  describeKind,
  resolveBases,
  getPlayersRaw,
  getDynamicRaw,
  getInfoRaw,
  diagnoseBase,
  checkDns,
  checkTcp,
  _cache: cache,
  _inflight: inflight,
};
