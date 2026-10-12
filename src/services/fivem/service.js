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
const localBridge = require('./localBridge');
const bridge = require('./bridge');

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

/** Ağ katmanı hataları: sunucuya hiç ulaşılamadı → OFFLINE (ERROR değil). */
const NETWORK_KINDS = new Set([
  'timeout',
  'connection_refused',
  'dns_error',
  'connection_reset',
  'unreachable',
]);

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
 * Tam sunucu sorgusu — kaynak zinciri. Asla throw etmez.
 *
 * ÖNCELİK (kullanıcı spec'i):
 *   1. YÖNTEM B — yetkili HTTP: /players.json + X-Players-Token (CFX_PLAYERS_TOKEN).
 *      Yalnızca token yapılandırılmış VE yanıt gerçekten doğrulanmışsa seçilir.
 *   2. YÖNTEM C — sunucu resource bridge (push: bridge.js) veya local bridge (pull).
 *      Push tercih edilir; her ikisi de sunucu sahibinin izniyle çalışır.
 *   3. RCON (UDP) — sunucu sahibinin rcon_password izniyle.
 *   4. YÖNTEM A — public HTTP. Oyuncu isimleri gizliyse ANONYMIZED döner;
 *      sayı/hostname dynamic.json'dan DOĞRULANARAK gösterilir.
 *
 * Bayat veri kuralı: bridge verisi maxAgeMs'yi aşarsa LIVE sayılmaz.
 * Token/RCON/parola yoksa ve veri anonimse isim listesi ÜRETİLMEZ; durum
 * ANONYMIZED döner ve kullanıcıya sunucu sahibinden ne gerektiği söylenir.
 *
 * İmza sabit → /id, /idbul, /oyuncular, /tag, /sunucudurum değişmeden çalışır.
 */
async function queryServer() {
  const t0 = Date.now();
  const { primary, fallback } = client.resolveBases();
  const rBase = `udp://${config.fivem.rcon.host}:${config.fivem.rcon.port}`;
  const chainKey = `${primary?.base || '-'}|${fallback?.base || '-'}|${rBase}|${config.fivem.localBridge.url ? 'lb' : '-'}`;

  // Negatif önbellek: kısa süre önce tamamen başarısız olan zincir tekrar sorulmaz.
  const neg = negCached(chainKey);
  if (neg) return neg;

  const baseOut = {
    players: null, playersSkipped: 0, dynamic: null, info: null,
    hostname: null, onlineCount: null, maxClients: null,
    latencyMs: 0, base: primary?.base || rBase, baseSource: 'none',
  };
  const finish = (status, detail, extra, lastError, source) => {
    const out = { ...baseOut, ...extra, status, detail, latencyMs: Date.now() - t0 };
    setHealth({ status, detail, players: out.players?.length || 0, latencyMs: out.latencyMs, source, base: out.base, lastError });
    // ANONYMIZED/PARTIAL canlı durumlardır: negatif önbelleğe ALINMAZ,
    // çünkü sunucu sahibi sonradan token/RCON ekleyince anında geçerli olmalıdır.
    if (status === 'OFFLINE' || status === 'ERROR') negStore(chainKey, out);
    return out;
  };

  // ============ 1) YÖNTEM B — yetkili HTTP (X-Players-Token) ============
  // Token yapılandırılmış VE yanıt gerçek veri doğrulamasından geçerse seçilir.
  let tokenAnonymized = false;
  if (primary?.base && config.fivem.playersToken) {
    const r = await httpPlayers(primary.base);
    if (r.ok && !r.anonymized) {
      return finish('LIVE', 'players_token', {
        players: r.players,
        playersSkipped: r.skipped,
        hostname: `CFX ${config.fivem.cfxId}`,
        onlineCount: r.players.length,
        base: primary.base,
        baseSource: 'players_token',
        verified: true,
      }, null, 'players_token');
    }
    if (r.anonymized) {
      tokenAnonymized = true;
      logger.warn('players.json hâlâ anonim — CFX_PLAYERS_TOKEN ile sv_playersToken eşleşmiyor olabilir.');
    } else {
      logFetchError('players', primary.base, '/players.json', r.raw);
    }
  }

  // ============ 2) YÖNTEM C — sunucu resource bridge (push) ============
  // Bot tarafında daha önce alınmış snapshot. Bayat veri LIVE sayılmaz.
  const snap = bridge.getSnapshot();
  if (snap.configured && snap.hasData && !snap.stale) {
    return finish('LIVE', 'resource_bridge', {
      players: snap.players,
      hostname: `CFX ${config.fivem.cfxId}`,
      onlineCount: snap.count,
      base: 'resource_bridge',
      baseSource: 'resource_bridge',
      verified: true,
      receivedAt: snap.receivedAt,
      ageMs: snap.ageMs,
    }, null, 'resource_bridge');
  }
  if (snap.configured && snap.hasData && snap.stale) {
    logger.warn(`Resource bridge verisi BAYAT (${Math.round(snap.ageMs / 1000)} sn). Gerçek kaynaklara düşülüyor.`);
  }

  // --- 2b) Yöntem C alternatif: local bridge (çekme tabanlı, aynı makine) ---
  if (config.fivem.localBridge.url) {
    let lb = null;
    try {
      lb = await localBridge.fetchSnapshot();
    } catch (err) {
      logger.error('Local bridge beklenmedik hata.', err);
      lb = { ok: false, error: 'exception' };
    }
    if (lb && lb.ok) {
      return finish('LIVE', 'ok', {
        players: lb.players,
        hostname: `CFX ${config.fivem.cfxId}`,
        onlineCount: lb.players.length,
        base: config.fivem.localBridge.url,
        baseSource: 'local_bridge',
        verified: true,
      }, null, 'local_bridge');
    }
    logger.warn(`Local bridge erişilemedi (${lb?.error || 'unknown'}) — sonraki kaynağa düşülüyor.`);
  }

  // ============ 3) RCON (UDP) — sunucu sahibi yetkilendirmesi ============
  if (config.fivem.rcon.password) {
    const rHost = config.fivem.rcon.host;
    const rPort = config.fivem.rcon.port;
    let r = null;
    try {
      r = await rcon.status();
    } catch (err) {
      logger.error('RCON status beklenmedik hata.', err);
      return finish('ERROR', 'rcon_error', { baseSource: 'rcon_status', base: rBase }, 'RCON_EXCEPTION', 'rcon_status');
    }
    if (r.ok) {
      const parsed = rconParser.parseStatus(r.text || '');
      const hostname = extractRconHostname(r.text) || `CFX ${config.fivem.cfxId}`;
      if (parsed.anonymized) {
        return finish('ANONYMIZED', 'anonymized', {
          players: [], hostname, onlineCount: 0, base: rBase, baseSource: 'rcon_status',
        }, 'PUBLIC_ANONYMIZED', 'rcon_status');
      }
      return finish('LIVE', 'ok', {
        players: parsed.players, playersSkipped: parsed.skipped,
        hostname, onlineCount: parsed.players.length, base: rBase, baseSource: 'rcon_status',
        verified: true,
      }, null, 'rcon_status');
    }
    // RCON başarısız: HTTP yoluna düşülür (aşağıda devam).
    const m = mapRconKind(r.kind);
    logger.warn(
      `FiveM RCON başarısız → ${r.kind} | Host: ${rHost} | Port: ${rPort} | ` +
        `Transport: UDP | Command: status | Elapsed: ${r.ms}ms`,
    );
    logger.debug(`RCON sonucu (${m.status}) — HTTP kaynakları denenecek.`);
  }

  // ============ 4) YÖNTEM A — public HTTP ============
  let lastHttpKind = null; // hiçbir aday yanıt vermezse neden raporlanacak
  for (const cand of [primary, fallback]) {
    if (!cand?.base) continue;
    const r = await httpPlayers(cand.base);
    if (!r.ok) {
      lastHttpKind = r.raw?.kind || 'unreachable';
      logFetchError('players', cand.base, '/players.json', r.raw);
      continue;
    }
    if (!r.anonymized) {
      // Sunucu gerçek veriyi herkese açık veriyor (token gerektirmiyor).
      return finish('LIVE', 'players_public', {
        players: r.players, playersSkipped: r.skipped,
        hostname: `CFX ${config.fivem.cfxId}`, onlineCount: r.players.length,
        base: cand.base, baseSource: 'players_public', verified: true,
      }, null, 'players_public');
    }
    // Anonim: isim yok. Sayı/hostname DOĞRULANABILİR (dynamic.json).
    const dyn = await httpDynamic(cand.base);
    return finish('ANONYMIZED', 'anonymized', {
      players: [], dynamic: dyn.dynamic,
      hostname: dyn.dynamic?.hostname || `CFX ${config.fivem.cfxId}`,
      onlineCount: dyn.dynamic?.clients ?? r.placeholderCount,
      maxClients: dyn.dynamic?.maxClients ?? null,
      base: cand.base, baseSource: 'players_anonymous',
      tokenMismatch: tokenAnonymized,
    }, 'PUBLIC_ANONYMIZED', 'players_anonymous');
  }

  // --- 5) Hiçbir oyuncu kaynağı yanıt vermedi ---
  // Gerçek neden ayrıştırılır: ağ katmanı hatası OFFLINE'dır; diğerleri ERROR.
  if (lastHttpKind) {
    const isNet = NETWORK_KINDS.has(lastHttpKind);
    const src_ = primary?.base ? 'players_public' : 'none';
    return finish(
      isNet ? 'OFFLINE' : 'ERROR',
      lastHttpKind,
      { baseSource: src_ },
      `HTTP_${lastHttpKind.toUpperCase()}`,
      src_,
    );
  }
  return finish('ERROR', 'not_configured', {}, 'NO_DATA_SOURCE', 'none');
}

/** /players.json → normalize edilmiş sonuç. Asla throw etmez. */
async function httpPlayers(base) {
  let r = null;
  try {
    r = await client.getPlayersRaw(base);
  } catch (err) {
    logger.error('players.json beklenmedik hata.', err);
    r = { ok: false, kind: 'unreachable', status: null, ms: 0, snippet: null };
  }
  if (!r.ok) return { ok: false, anonymized: false, players: [], skipped: 0, placeholderCount: 0, raw: r };
  const p = parser.parsePlayers(r.data);
  if (!p.ok) {
    return { ok: false, anonymized: false, players: [], skipped: 0, placeholderCount: 0, raw: { ...r, kind: 'invalid_json' } };
  }
  return {
    ok: true,
    anonymized: p.anonymized,
    players: p.players,
    skipped: p.skipped,
    placeholderCount: Array.isArray(r.data) ? r.data.length : 0,
    raw: r,
  };
}

/** /dynamic.json → best-effort. Asla throw etmez. */
async function httpDynamic(base) {
  try {
    const r = await client.getDynamicRaw(base);
    if (!r.ok) return { dynamic: null };
    return { dynamic: parser.parseDynamic(r.data) };
  } catch {
    return { dynamic: null };
  }
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

/**
 * ANONYMIZED durumu için kullanıcı metni.
 * Kullanıcıya sunucu sahibinden gerekenler net ve sıralı olarak söylenir.
 */
function anonymizedText(base) {
  const b = base ? String(base).replace(/^https?:\/\//i, '').replace(/\/+$/, '') : null;
  const tokenSet = !!config.fivem.playersToken;
  const rconSet = !!config.fivem.rcon.password;
  const bridgeSet = !!config.fivem.localBridge.url;

  let lines = '';
  lines += `🔒 **Oyuncu listesi anonimleştirilmiş.**${b ? `\nSunucu: \`${b}\`` : ''}\n\n`;
  lines +=
    'Sunucu `players.json` isimleri gizliyor: her kayıt `id=0` / `Player` olarak dönüyor.\n' +
    'Bu bir bot hatası değil — sunucu sahibinin gizlilik ayarı. Gerçek liste **yalnızca** sunucu sahibinin izin verdiği kanaldan gelir.\n\n';
  lines += '**Sunucu sahibinin yapması gereken (3 seçenek):**\n';
  lines +=
    '`1.` **sv_playersToken** (en kolay) → sunucu.cfg içine bir değer yaz, bot tarafına `FIVEM_PLAYERS_TOKEN` olarak aynı değeri ver.\n' +
    '`2.` **rcon_password** → sunucu.cfg içine parola yaz, bot tarafına `FIVEM_RCON_PASSWORD` olarak aynı değeri ver.\n' +
    '`3.` **Sunucu resource** → sunucuya köprü resource kurulur; bot aynı makinedeyse `FIVEM_LOCAL_BRIDGE_URL` + `FIVEM_LOCAL_BRIDGE_KEY` ile okur.\n\n';
  lines += '**Bot tarafındaki durum:**\n';
  lines += `• players token (Yöntem B) : ${tokenSet ? '⚠️ tanımlı, ancak sunucu hâlâ anonim döndürüyor (token eşleşmiyor olabilir)' : '❌ tanımlı değil'}\n`;
  lines += `• RCON (Yöntem C)          : ${rconSet ? '✅ parola tanımlı' : '❌ parola tanımlı değil'}\n`;
  lines += `• Local bridge (Yöntem D)  : ${bridgeSet ? '✅ tanımlı' : '❌ tanımlı değil'}\n`;
  if (!tokenSet && !rconSet && !bridgeSet) {
    lines +=
      '\n> Bot tarafında hiçbir gizli erişim kanalı yapılandırılmamış. ' +
      'Yetkili biri `.env` içine `FIVEM_PLAYERS_TOKEN` ya da `FIVEM_RCON_PASSWORD` eklemeli.\n';
  }
  return lines;
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
  const rHost = config.fivem.rcon.host;
  const rPort = config.fivem.rcon.port;

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

  // Local bridge (yapılandırılmışsa; password yoksa ağa çıkılmaz).
  let local = { configured: !!config.fivem.localBridge.url, ok: null, ms: null, players: null, error: null };
  if (local.configured) {
    try {
      const s = await localBridge.fetchSnapshot();
      local = {
        configured: true, ok: s.ok, ms: s.ms,
        players: s.ok ? s.players.length : null,
        error: s.ok ? null : (s.error || 'unknown').toUpperCase(),
      };
    } catch (err) {
      local = { configured: true, ok: false, ms: Date.now() - t0, players: null, error: 'EXCEPTION' };
      logger.error('Local bridge health testi hata.', err);
    }
  }

  const h = getHealth();
  return {
    cfxId: config.fivem.cfxId,
    rcon: rconHealth,
    local,
    http,
    ms: Date.now() - t0,
    tokenConfigured: !!config.fivem.playersToken,
    // Yontem C (push bridge) durumu - secret DEGERI ASLA donulmez.
    bridge: (() => {
      const s = bridge.getSnapshot();
      return {
        configured: s.configured,
        hasData: s.hasData,
        count: s.count,
        receivedAt: s.receivedAt,
        ageMs: s.ageMs,
        stale: s.stale,
      };
    })(),
    // players.json gercek veri verdi mi? Degilse anonimlestirme/paranoia adayi.
    paranoiaDetected: (() => {
      const p = (http && http.endpoints) ? http.endpoints['/players.json'] : null;
      if (!p || !p.ok) return false;
      if (p.error === 'SV_REQUEST_PARANOIA' || p.kind === 'forbidden') return true;
      return !!(p.summary && p.summary.anonymized === true);
    })(),
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
