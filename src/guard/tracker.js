/**
 * Internal-action tracking: botun kendi Guard işlemleri (rollback/ban) yeni bir
 * saldırı olarak algılanmamalı. Kısa ömürlü bellek içi kayıt (TTL'li).
 */
const { TRACK_TTL_MS } = require('./constants');

const recent = new Map(); // `${guildId}:${auditType}:${targetId}` -> expiry timestamp

function keyOf(guildId, auditType, targetId) {
  return `${guildId}:${auditType}:${targetId}`;
}

function sweep() {
  const now = Date.now();
  for (const [k, exp] of recent) {
    if (exp <= now) recent.delete(k);
  }
  if (recent.size > 500) {
    // taşmaya karşı en eskileri buda
    const sorted = [...recent.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, recent.size - 500)) recent.delete(k);
  }
}

function markBotAction(guildId, auditType, targetId) {
  try {
    recent.set(keyOf(guildId, auditType, targetId), Date.now() + TRACK_TTL_MS);
    if (recent.size % 50 === 0) sweep();
  } catch {
    /* takip kritik değil */
  }
}

function isBotAction(guildId, auditType, targetId) {
  try {
    const exp = recent.get(keyOf(guildId, auditType, targetId));
    if (!exp) return false;
    if (exp <= Date.now()) {
      recent.delete(keyOf(guildId, auditType, targetId));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { markBotAction, isBotAction, _recent: recent };
