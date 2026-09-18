/**
 * FiveM HTTP istemcisi — doğrudan oyun sunucusu endpointleri (/players.json,
 * /dynamic.json, /info.json) + CFX kodundan endpoint çözümleme.
 *
 * Kurallar:
 * - Canlı veri HER ZAMAN doğrudan oyun sunucusundan alınır.
 * - Server-list API'si (frontend.cfx-services.net — resmi SPA'nın kullandığı host)
 *   SADECE IP:port çözümleme için kullanılır; FIVEM_SERVER_ENDPOINT doluysa hiç çağrılmaz.
 * - IP/port ASLA tahmin edilmez (spec §2). Çözülemezse NO_ENDPOINT döner.
 * - Hassas alanlar (endpoint/identifiers) bu katmanda taşınır ama ASLA Discord'a çıkarılmaz;
 *   parser sadece id/name/ping geçirir.
 */
const { fetch, Agent } = require('undici');
const config = require('../../config');
const logger = require('../../utils/logger');
const { isNetworkError } = require('../../utils/restTransport');

const SINGLE_API = 'https://frontend.cfx-services.net/api/servers/single/';
const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 2; // ilk deneme + 1 kontrollü retry (sadece ağ/timeout hatalarında)

function agent() {
  const t = Math.min(config.fivem.apiTimeoutMs, 15000);
  return new Agent({ connect: { ALPNProtocols: ['http/1.1'], timeout: t } });
}

// Aynı anda devam eden istekler birleştirilir (spec §25-26: 10 kişi aynı komutu
// kullanırsa FiveM'e 1 istek gider, 10 Discord cevabı aynı sonucu paylaşır).
const inflight = new Map();

// Kaynak bazında kısa ömürlü önbellek (TTL: FIVEM_CACHE_TTL_MS, varsayılan 4sn)
const cache = new Map(); // key -> { at, value }

/** Endpoint çözümleme sonucu (uzun ömürlü): { base, snapshot } */
let resolvedCache = { at: 0, base: null, snapshot: null };

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > config.fivem.cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 20) {
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
 * @returns {Promise<{ok:boolean, kind:string, status:number|null, data:any, ms:number}>}
 * kind: ok | timeout | unreachable | forbidden | not_found | rate_limited | server_error | bad_status | invalid_json
 */
async function fetchJsonOnce(url) {
  const t0 = Date.now();
  const timeoutMs = config.fivem.apiTimeoutMs;
  let res = null;
  try {
    res = await fetch(url, {
      dispatcher: agent(),
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'JavrexBotSystem/1.0 (+discord-bot)', Accept: 'application/json' },
    });
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = String(err?.message || '');
    if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(msg)) {
      return { ok: false, kind: 'timeout', status: null, data: null, ms };
    }
    // Ağ hatası sınıflandırması merkezi helper ile tutarlı (cause zinciri dahil).
    if (isNetworkError(err) || isNetworkError(err?.cause)) {
      return { ok: false, kind: 'unreachable', status: null, data: null, ms };
    }
    return { ok: false, kind: 'unreachable', status: null, data: null, ms };
  }
  const ms = Date.now() - t0;
  const status = res.status;
  if (status === 403) return { ok: false, kind: 'forbidden', status, data: null, ms };
  if (status === 404) return { ok: false, kind: 'not_found', status, data: null, ms };
  if (status === 429) return { ok: false, kind: 'rate_limited', status, data: null, ms };
  if (status >= 500) return { ok: false, kind: 'server_error', status, data: null, ms };
  if (status !== 200) return { ok: false, kind: 'bad_status', status, data: null, ms };
  let data = null;
  try {
    data = await res.json();
  } catch {
    return { ok: false, kind: 'invalid_json', status, data: null, ms };
  }
  return { ok: true, kind: 'ok', status, data, ms };
}

const RETRYABLE = new Set(['timeout', 'unreachable', 'server_error']);

/** Kontrollü retry: sadece ağ/timeout/sunucu hatasında 1 kez (spec §24). */
async function fetchJson(url) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await fetchJsonOnce(url);
    if (last.ok || !RETRYABLE.has(last.kind)) return last;
    if (attempt < MAX_ATTEMPTS) {
      logger.warn(`FiveM istek başarısız (${last.kind}), kısa retry: ${url}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return last;
}

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
  if (!u.hostname) return null;
  // host:port formatı doğrula (spec §2: yanlış sunucuyu sorgulama)
  if (!/^[A-Za-z0-9.-]+$/.test(u.hostname)) return null;
  const port = u.port ? Number(u.port) : 30120;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${u.protocol}//${u.hostname}:${port}`;
}

/**
 * Oyun sunucusu taban adresini çözümler.
 * @returns {Promise<{base:string|null, source:'config'|'discovery'|null, snapshot:object|null, kind:string}>}
 */
async function resolveEndpoint() {
  const cfg = config.fivem.endpoint ? normalizeBase(config.fivem.endpoint) : null;
  if (cfg) return { base: cfg, source: 'config', snapshot: null, kind: 'ok' };

  const now = Date.now();
  if (resolvedCache.base && now - resolvedCache.at < config.fivem.resolveTtlMs) {
    return { base: resolvedCache.base, source: 'discovery', snapshot: resolvedCache.snapshot, kind: 'ok' };
  }

  const cfxId = config.fivem.cfxId;
  const r = await coalesce(`resolve:${cfxId}`, () => fetchJson(`${SINGLE_API}${encodeURIComponent(cfxId)}`));
  if (!r.ok) {
    logger.warn(`FiveM endpoint çözülemedi (${r.kind}): ${cfxId}`);
    return { base: null, source: null, snapshot: null, kind: r.kind };
  }
  const data = r.data?.Data || r.data?.data || null;
  const eps = data?.connectEndPoints || data?.connectEndpoints || [];
  const first = Array.isArray(eps) ? String(eps[0] || '') : '';
  // Sıkı format: host:port (IP veya hostname). Başka sunucuya düşmeyi engeller.
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(first)) {
    logger.warn(`FiveM endpoint formatı geçersiz, sorgulama iptal: ${first || '(boş)'}`);
    return { base: null, source: null, snapshot: null, kind: 'invalid_json' };
  }
  const base = normalizeBase(first);
  if (!base) return { base: null, source: null, snapshot: null, kind: 'invalid_json' };
  const snapshot = {
    hostname: typeof data?.hostname === 'string' ? data.hostname : null,
    clients: Number.isFinite(Number(data?.clients)) ? Number(data.clients) : null,
    maxClients: Number.isFinite(Number(data?.sv_maxclients ?? data?.svMaxclients)) ? Number(data.sv_maxclients ?? data.svMaxclients) : null,
  };
  resolvedCache = { at: now, base, snapshot };
  logger.success(`FiveM endpoint çözüldü: ${cfxId} → ${base}`);
  return { base, source: 'discovery', snapshot, kind: 'ok' };
}

async function getResource(base, path) {
  const key = `${base}${path}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const r = await coalesce(key, () => fetchJson(`${base}${path}`));
  const out = { ...r, cached: false };
  if (r.ok) cacheSet(key, out);
  return out;
}

const getPlayersRaw = (base) => getResource(base, '/players.json');
const getDynamicRaw = (base) => getResource(base, '/dynamic.json');
const getInfoRaw = (base) => getResource(base, '/info.json');

module.exports = {
  SINGLE_API,
  fetchJson,
  normalizeBase,
  resolveEndpoint,
  getPlayersRaw,
  getDynamicRaw,
  getInfoRaw,
  _cache: cache,
  _inflight: inflight,
  _resetResolvedCache: () => {
    resolvedCache = { at: 0, base: null, snapshot: null };
  },
};
