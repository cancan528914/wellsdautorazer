/**
 * Audit Log executor doğrulama.
 * Sadece "en son kayıt" alınmaz: action type + target ID + zaman penceresi eşleşir.
 * Event Audit Log'dan önce gelebileceği için sınırlı retry yapılır (sonsuz değil).
 * Hız için: aynı guild+tip için 5sn'lik bellek cache'i (eşleşme kuralları aynı).
 */
const logger = require('../utils/logger');
const { AUDIT_RETRY_ATTEMPTS, AUDIT_RETRY_DELAY_MS, AUDIT_MATCH_WINDOW_MS, AUDIT_CACHE_TTL_MS } = require('./constants');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `${guildId}:${auditType}` -> { ts, entries: [{ targetId, executor, createdTimestamp, action }] }
const auditCache = new Map();

function matchEntries(entries, targetId, now) {
  const wanted = String(targetId);
  return (entries || [])
    .filter((e) => e && String(e.targetId) === wanted && now - e.createdTimestamp < AUDIT_MATCH_WINDOW_MS)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

function toCacheable(rawEntries) {
  const out = [];
  try {
    for (const e of rawEntries?.values?.() || []) {
      if (!e?.target || !e?.executor) continue;
      out.push({ targetId: String(e.target.id), executor: e.executor, createdTimestamp: e.createdTimestamp, action: e.action, changes: e.changes });
    }
  } catch {
    /* yoksay */
  }
  return out.slice(0, 10);
}

/**
 * @returns {Promise<{ executor: object, entry: object } | null>}
 */
async function findExecutor(guild, auditType, targetId, opts = {}) {
  const attempts = opts.attempts || AUDIT_RETRY_ATTEMPTS;
  const cacheKey = `${guild.id}:${auditType}`;

  // 1. Taze cache varsa API'ye gitmeden dene
  try {
    const hit = auditCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < AUDIT_CACHE_TTL_MS) {
      const matched = matchEntries(hit.entries, targetId, Date.now());
      if (matched.length) return { executor: matched[0].executor, entry: matched[0] };
    }
  } catch {
    /* cache hatası aramayı engellemez */
  }

  // 2. Canlı sorgu (sınırlı retry)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 });
      const cached = toCacheable(logs?.entries);
      try {
        auditCache.set(cacheKey, { ts: Date.now(), entries: cached });
        if (auditCache.size > 200) {
          // en eski girdileri buda (memory leak yok)
          const sorted = [...auditCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
          for (const [k] of sorted.slice(0, auditCache.size - 200)) auditCache.delete(k);
        }
      } catch {
        /* ignore */
      }
      const matched = matchEntries(cached, targetId, Date.now());
      if (matched.length) return { executor: matched[0].executor, entry: matched[0] };
    } catch (err) {
      logger.warn(`Audit log okunamadı (${auditType}, deneme ${attempt}/${attempts}): ${err.code || err.message}`);
    }
    if (attempt < attempts) await sleep(opts.delayMs || AUDIT_RETRY_DELAY_MS);
  }
  return null;
}

module.exports = { findExecutor, _auditCache: auditCache };
