/**
 * FiveM sorgu servisi — komutların tek giriş noktası.
 *
 * queryServer() akışı:
 *   endpoint çözümle (config → discovery) → players.json (zorunlu) +
 *   dynamic.json/info.json (opsiyonel, kısmi başarı tolere edilir — spec §50)
 *
 * Durumlar (internal): LIVE | PARTIAL | OFFLINE | ERROR (+ STALE takibi health'te)
 * - LIVE:    players.json taze ve geçerli (dynamic/info eksik olabilir).
 * - PARTIAL: players alınamadı AMA dynamic/info ile sunucu erişilebilir
 *            (örn. 403/404 liste kısıtı) → isim listesi yok, sayı/hostname var.
 * - OFFLINE: sunucuya ulaşılamıyor (timeout/unreachable/5xx/no_endpoint).
 * - ERROR:   istek reddi/bozuk veri (403-notFound-429 hariç → 403/429 invalid_json
 *            liste için ERROR; dynamic-ok + players-403 ise PARTIAL).
 *
 * Başarısız taze sorguda eski önbellek BAŞARI gibi sunulmaz (spec §22).
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
  source: null, // 'direct' | null
  updatedAt: 0,
  lastGoodAt: 0,
};

function setHealth(next) {
  const prev = health.status;
  health.status = next.status;
  health.detail = next.detail;
  health.players = next.players ?? health.players;
  health.latencyMs = next.latencyMs ?? null;
  health.source = next.source ?? null;
  health.updatedAt = Date.now();
  if (next.status === 'LIVE' || next.status === 'PARTIAL') health.lastGoodAt = Date.now();
  if (prev !== next.status) {
    const line = `🎮 FiveM Query Service | Status: ${prev} → ${next.status} (${next.detail}) | Players: ${health.players} | Latency: ${health.latencyMs ?? '-'}ms`;
    if (next.status === 'LIVE') logger.success(line);
    else logger.warn(line);
  }
}

function pickHostname(dynamic, info, snapshot) {
  return dynamic?.hostname || info?.hostname || snapshot?.hostname || null;
}

function pickMaxClients(dynamic, info, snapshot) {
  return dynamic?.maxClients ?? info?.maxClients ?? snapshot?.maxClients ?? null;
}

/**
 * Tam sunucu sorgusu. Asla throw etmez.
 * @returns {Promise<object>} query sonucu (yukarıdaki şema)
 */
async function queryServer() {
  const t0 = Date.now();
  const resolved = await client.resolveEndpoint();
  if (!resolved.base) {
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
      latencyMs: Date.now() - t0,
      listSnapshot: null,
      base: null,
    };
    setHealth({ status: 'OFFLINE', detail: 'no_endpoint', players: 0, latencyMs: out.latencyMs, source: null });
    return out;
  }

  const base = resolved.base;
  const [pRes, dRes, iRes] = await Promise.all([
    client.getPlayersRaw(base).catch(() => ({ ok: false, kind: 'unreachable', ms: 0, data: null })),
    client.getDynamicRaw(base).catch(() => ({ ok: false, kind: 'unreachable', ms: 0, data: null })),
    client.getInfoRaw(base).catch(() => ({ ok: false, kind: 'unreachable', ms: 0, data: null })),
  ]);
  const latencyMs = Date.now() - t0;

  const dynamic = dRes.ok ? parser.parseDynamic(dRes.data) : null;
  const info = iRes.ok ? parser.parseInfo(iRes.data) : null;
  const snapshot = resolved.snapshot || null;
  const hostname = pickHostname(dynamic, info, snapshot);
  const maxClients = pickMaxClients(dynamic, info, snapshot);

  // --- players BAŞARILI → LIVE (dynamic/info eksikliği sorun değil, §50) ---
  if (pRes.ok) {
    const parsed = parser.parsePlayers(pRes.data);
    if (!parsed.ok) {
      const out = {
        status: 'ERROR',
        detail: 'invalid_players',
        players: null,
        playersSkipped: 0,
        dynamic,
        info,
        hostname,
        onlineCount: null,
        maxClients,
        latencyMs,
        listSnapshot: snapshot,
        base,
      };
      setHealth({ status: 'ERROR', detail: 'invalid_players', latencyMs, source: 'direct' });
      return out;
    }
    const out = {
      status: 'LIVE',
      detail: 'ok',
      players: parsed.players,
      playersSkipped: parsed.skipped,
      dynamic,
      info,
      hostname,
      onlineCount: parsed.players.length,
      maxClients,
      latencyMs,
      listSnapshot: snapshot,
      base,
    };
    setHealth({ status: 'LIVE', detail: 'ok', players: parsed.players.length, latencyMs, source: 'direct' });
    return out;
  }

  // --- players BAŞARISIZ ---
  const kind = pRes.kind;
  // Sunucu erişilebilir (dynamic/info OK) ama liste alınamıyor → PARTIAL (§50)
  const reachable = dynamic !== null || info !== null;
  if (reachable && (kind === 'forbidden' || kind === 'not_found' || kind === 'rate_limited' || kind === 'invalid_json')) {
    const out = {
      status: 'PARTIAL',
      detail: kind,
      players: null,
      playersSkipped: 0,
      dynamic,
      info,
      hostname,
      onlineCount: dynamic?.clients ?? snapshot?.clients ?? null,
      maxClients,
      latencyMs,
      listSnapshot: snapshot,
      base,
    };
    setHealth({ status: 'PARTIAL', detail: kind, players: dynamic?.clients ?? 0, latencyMs, source: 'direct' });
    return out;
  }

  const offlineKinds = new Set(['timeout', 'unreachable', 'server_error', 'bad_status']);
  const status = offlineKinds.has(kind) ? 'OFFLINE' : 'ERROR';
  const out = {
    status,
    detail: kind,
    players: null,
    playersSkipped: 0,
    dynamic,
    info,
    hostname,
    // OFFLINE/ERROR'da isim listesi YOK; sayı sadece dynamic/info'dan gelirse bilgi amaçlı
    onlineCount: dynamic?.clients ?? null,
    maxClients,
    latencyMs,
    listSnapshot: snapshot,
    base,
  };
  setHealth({ status, detail: kind, players: 0, latencyMs, source: 'direct' });
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

function getHealth() {
  const stale = health.lastGoodAt > 0 && Date.now() - health.lastGoodAt > config.fivem.cacheTtlMs * 3;
  return { ...health, stale, cfxId: config.fivem.cfxId };
}

module.exports = {
  queryServer,
  findPlayerById,
  searchPlayers,
  getHealth,
  STATUS: { LIVE: 'LIVE', PARTIAL: 'PARTIAL', OFFLINE: 'OFFLINE', ERROR: 'ERROR', STALE: 'STALE' },
};
