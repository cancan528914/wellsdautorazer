/**
 * Guard event dedup katmanları (log spam'ine karşı ikinci savunma hattı):
 *  1. Audit entry-ID: aynı audit kaydı ASLA iki kez işlenmez (§11, §12).
 *  2. Combo: actor+action+target aynı pencerede tekrar ederse yutulur.
 *     Executor bilinmiyorsa actor=`unknown` ile UNVERIFIED throttle görevi görür.
 * Her ikisi de TTL'li + boyut tavanlıdır (memory leak yok).
 */
const { DEDUPE_ENTRY_TTL_MS, COMBO_TTL_MS } = require('./constants');

const MAX_ENTRIES = 1000;
const MAX_COMBOS = 1000;

// `${guildId}:${entryId}` -> expiry
const seenEntries = new Map();
// `${guildId}:${actorId}:${action}:${targetId}` -> expiry (lastSeen + ttl)
const seenCombos = new Map();

function sweep(map, max, now = Date.now()) {
  try {
    for (const [k, exp] of map) {
      if (typeof exp === 'number' && exp <= now) map.delete(k);
    }
    if (map.size > max) {
      const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of sorted.slice(0, map.size - max)) map.delete(k);
    }
  } catch {
    /* ignore */
  }
}

/**
 * @returns {boolean} true = bu audit kaydı DAHA ÖNCE işlendi (atla)
 */
function seenAuditEntry(guildId, entryId, ttlMs = DEDUPE_ENTRY_TTL_MS) {
  try {
    if (!guildId || !entryId) return false;
    const key = `${guildId}:${entryId}`;
    const now = Date.now();
    const exp = seenEntries.get(key);
    if (exp && exp > now) return true;
    seenEntries.set(key, now + ttlMs);
    if (seenEntries.size % 50 === 0 || seenEntries.size > MAX_ENTRIES) sweep(seenEntries, MAX_ENTRIES, now);
    return false;
  } catch {
    return false;
  }
}

/**
 * @returns {boolean} true = aynı actor+action+target pencerede görüldü (atla)
 */
function seenCombo(guildId, actorId, action, targetId, ttlMs = COMBO_TTL_MS, now = Date.now()) {
  try {
    if (!guildId || !action || !targetId) return false;
    const key = `${guildId}:${actorId || 'unknown'}:${action}:${targetId}`;
    const exp = seenCombos.get(key);
    if (exp && exp > now) return true;
    seenCombos.set(key, now + ttlMs);
    if (seenCombos.size % 50 === 0 || seenCombos.size > MAX_COMBOS) sweep(seenCombos, MAX_COMBOS, now);
    return false;
  } catch {
    return false;
  }
}

module.exports = { seenAuditEntry, seenCombo, _seenEntries: seenEntries, _seenCombos: seenCombos };
