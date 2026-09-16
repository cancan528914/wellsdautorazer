/**
 * Incident gruplama: aynı saldırganın kısa penceredeki tüm işlemleri tek olayda toplanır.
 * - Tek punishment (ilk ihlalde ban, sonrakilerde atlanır).
 * - Tüm mümkün rollbackler yine de denenir.
 * - Logda incident özeti görünür.
 * TTL + boyut tavanlıdır (memory leak yok).
 */
const INCIDENT_TTL_MS = 5 * 60 * 1000;
const INCIDENT_MAX = 200;

const incidents = new Map(); // `${guildId}:${executorId}` -> { count, actions: [], targets: [], firstSeen, lastSeen, punished }

function sweep(now = Date.now()) {
  try {
    for (const [k, v] of incidents) {
      if (!v || v.lastSeen + INCIDENT_TTL_MS <= now) incidents.delete(k);
    }
    if (incidents.size > INCIDENT_MAX) {
      const sorted = [...incidents.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [k] of sorted.slice(0, incidents.size - INCIDENT_MAX)) incidents.delete(k);
    }
  } catch {
    /* ignore */
  }
}

function keyOf(guildId, executorId) {
  return `${guildId}:${executorId}`;
}

/** Olayı incidente işler, güncel incident nesnesini döner. */
function recordIncident(guildId, executorId, action, targetId) {
  const key = keyOf(guildId, executorId);
  const now = Date.now();
  let inc = incidents.get(key);
  if (!inc || inc.lastSeen + INCIDENT_TTL_MS <= now) {
    inc = { count: 0, actions: [], targets: [], firstSeen: now, lastSeen: now, punished: false };
  }
  inc.count += 1;
  inc.lastSeen = now;
  if (action && !inc.actions.includes(action)) inc.actions.push(action);
  if (targetId && !inc.targets.includes(String(targetId)) && inc.targets.length < 20) {
    inc.targets.push(String(targetId));
  }
  incidents.set(key, inc);
  if (incidents.size % 20 === 0 || incidents.size > INCIDENT_MAX) sweep(now);
  return inc;
}

function markIncidentPunished(guildId, executorId) {
  try {
    const inc = incidents.get(keyOf(guildId, executorId));
    if (inc) inc.punished = true;
  } catch {
    /* ignore */
  }
}

function getIncident(guildId, executorId) {
  try {
    const inc = incidents.get(keyOf(guildId, executorId));
    if (!inc || inc.lastSeen + INCIDENT_TTL_MS <= Date.now()) return null;
    return inc;
  } catch {
    return null;
  }
}

module.exports = { recordIncident, markIncidentPunished, getIncident, INCIDENT_TTL_MS, _incidents: incidents };
