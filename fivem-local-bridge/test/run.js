/**
 * Bridge testleri (bağımlılıksız, düz node:assert).
 * Gerçek FiveM gerekmez: ephemeral port + sabit test provider + ingest.
 */
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { validateSnapshot } = require('../src/providers/base');
const { SimulatorProvider } = require('../src/providers/simulator');

const results = [];
async function t(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`✅ ${name}`);
  } catch (err) {
    results.push({ name, pass: false });
    console.log(`❌ ${name} — ${err.message}`);
  }
}

function fixedProvider() {
  return {
    async getSnapshot() {
      return {
        players: [
          { id: 12, name: 'Javrex', ping: 38 },
          { id: 27, name: 'PlayerTest', ping: 51 },
          { id: 43, name: 'ABC', ping: 29 },
        ],
        selfId: 12,
      };
    },
  };
}

function createStore(initial) {
  let state = initial || { players: [], selfId: null, source: 'test', stale: false, updatedAt: Date.now(), error: null };
  return {
    get: () => ({ ...state, players: [...state.players] }),
    set: (patch) => {
      state = { ...state, ...patch, updatedAt: Date.now() };
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const KEY = 'test-key-1234567890abcdef';

async function main() {
  // --- validateSnapshot ---
  await t('validate: geçerli liste', () => {
    const c = validateSnapshot({ players: [{ id: 1, name: 'A', ping: 5 }], selfId: 1 });
    assert.equal(c.players.length, 1);
    assert.equal(c.dropped, 0);
    assert.equal(c.selfId, 1);
  });
  await t('validate: bozuk kayıtlar atılır', () => {
    const c = validateSnapshot({ players: [{ id: 0, name: 'X' }, { id: 2, name: '' }, null, { id: 3, name: 'Ok', ping: -5 }, { id: 4, name: 'P', ping: 1.9 }] });
    assert.equal(c.players.length, 2); // id 3 (ping null olur), id 4 (ping 1)
    assert.equal(c.dropped, 3);
    assert.equal(c.players.find((p) => p.id === 3).ping, null);
  });
  await t('validate: 2000 üst sınır', () => {
    const arr = Array.from({ length: 2100 }, (_, i) => ({ id: i + 1, name: `P${i}`, ping: 1 }));
    assert.equal(validateSnapshot({ players: arr }).players.length, 2000);
  });

  // --- simulator churn ---
  await t('simulator: snapshot üretir', async () => {
    const sim = new SimulatorProvider();
    const s = await sim.getSnapshot();
    assert.ok(s.players.length >= 2);
    assert.ok(s.players.every((p) => p.id > 0 && p.name && p.ping >= 5));
  });
  await t('simulator: churn zamanla değişir', async () => {
    const sim = new SimulatorProvider();
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const s = await sim.getSnapshot();
      seen.add(JSON.stringify(s.players.map((p) => p.id).sort()));
      if (seen.size > 1) break;
    }
    assert.ok(seen.size > 1, 'liste hiç değişmedi');
  });

  // --- HTTP API ---
  const store = createStore();
  {
    const snap = await fixedProvider().getSnapshot();
    const clean = validateSnapshot(snap);
    store.set({ players: clean.players, selfId: clean.selfId, source: 'test', stale: false, error: null });
  }
  const app = createServer({ store, apiKey: KEY, rateWindowMs: 60000, rateMax: 1000 });
  const srv = await listen(app);
  const B = base(srv);
  const H = { 'X-Bridge-Key': KEY };

  await t('GET /health anahtarsız', async () => {
    const r = await fetch(`${B}/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });
  await t('GET /players anahtarsız 401', async () => {
    const r = await fetch(`${B}/players`);
    assert.equal(r.status, 401);
  });
  await t('GET /players yanlış anahtar 401', async () => {
    const r = await fetch(`${B}/players`, { headers: { 'X-Bridge-Key': 'nope' } });
    assert.equal(r.status, 401);
  });
  await t('GET /players örnek çıktı', async () => {
    const r = await fetch(`${B}/players`, { headers: H });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.success, true);
    assert.equal(j.count, 3);
    assert.deepEqual(j.players[0], { id: 12, name: 'Javrex', ping: 38 });
  });
  await t('GET /player/27', async () => {
    const r = await fetch(`${B}/player/27`, { headers: H });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).player.name, 'PlayerTest');
  });
  await t('GET /player/999 → 404', async () => {
    const r = await fetch(`${B}/player/999`, { headers: H });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).success, false);
  });
  await t('GET /player/abc → 400', async () => {
    const r = await fetch(`${B}/player/abc`, { headers: H });
    assert.equal(r.status, 400);
  });
  await t('GET /status', async () => {
    const j = await (await fetch(`${B}/status`, { headers: H })).json();
    assert.equal(j.success, true);
    assert.equal(j.count, 3);
    assert.equal(j.selfId, 12);
    assert.equal(j.online, true);
  });
  await t('POST /ingest snapshot yazar', async () => {
    const r = await fetch(`${B}/ingest`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: [{ id: 5, name: 'Pushed', ping: 11 }], selfId: 5 }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).count, 1);
    const back = await (await fetch(`${B}/players`, { headers: H })).json();
    assert.equal(back.players[0].name, 'Pushed');
    assert.equal(back.source, 'push');
  });
  await t('POST /ingest bozuk kayıtları eler', async () => {
    const r = await fetch(`${B}/ingest`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: [{ id: 1, name: 'A', ping: 1 }, { id: -2, name: 'Bad' }] }),
    });
    const j = await r.json();
    assert.equal(j.count, 1);
    assert.equal(j.dropped, 1);
  });
  await t('POST /ingest anahtarsız 401', async () => {
    const r = await fetch(`${B}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  });
  await t('bilinmeyen rota 404 JSON', async () => {
    const r = await fetch(`${B}/nope`, { headers: H });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).success, false);
  });
  await t('bozuk JSON 400', async () => {
    const r = await fetch(`${B}/ingest`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{bozuk' });
    assert.equal(r.status, 400);
  });

  // --- rate limit (dar pencereli ayrı app) ---
  const rlApp = createServer({ store, apiKey: KEY, rateWindowMs: 2000, rateMax: 3 });
  const rlSrv = await listen(rlApp);
  const RB = base(rlSrv);
  await t('rate limit 429', async () => {
    let limited = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${RB}/players`, { headers: H });
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, 'hiç 429 alınamadı');
  });

  await new Promise((r) => srv.close(r));
  await new Promise((r) => rlSrv.close(r));

  console.log(`\nTOPLAM: ${results.length} | GEÇEN: ${results.filter((r) => r.pass).length} | KALAN: ${results.filter((r) => !r.pass).length}`);
  for (const f of results.filter((r) => !r.pass)) console.log(`[FAIL] ${f.name}`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(2);
});
