/**
 * Local bridge istemcisi (fivem-local-bridge paketi).
 * Bot ile AYNI makinede çalışan köprüden anlık oyuncu snapshot'ı okur.
 * Env ile kapalıyken (FIVEM_LOCAL_BRIDGE_URL boş) hiç ağa çıkılmaz.
 * Asla throw etmez; parola/token içermez (bridge anahtarı config'dedir, loglanmaz).
 */
const { fetch } = require('undici');
const config = require('../../config');

function baseOf() {
  const url = String(config.fivem.localBridge.url || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  if (!/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(url) && !/^https?:\/\/localhost(:\d+)?$/i.test(url)) {
    return null; // sadece loopback köprüler (güvenlik)
  }
  return url;
}

function sanitizePlayers(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const p of raw.slice(0, 2000)) {
    try {
      if (!p || typeof p !== 'object') continue;
      const id = Number(p.id);
      const name = String(p.name ?? '').trim().slice(0, 64);
      if (!Number.isInteger(id) || id < 1 || id > 100000 || !name) continue;
      const pingRaw = p.ping === null || p.ping === undefined ? null : Number(p.ping);
      const ping = pingRaw === null ? null : Number.isFinite(pingRaw) && pingRaw >= 0 ? Math.floor(pingRaw) : null;
      out.push({ id, name, ping });
    } catch {
      /* bozuk kayıt atlanır */
    }
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

/**
 * @returns {Promise<{ok:boolean, players:Array, stale:boolean, source:string|null, ms:number, error:string|null}>}
 */
async function fetchSnapshot() {
  const t0 = Date.now();
  const fail = (error) => ({ ok: false, players: [], stale: false, source: null, ms: Date.now() - t0, error });
  const base = baseOf();
  if (!base) return fail('not_configured');
  const key = String(config.fivem.localBridge.key || '');
  if (!key) return fail('no_key');
  let res = null;
  try {
    res = await fetch(`${base}/players`, {
      signal: AbortSignal.timeout(config.fivem.localBridge.timeoutMs),
      headers: { Accept: 'application/json', 'X-Bridge-Key': key },
    });
  } catch (err) {
    const msg = String(err?.message || '');
    if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(msg)) return fail('timeout');
    return fail('unreachable');
  }
  if (res.status === 401 || res.status === 403) return fail('auth_failed');
  if (res.status === 429) return fail('rate_limited');
  if (res.status !== 200) return fail(`http_${res.status}`);
  let body = null;
  try {
    body = await res.json();
  } catch {
    return fail('invalid_json');
  }
  if (!body || body.success !== true) return fail('invalid_json');
  const players = sanitizePlayers(body.players);
  if (!players) return fail('invalid_json');
  return {
    ok: true,
    players,
    stale: body.stale === true,
    source: typeof body.source === 'string' ? body.source.slice(0, 32) : 'bridge',
    ms: Date.now() - t0,
    error: null,
  };
}

module.exports = { fetchSnapshot, baseOf, sanitizePlayers };
