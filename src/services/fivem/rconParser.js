/**
 * RCON `status` yanıt parser'ı — saf fonksiyonlar.
 *
 * Gerçek `rconlog` çıktısı satır bazlıdır, yaklaşık format:
 *   <id> <identifier> <name...> <endpoint> <ping>
 * Örn: `42 license:abc John Doe 1.2.3.4:30120 37`
 *
 * İsimler BOŞLUK içerebilir → sabit kolon split YOKTUR. Kural (§6):
 *  1. ilk token = server ID
 *  2. ikinci token = primary identifier
 *  3. son token = ping
 *  4. sondan ikinci token = endpoint
 *  5. ortada kalan TÜM tokenlar = name
 *
 * Başlık/bilgi satırları (hostname vb.) eşleşmezse sessizce atlanır.
 * Hassas alanlar (identifier/endpoint) SADECE parse için kullanılır,
 * dışarı { id, name, ping } modeli çıkar (§7, §8).
 */

const COLOR_CODE_RE = /\^[0-9]/g;
const MAX_NAME_LEN = 64;

/** FiveM renk kodlarını (^0-^9) temizler (§22). */
function stripColorCodes(s) {
  return String(s ?? '').replace(COLOR_CODE_RE, '');
}

function sanitizeRconName(raw) {
  let s = stripColorCodes(raw);
  s = s.replace(/[\r\n\t\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'Bilinmeyen';
  s = s.slice(0, MAX_NAME_LEN);
  // Kitle mention + Discord mention açıcıları kır (görünüm korunur, ZWSP ile).
  s = s.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');
  s = s.replace(/<([@#:])/g, '<\u200b$1');
  s = s.replace(/([*_~`|\\])/g, '\\$1');
  return s || 'Bilinmeyen';
}

/**
 * Tek status satırını parse eder. Eşleşmezse null (başlık satırı vb.).
 * @returns {{id:number, name:string, ping:number|null}|null}
 */
function parseStatusLine(line) {
  if (typeof line !== 'string') return null;
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return null; // en az: id identifier name endpoint
  const id = Number(tokens[0]);
  if (!Number.isInteger(id) || id < 0 || id > 100000) return null;
  if (!tokens[1] || tokens[1].length > 128) return null; // identifier slotu
  const last = tokens[tokens.length - 1];
  const lastNum = Number(last);
  let ping = null;
  let nameTokens;
  if (Number.isFinite(lastNum) && last.trim() !== '') {
    // Normal durum: son token ping.
    ping = lastNum >= 0 ? Math.floor(lastNum) : null;
    const endpoint = tokens[tokens.length - 2] || '';
    if (!endpoint || endpoint.length > 128) return null;
    nameTokens = tokens.slice(2, -2);
  } else if (/[:.]/.test(last) && last.length <= 128) {
    // Ping yok ama endpoint var (`... NoPingGuy 10.0.0.1:50010`) → ping null.
    nameTokens = tokens.slice(2, -1);
  } else {
    return null; // ne ping ne endpoint → status satırı değil
  }
  if (!nameTokens.length) return null;
  const name = sanitizeRconName(nameTokens.join(' '));
  return { id, name, ping };
}

/**
 * Ham status metnini oyuncu listesine çevirir. ASLA throw etmez.
 * @returns {{ok:boolean, players:Array<{id:number,name:string,ping:number|null}>, skipped:number, anonymized:boolean}}
 */
function parseStatus(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, players: [], skipped: 0, anonymized: false };
  const players = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const p = parseStatusLine(t);
    if (p) players.push(p);
    else skipped++;
  }
  players.sort((a, b) => a.id - b.id);
  // Anonim placeholder tespiti (public yanıtta gerçek veri yoksa).
  const anonymized =
    players.length > 0 && players.every((p) => p.id === 0 && p.name.toLowerCase() === 'player' && (p.ping === 0 || p.ping === null));
  if (anonymized) return { ok: true, players: [], skipped, anonymized: true };
  return { ok: true, players, skipped, anonymized: false };
}

module.exports = {
  stripColorCodes,
  sanitizeRconName,
  parseStatusLine,
  parseStatus,
  MAX_NAME_LEN,
};
