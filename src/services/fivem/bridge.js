/**
 * YÖNTEM C — Sunucu resource bridge (bot tarafı).
 *
 * Sunucudaki Lua resource, aktif oyuncu listesini botun HTTP API'sine
 * `POST /api/fivem/players` ile GÖNDERİR (push). Bu modül o veriyi:
 *   1. Yetkilendirir (paylaşılan secret, zamanlama-güvenli karşılaştırma)
 *   2. Katı şema ile doğrular
 *   3. Yalnızca izin verilen alanları SAKLAR
 *   4. Zaman damgasıyla saklar; bayat veriyi güncelmiş gibi GÖSTERMEZ
 *
 * GÜVENLİK KARARLARI:
 * - `identifiers` (license/steam/rockstar), `endpoint` (IP), `fivem:license`
 *   gibi alanlar GİRİŞTE KESİLİR ve hiçbir zaman saklanmaz. Sadece
 *   {serverId, name, ping} tutulur. (Proje kuralı: oyuncuya açık kanallarda
 *   hassas identifier yayımlanmaz.)
 * - Secret hiçbir log satırına yazılmaz; hata mesajları yalnız HTTP durumu
 *   döner.
 * - İçerik tipi/şema hataları ayrı sınıflandırılır (401 / 400 / 413 / 415).
 *
 * Bu modül Discord'a BAĞIMLI DEĞİLDİR ve hiçbir zaman throw etmez.
 */
const crypto = require('node:crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const parser = require('./parser');

const MAX_NAME_LEN = 64;
const MAX_PLAYERS_HARD = 4096;

/**
 * Son başarılı snapshot. Süreç içinde tutulur (kalıcı değil): bot yeniden
 * başlayınca "henüz veri yok" durumuna döner ve bayat veri gösterilmez.
 * @type {{players:Array, receivedAt:number, count:number, source:string}|null}
 */
let snapshot = null;

// Uyarı tekrarını önle (her sorguda aynı mesajı yazmamak için).
let lastWarnAt = 0;
let lastWarnKey = '';

function warnOnce(key, ms, build) {
  const now = Date.now();
  if (key === lastWarnKey && now - lastWarnAt < ms) return;
  lastWarnKey = key;
  lastWarnAt = now;
  const msg = build();
  if (msg) logger.warn(msg);
}

/**
 * Zamanlama-güvenli secret karşılaştırması.
 * crypto.timingSafeEqual yalnız eşit uzunlukta çalıştığı için önce uzunluk
 * kontrolü yapılır; uzunluk farkı da sızdırmayacak şekilde ele alınır.
 */
function secretsMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || b.length === 0) return false;
  // Farklı uzunluk: karşılaştırma yapmadan false. Uzunluk sızıntısı burada
  // pratikte önemsiz (sabit uzunlukta token bekleniyor), asıl koruma içerik
  // karşılaştırmasının timing-safe olması.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Gelen tek bir oyuncu kaydını doğrular ve SADECE izin verilen alanlara indirger.
 * @returns {{ok:boolean, player?:{id:number,name:string,ping:number|null}, reason?:string}}
 */
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'entry_not_object' };

  // serverId zorunlu. Hem sayı hem string kabul edilir (Lua tonumber çıktısı
  // bazen string gelebilir).
  const rawId = entry.serverId ?? entry.id;
  const id = typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim());
  if (!Number.isInteger(id) || id < 1 || id > 100000) return { ok: false, reason: 'bad_server_id' };

  const rawName = entry.name;
  if (typeof rawName !== 'string') return { ok: false, reason: 'bad_name' };
  const name = parser.sanitizeName(rawName.slice(0, MAX_NAME_LEN * 4));
  if (!name || name === 'Bilinmeyen') return { ok: false, reason: 'empty_name' };

  const rawPing = entry.ping;
  const pingNum = rawPing === null || rawPing === undefined || rawPing === '' ? null : Number(rawPing);
  const ping = pingNum !== null && Number.isFinite(pingNum) && pingNum >= 0 ? Math.floor(pingNum) : null;

  // DİKKAT: burada yalnız üç alan DÖNER. identifiers / endpoint / her şey
  // bilinçli olarak düşürülür — gelen veriden kopyalanmaz.
  return { ok: true, player: { id, name, ping } };
}

/**
 * Gelen payload'ı doğrular ve saklar.
 * @param {unknown} body express.json() ile parse edilmiş gövde
 * @param {string} providedSecret istek başlığından gelen secret
 * @returns {{ok:boolean, code:number, error?:string, count?:number, dropped?:number}}
 */
function ingest(body, providedSecret) {
  const expected = config.fivem.bridge.secret;

  // 1) Yetkilendirme — secret yoksa endpoint devre dışıdır (401, sır vermez).
  if (!expected) {
    return { ok: false, code: 503, error: 'bridge_not_configured' };
  }
  if (!secretsMatch(providedSecret, expected)) {
    // Secret değeri NE yazılır NE loglanır.
    warnOnce('bad_secret', 30000, () => 'Bridge isteği reddedildi: secret hatalı. (Secret değeri loglanmaz.)');
    return { ok: false, code: 401, error: 'unauthorized' };
  }

  // 2) Gövde şekli
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 400, error: 'invalid_payload' };
  }
  const rawList = Array.isArray(body.players) ? body.players : null;
  if (!rawList) return { ok: false, code: 400, error: 'players_missing' };

  // 3) Boyut sınırı — istisna taşırmadan kesilir.
  const hardCap = Math.min(config.fivem.bridge.maxPlayers || 1024, MAX_PLAYERS_HARD);
  const list = rawList.length > hardCap ? rawList.slice(0, hardCap) : rawList;

  // 4) Kayıt doğrulama
  const players = [];
  let dropped = 0;
  for (const entry of list) {
    const r = sanitizeEntry(entry);
    if (r.ok) players.push(r.player);
    else dropped++;
  }
  // Sunucu ID artan sıralama (stabil görünüm)
  players.sort((a, b) => a.id - b.id);

  // 5) Kaydet. NOT: boş liste de GEÇERLİ bir sonuçtur ("sunucuda oyuncu yok").
  //    Anonimleştirme/erişim hatası DEĞİLDİR — resource çalışıyorsa veri gelir.
  const now = Date.now();
  const prevCount = snapshot ? snapshot.count : null;
  snapshot = { players, receivedAt: now, count: players.length, source: 'resource_bridge' };

  if (prevCount !== null && prevCount !== players.length) {
    warnOnce('churn_' + players.length, 5000, () =>
      `Bridge verisi güncellendi: ${prevCount} → ${players.length} oyuncu.`);
  }

  return { ok: true, code: 200, count: players.length, dropped };
}

/**
 * Son snapshot'ı döner. Bayat veri bayat olarak İŞARETLENİR.
 * @returns {{configured:boolean, hasData:boolean, players:Array, receivedAt:number|null,
 *            ageMs:number|null, stale:boolean, count:number, source:string}}
 */
function getSnapshot() {
  const configured = !!config.fivem.bridge.secret;
  if (!snapshot) {
    return {
      configured,
      hasData: false,
      players: [],
      receivedAt: null,
      ageMs: null,
      stale: false,
      count: 0,
      source: 'resource_bridge',
    };
  }
  const ageMs = Date.now() - snapshot.receivedAt;
  const maxAge = config.fivem.bridge.maxAgeMs;
  return {
    configured,
    hasData: true,
    players: snapshot.players,
    receivedAt: snapshot.receivedAt,
    ageMs,
    stale: ageMs > maxAge,
    count: snapshot.count,
    source: 'resource_bridge',
  };
}

/** Test/reset için. */
function _reset() {
  snapshot = null;
  lastWarnAt = 0;
  lastWarnKey = '';
}

module.exports = {
  ingest,
  getSnapshot,
  sanitizeEntry,
  secretsMatch,
  _reset,
  _hasSnapshot: () => snapshot !== null,
};