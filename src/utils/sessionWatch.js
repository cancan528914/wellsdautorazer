/**
 * Gateway oturum çakışma dedektörü.
 * Aynı token ile 2 örnek (PC + Railway/VPS, veya 2 replika) çalışırsa gateway
 * sürekli düşer ve ses dahil her şey kopar. Bunu gürültülü şekilde belli eder.
 */
const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 3;

function createSessionWatch({ windowMs = WINDOW_MS, threshold = THRESHOLD, onWarn } = {}) {
  const times = [];
  return {
    noteDisconnect(now = Date.now()) {
      times.push(now);
      while (times.length && now - times[0] > windowMs) times.shift();
      if (times.length >= threshold) {
        times.length = 0;
        try {
          if (onWarn) onWarn();
        } catch {
          /* uyarı kritik değil */
        }
        return true;
      }
      return false;
    },
    _times: times,
  };
}

module.exports = { createSessionWatch, WINDOW_MS, THRESHOLD };
