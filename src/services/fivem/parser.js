/**
 * FiveM veri parser'ı — saf fonksiyonlar (Discord/HTTP bağımlılığı yok).
 * GÜVENLİK: endpoint/identifiers gibi hassas alanlar buradan GEÇMEZ;
 * sadece { id, name, ping } dışarı çıkar (spec §36).
 */

const ZWSP = '​';
const MAX_NAME_LEN = 64;

/**
 * Oyuncu adını Discord embed'inde güvenli gösterim için temizler:
 * - kontrol karakterleri/newline → boşluk
 * - @everyone/@here → kitle mention'ı kırılır
 * - <@...>/<@&...>/<#...>/<:emoji:> → mention çalışmaz (görünüm korunur)
 * - Markdown (* _ ~ ` |) kaçışlanır (isimler bold içinde gösteriliyor)
 * NOT: orijinal isim ASLA değiştirilmez; sadece görüntü kopyası döner.
 */
function sanitizeName(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[\r\n\t\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'Bilinmeyen';
  s = s.slice(0, MAX_NAME_LEN);
  // Kitle mention'ları kır
  s = s.replace(/@everyone/gi, `@${ZWSP}everyone`).replace(/@here/gi, `@${ZWSP}here`);
  // Discord mention açıcılarını kır: <@ <#! <: (görünüm korunur, mention çalışmaz)
  s = s.replace(/<([@#:])/g, `<${ZWSP}$1`);
  // Markdown kaçışla
  s = s.replace(/([*_~`|\\])/g, '\\$1');
  return s || 'Bilinmeyen';
}

/**
 * Ham players.json dizisini doğrulanmış listeye çevirir. Beklenmedik şekilde ASLA throw etmez.
 * ANONYMIZED tespiti (§26 TEST F): liste boş değil AMA tüm kayıtlar
 * {id:0, name:"Player"} placeholder ise bu GERÇEK oyuncu değildir — yetkisiz/
 * public yanıttır, gerçek veri sv_playersToken ister. `anonymized:true` döner.
 */
function isAnonymizedEntry(p) {
  try {
    return Number(p?.id) === 0 && String(p?.name ?? '').trim().toLowerCase() === 'player';
  } catch {
    return false;
  }
}

function parsePlayers(raw) {
  if (!Array.isArray(raw)) return { ok: false, players: [], skipped: 0, anonymized: false };
  if (raw.length > 0 && raw.every(isAnonymizedEntry)) {
    return { ok: true, players: [], skipped: 0, anonymized: true };
  }
  const players = [];
  let skipped = 0;
  for (const p of raw) {
    try {
      if (!p || typeof p !== 'object') {
        skipped++;
        continue;
      }
      const id = Number(p.id);
      if (!Number.isInteger(id) || id < 0 || id > 100000) {
        skipped++;
        continue;
      }
      const name = sanitizeName(p.name);
      const pingRaw = Number(p.ping);
      const ping = Number.isFinite(pingRaw) && pingRaw >= 0 ? Math.floor(pingRaw) : null;
      // NOT: p.endpoint / p.identifiers bilerek OKUNMUYOR (spec §36).
      players.push({ id, name, ping });
    } catch {
      skipped++;
    }
  }
  players.sort((a, b) => a.id - b.id); // stabil sıralama: server ID artan (spec §39-40)
  return { ok: true, players, skipped, anonymized: false };
}

function findById(players, id) {
  if (!Array.isArray(players)) return null;
  return players.find((p) => p.id === id) || null;
}

function lowerTr(s) {
  try {
    return String(s).toLocaleLowerCase('tr-TR');
  } catch {
    return String(s).toLowerCase();
  }
}

/**
 * Case-insensitive substring arama (spec §13). Türkçe İ/ı duyarlı:
 * hem tr-TR hem varsayılan locale ile eşleşme denenir.
 */
function searchByName(players, term) {
  const q = String(term || '').trim();
  if (!q || !Array.isArray(players)) return [];
  const qTr = lowerTr(q);
  const qDef = q.toLowerCase();
  return players.filter((p) => {
    const nTr = lowerTr(p.name);
    if (nTr.includes(qTr)) return true;
    return p.name.toLowerCase().includes(qDef);
  });
}

/** /dynamic.json → { hostname, clients, maxClients, gametype, mapname } (eksik alan = null). */
function parseDynamic(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null);
  return {
    hostname: str(raw.hostname),
    clients: num(raw.clients),
    maxClients: num(raw.sv_maxclients ?? raw.svMaxclients),
    gametype: str(raw.gametype),
    mapname: str(raw.mapname),
  };
}

/** /info.json → metadata (eksik alan = null; resources sadece sayı olarak). */
function parseInfo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const vars = raw.vars && typeof raw.vars === 'object' ? raw.vars : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    hostname: str(vars.sv_projectName) || str(vars.sv_projectDesc) || null,
    maxClients: num(vars.sv_maxClients),
    gametype: str(vars.gamename) || str(raw.gametype),
    mapname: str(raw.mapname),
    resourceCount: Array.isArray(raw.resources) ? raw.resources.length : null,
    serverVersion: str(raw.server),
  };
}

/**
 * /id parametre doğrulama (spec §7): pozitif integer, 1..100000.
 * @returns {number|null} geçerli ID veya null
 */
function validatePlayerId(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100000) return null;
  return n;
}

/** /tag terim doğrulama: 1..64 karakter (boşluklar kırpılır). */
function validateSearchTerm(input) {
  const s = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 64) return null;
  return s;
}

module.exports = {
  sanitizeName,
  parsePlayers,
  findById,
  searchByName,
  parseDynamic,
  parseInfo,
  validatePlayerId,
  validateSearchTerm,
  MAX_NAME_LEN,
};
