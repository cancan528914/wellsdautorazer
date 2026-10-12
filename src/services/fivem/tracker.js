/**
 * FiveM sunucu hareketlilik takibi.
 *
 * Sunucu sahibi oyuncu isimlerini paylaşmadığı için takip edebileceğimiz tek
 * gerçek veri **aktif oyuncu SAYISIdır**. Buradan şunlar türetilir:
 *
 *   • Katılma / ayrılma olayları  (sayı farkı)
 *   • Zirve (peak) oyuncu sayısı
 *   • Ortalama ve trend
 *   • Sunucu kapalı olduğunda boşluk (kesintİ sayılmaz)
 *
 * DİKKAT: "katıldı/ayrıldı" bir SAYIM olayıdır; kimin katıldığı bilinmez ve
 * iddia edilmez. Sunucu kapanırsa herkes "ayrıldı" sayılmaz — kesinti işaretlenir.
 */
const config = require('../../config');
const logger = require('../../utils/logger');

const MAX_SAMPLES = Number.isFinite(config.fivem.tracker?.historySize) ? config.fivem.tracker.historySize : 180;
// 180 örnek * 30 sn = 90 dakika geçmiş
const state = {
  startedAt: Date.now(),
  samples: [], // { t, count }
  lastCount: null,
  lastSeenAt: 0,
  peak: { count: 0, at: 0 },
  joined: 0, // bot açıldığından beri toplam artış
  left: 0, // toplam azalış
  lastEvent: null, // { delta, at, from, to }
  outage: false,
  outageSince: null,
};

// Olay dinleyicileri (panel + kanal logu)
const listeners = new Set();

/** @param {(ev:{type:string, delta:number, count:number, from:number, to:number, at:number, outage:boolean})=>void} fn */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(ev) {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (err) {
      logger.error('Tracker dinleyicisi hata verdi.', err);
    }
  }
}

/** Sorgu sonucundan güvenilir oyuncu sayısı çıkar. Sunucu kapalıysa null. */
function countFrom(query) {
  if (!query) return null;
  if (query.status !== 'LIVE' && query.status !== 'ANONYMIZED') return null;
  const n = Number(query.onlineCount ?? (Array.isArray(query.players) ? query.players.length : NaN));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Bir sorgu sonucunu kaydet; değişim varsa olay üret.
 * @param {object} query service.queryServer() sonucu
 * @returns {object|null} üretilen olay (değişim yoksa null)
 */
function record(query) {
  const now = Date.now();
  const count = countFrom(query);

  // --- Sunucu erişilemiyor: kesinti, "herkes ayrıldı" DEĞİL ---
  if (count === null) {
    // Sunucu erişilemiyor. Bu KESİNTİDİR; "herkes ayrıldı" DEĞİLDİR.
    state.lastCount = null; // yeniden bağlandığında karşılaştırma yapılmasın
    if (!state.outage) {
      state.outage = true;
      state.outageSince = now;
      const ev = {
        type: 'offline',
        delta: 0,
        count: 0,
        from: 0,
        to: 0,
        at: now,
        outage: true,
        detail: (query && query.detail) || 'unreachable',
      };
      emit(ev);
      return ev;
    }
    return null;
  }

  // Sunucu tekrar erişilebilir
  const wasOutage = state.outage;
  if (state.outage) {
    state.outage = false;
    logger.info(`FiveM sunucusu tekrar erişilebilir (${Math.round((now - state.outageSince) / 1000)} sn kesintiden sonra).`);
    state.outageSince = null;
  }

  // Örnek ekle
  state.samples.push({ t: now, count });
  if (state.samples.length > MAX_SAMPLES) state.samples.shift();

  if (count > state.peak.count) state.peak = { count, at: now };
  state.lastSeenAt = now;

  // Kesintiden dönüşte veya ilk örnekte karşılaştırma yapma
  if (wasOutage || state.lastCount === null) {
    state.lastCount = count;
    return null;
  }

  const from = state.lastCount;
  const delta = count - from;
  state.lastCount = count;

  if (delta === 0) return null;

  if (delta > 0) state.joined += delta;
  else state.left += -delta;

  const ev = {
    type: delta > 0 ? 'join' : 'leave',
    delta,
    count,
    from,
    to: count,
    at: now,
    outage: false,
  };
  state.lastEvent = ev;
  emit(ev);
  return ev;
}

/** Panel/istatistik özeti. */
function summary() {
  const s = state.samples;
  const counts = s.map((x) => x.count);
  const avg = counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : null;

  // Son 30 dakika
  const now = Date.now();
  const recent = s.filter((x) => now - x.t <= 30 * 60 * 1000);
  const recentAvg = recent.length ? Math.round(recent.reduce((a, b) => a + b + 0, 0) / recent.length) : null;

  // Trend: son yarım saatin başı vs şu an
  let trend = null;
  if (recent.length >= 2) {
    const delta = recent[recent.length - 1].count - recent[0].count;
    trend = delta;
  }

  const fill = s.length >= 2 ? Math.min(100, Math.round(((recent.length / Math.min(MAX_SAMPLES, 60)) * 100) || 0)) : 0;

  return {
    startedAt: state.startedAt,
    uptimeMs: now - state.startedAt,
    sampleCount: s.length,
    current: state.lastCount,
    peak: state.peak,
    avg,
    recentAvg,
    trend,
    joined: state.joined,
    left: state.left,
    lastEvent: state.lastEvent,
    lastSeenAt: state.lastSeenAt,
    outage: state.outage,
    outageSince: state.outageSince,
    samples: s.slice(-60), // sparkline için son 60 örnek
    historyFillPct: fill,
  };
}

/** Kaç dakikadır kesintide (0 = değil). */
function outageMinutes() {
  if (!state.outage || !state.outageSince) return 0;
  return (Date.now() - state.outageSince) / 60000;
}

function reset() {
  state.startedAt = Date.now();
  state.samples.length = 0;
  state.lastCount = null;
  state.lastSeenAt = 0;
  state.peak = { count: 0, at: 0 };
  state.joined = 0;
  state.left = 0;
  state.lastEvent = null;
  state.outage = false;
  state.outageSince = null;
}

module.exports = { record, summary, subscribe, countFrom, outageMinutes, reset, _state: state };