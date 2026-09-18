/**
 * fivem-local-bridge giriş noktası.
 * Provider'ı periyodik yoklar, snapshot'ı bellekte tutar, 127.0.0.1'de sunar.
 * SIGINT/SIGTERM'de hatasız kapanır.
 */
const config = require('./config');
const { loadOrCreateKey } = require('./keyStore');
const { createServer } = require('./server');
const { SimulatorProvider } = require('./providers/simulator');

function createStore() {
  let state = { players: [], selfId: null, source: 'none', stale: true, updatedAt: 0, error: 'NO_DATA_YET' };
  return {
    get: () => ({ ...state, players: [...state.players] }),
    set: (patch) => {
      state = { ...state, ...patch, updatedAt: Date.now() };
    },
  };
}

async function main() {
  const { key, created } = loadOrCreateKey();
  const providerName = config.provider;
  let provider = null;
  if (providerName === 'simulator') {
    provider = new SimulatorProvider();
  } else {
    console.error(`[bridge] bilinmeyen provider: ${providerName} (desteklenen: simulator)`);
    process.exit(1);
  }

  const store = createStore();
  const app = createServer({ store, apiKey: key, rateWindowMs: config.rateWindowMs, rateMax: config.rateMax });

  let stopped = false;
  async function pollOnce() {
    if (stopped) return;
    try {
      const snap = await provider.getSnapshot();
      const { validateSnapshot } = require('./providers/base');
      const clean = validateSnapshot(snap);
      store.set({ players: clean.players, selfId: clean.selfId, source: providerName, stale: false, error: null });
    } catch (err) {
      // Provider hatası köprüyü devirmez: son snapshot stale işaretlenir.
      const cur = store.get();
      store.set({ stale: true, error: String((err && err.message) || err).slice(0, 200) });
      if (!cur.players.length) store.set({ players: [], selfId: null });
      console.error(`[bridge] provider hatası (stale=true): ${err && err.message ? err.message : err}`);
    }
  }

  await pollOnce();
  const timer = setInterval(pollOnce, config.pollMs);
  if (typeof timer.unref === 'function') timer.unref();

  const server = app.listen(config.port, config.host, () => {
    console.log(`[bridge] dinleniyor: http://${config.host}:${config.port} (provider=${providerName})`);
    if (created) {
      console.log('[bridge] YENİ API anahtarı üretildi (data/.bridge-key). Botun FIVEM_LOCAL_BRIDGE_KEY değerine yazın.');
      console.log(`[bridge] API-KEY: ${key}`);
    } else {
      console.log('[bridge] API anahtarı yüklendi (değer güvenlik için yazdırılmıyor).');
    }
  });

  function shutdown(signal) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
    console.log(`[bridge] kapanıyor (${signal})...`);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => console.error('[bridge] unhandledRejection:', e && e.message ? e.message : e));
}

main().catch((err) => {
  console.error('[bridge] başlatılamadı:', err && err.message ? err.message : err);
  process.exit(1);
});
