/**
 * FiveM RCON istemcisi — UDP, Quake3-tarzı out-of-band paketler (§4, §17, §25).
 *
 * DİKKAT: Bu, Source/Minecraft TCP RCON DEĞİLDİR. `node:net` kullanılmaz,
 * sadece `node:dgram` (UDP) kullanılır.
 *
 * Paket formatı:
 *   gönderilen: FF FF FF FF + `rcon <password> <command>\n`
 *   gelen:      FF FF FF FF + `print[ \n]<metin>` (uzunsa birden çok parça)
 *
 * GÜVENLİK (§34, §35):
 * - Sadece allowlist'teki komutlar gönderilir (şu an: yalnız `status`).
 *   Discord'dan genel RCON çalıştırma YOKTUR.
 * - Parola ASLA loglanmaz, Discord'a yazılmaz, hata metinlerine konmaz.
 * - Identifier/endpoint SADECE parser içindir; dışarı {id,name,ping} çıkar.
 */
const dgram = require('node:dgram');
const config = require('../../config');
const logger = require('../../utils/logger');

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);
// İzinli komutlar — oyuncu sorgulama dışı RCON komutu BURADAN GEÇEMEZ.
const ALLOWED_COMMANDS = new Set(['status']);
const QUIET_MS = 400; // parça arası sessizlik → yanıt tamamlandı sayılır
const MAX_BYTES = 256 * 1024;
const RETRY_DELAY_MS = 500;

// Kısa önbellek (status metni) + in-flight paylaşımı (§27, §28).
const cache = new Map(); // key -> { at, value }
const inflight = new Map();

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > config.fivem.rcon.cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 10) {
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

function classifySocketError(err) {
  const codes = [];
  let cur = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.code) codes.push(String(cur.code));
    cur = cur.cause;
  }
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) return 'dns_error';
  if (codes.includes('ECONNREFUSED')) return 'server_offline';
  return 'unreachable';
}

/** Gelen paketten metin parçasını çıkarır; OOB/print değilse null (stray trafik). */
function extractChunk(msg) {
  if (!Buffer.isBuffer(msg) || msg.length < 5) return null;
  if (msg[0] !== 0xff || msg[1] !== 0xff || msg[2] !== 0xff || msg[3] !== 0xff) return null;
  let text = msg.subarray(4).toString('utf8');
  if (text.startsWith('print')) text = text.slice(5);
  if (text.startsWith(' ') || text.startsWith('\n') || text.startsWith('\r')) text = text.slice(1);
  return text;
}

function isAuthFailure(text) {
  return /invalid(\s+rcon)?\s*pass|bad\s*rcon|wrong\s*pass|access\s*denied|unauthori[sz]ed|rcon\s*denied/i.test(text || '');
}

/**
 * Tek RCON isteği (ham). Asla throw etmez.
 * @returns {Promise<{ok:boolean, kind:string, text:string, ms:number}>}
 * kind: ok | empty | timeout | unreachable | dns_error | server_offline
 *       | auth_failed | malformed | not_configured
 */
function sendOnce(host, port, password, command, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let bytes = 0;
    const chunks = [];
    let validPackets = 0;
    const sock = dgram.createSocket('udp4');

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      clearTimeout(quiet);
      try {
        sock.close();
      } catch {}
      resolve({ ...result, ms: Date.now() - t0 });
    };

    const joinText = () => chunks.join('');
    const overall = setTimeout(() => {
      // Hiç geçerli paket gelmediyse timeout; geldiyse eldekiyle tamamla.
      if (validPackets === 0) finish({ ok: false, kind: 'timeout', text: '' });
      else finish({ ok: true, kind: 'ok', text: joinText() });
    }, timeoutMs);

    let quiet = null;
    const pokeQuiet = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => finish({ ok: true, kind: 'ok', text: joinText() }), QUIET_MS);
      if (quiet && typeof quiet.unref === 'function') quiet.unref();
    };

    // 'error' MUTLAKA dinlenir (yoksa process crash — §24).
    sock.on('error', (err) => {
      finish({ ok: false, kind: classifySocketError(err), text: joinText() });
    });
    sock.on('message', (msg) => {
      const chunk = extractChunk(msg);
      if (chunk === null) return; // stray paket, yok say
      validPackets++;
      if (bytes + chunk.length <= MAX_BYTES) {
        chunks.push(chunk);
        bytes += chunk.length;
      }
      pokeQuiet();
    });

    const payload = Buffer.concat([OOB, Buffer.from(`rcon ${password} ${command}\n`, 'utf8')]);
    try {
      sock.send(payload, port, host, (err) => {
        if (err) finish({ ok: false, kind: classifySocketError(err), text: '' });
      });
    } catch (err) {
      finish({ ok: false, kind: classifySocketError(err), text: '' });
    }
    try {
      if (typeof sock.unref === 'function') sock.unref();
    } catch {}
  });
}

/**
 * Allowlist kontrollü komut gönderimi (tek deneme). Export edilmez mantığı:
 * dışarı SADECE status() ve getPlayers() açıktır.
 */
async function sendCommand(command, { timeoutMs, password } = {}) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`RCON komutuna izin yok: ${command}`);
  }
  const host = String(config.fivem.rcon.host || '').trim();
  const port = Number(config.fivem.rcon.port) || 30120;
  const pw = password !== undefined ? password : config.fivem.rcon.password;
  if (!pw || /[\s]/.test(pw)) {
    return { ok: false, kind: !pw ? 'not_configured' : 'bad_password', text: '', ms: 0 };
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, kind: 'not_configured', text: '', ms: 0 };
  }
  const t = timeoutMs || config.fivem.rcon.timeoutMs;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await sendOnce(host, port, pw, command, t);
    if (last.ok) {
      if (!last.text) return { ...last, kind: 'empty' };
      if (isAuthFailure(last.text)) return { ...last, ok: false, kind: 'auth_failed', text: '' };
      return last;
    }
    // Retry SADECE timeout'ta (paket kaybı). Auth/offline/parse tekrar denenmez.
    if (last.kind !== 'timeout') return last;
    if (attempt < 2) {
      logger.warn(`RCON status zaman aşımı, kısa retry (${host}:${port})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return last;
}

/**
 * Ham `status` yanıtı. Önbellek + in-flight paylaşımı ile sarılıdır.
 * Parola parametreyle ezilebilir (testler için); normalde config'den gelir.
 */
async function status(opts = {}) {
  const pw = opts.password !== undefined ? opts.password : config.fivem.rcon.password;
  if (!pw) return { ok: false, kind: 'not_configured', text: '', ms: 0 };
  // Özel parola ile çağrı (test/teşhis): önbellek/coalesce DIŞI — karışma olmaz.
  if (opts.password !== undefined) return { ...(await sendCommand('status', opts)), cached: false };
  const key = `status:${config.fivem.rcon.host}:${config.fivem.rcon.port}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const r = await coalesce(key, () => sendCommand('status', opts));
  const out = { ...r, cached: false };
  if (r.ok) cacheSet(key, out);
  return out;
}

module.exports = {
  status,
  sendCommand, // allowlist'i testler ve service kullanır (Discord'a açık DEĞİL)
  extractChunk,
  isAuthFailure,
  ALLOWED_COMMANDS,
  QUIET_MS,
  _cache: cache,
  _inflight: inflight,
};
