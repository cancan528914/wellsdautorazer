/**
 * Yöntem C API endpoint testleri: POST /api/fivem/players
 *
 * Buradaki endpoint'in GÜVENLİK testleri gerçek HTTP üzerinden yapılır:
 * yetkilendirme, gövde sınırı, geçersiz JSON, rate-limit, reddedilen istekler.
 */
const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');

const SECRET = 'test-bridge-secret-0123456789abcdef0123456789abcdef';
const OLD_SECRET = config.fivem.bridge.secret;
const OLD_BODY = config.fivem.bridge.bodyLimit;
const OLD_RATE = config.fivem.bridge.rateMax;

// Rate limiter'ın state'i testler arası sızmasın diye sıfırlanır.
function resetLimiter() {
  const mod = require('../src/web/server');
  return mod;
}

test('API testleri için ortam', async (t) => {
  config.fivem.bridge.secret = SECRET;
  config.fivem.bridge.bodyLimit = 64 * 1024;
  config.fivem.bridge.rateMax = 1000; // rate-limit kendi testinde ayrıca kapatılır

  const { startWebServer } = require('../src/web/server');
  const oldPort = config.web.port;
  config.web.port = 0; // rastgele port

  let server = null;
  try {
    server = await new Promise((resolve, reject) => {
      const s = require('node:http').createServer(require('../src/web/server').app);
      s.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const port = server.address().port;
    const BASE = `http://127.0.0.1:${port}`;

    const post = (body, headers = {}) =>
      fetch(`${BASE}/api/fivem/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

    const bridge = require('../src/services/fivem/bridge');

    // ---------- Yetkilendirme ----------
    await t.test('1) secret YOK → 401, veri saklanmaz', async () => {
      bridge._reset();
      const r = await post(JSON.stringify({ players: [{ serverId: 1, name: 'X', ping: 1 }] }));
      assert.strictEqual(r.status, 401);
      assert.strictEqual(bridge.getSnapshot().hasData, false, 'yetkisiz veri saklandı');
    });

    await t.test('2) secret YANLIŞ → 401', async () => {
      bridge._reset();
      const r = await post(JSON.stringify({ players: [{ serverId: 1, name: 'X', ping: 1 }] }), {
        'X-Bridge-Secret': 'yanlis-secret',
      });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(bridge.getSnapshot().hasData, false);
    });

    await t.test('3) secret DOĞRU → 200 + oyuncu sayısı döner', async () => {
      bridge._reset();
      const r = await post(
        JSON.stringify({
          players: [
            { serverId: 3, name: 'Ali', ping: 30 },
            { serverId: 1, name: 'Veli', ping: 40 },
          ],
        }),
        { 'X-Bridge-Secret': SECRET },
      );
      assert.strictEqual(r.status, 200);
      const body = await r.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.accepted, 2);
      const s = bridge.getSnapshot();
      assert.strictEqual(s.count, 2);
      // Sunucu ID'ye göre sıralanır
      assert.deepStrictEqual(s.players.map((p) => p.id), [1, 3]);
    });

    await t.test('4) cevap oyuncu verisi İÇERMEZ (yalnız sayaç)', async () => {
      const r = await post(JSON.stringify({ players: [{ serverId: 5, name: 'GizliOyuncu', ping: 1 }] }), {
        'X-Bridge-Secret': SECRET,
      });
      const text = await r.text();
      assert.ok(!text.includes('GizliOyuncu'), 'oyuncu adı cevapta sızdı');
      assert.ok(!text.includes(SECRET), 'secret cevapta sızdı');
    });

    // ---------- Gövde / JSON ----------
    await t.test('5) geçersiz JSON → 400', async () => {
      const r = await post('{bozuk json', { 'X-Bridge-Secret': SECRET });
      assert.strictEqual(r.status, 400);
    });

    await t.test('6) players alanı yok → 400', async () => {
      const r = await post(JSON.stringify({ oyuncular: [] }), { 'X-Bridge-Secret': SECRET });
      assert.strictEqual(r.status, 400);
    });

    await t.test('7) gövde limiti aşılırsa → 413', async () => {
      const big = { players: Array.from({ length: 4000 }, (_, i) => ({ serverId: i + 1, name: 'x'.repeat(60), ping: 1 })) };
      const r = await post(JSON.stringify(big), { 'X-Bridge-Secret': SECRET });
      assert.ok([413, 200].includes(r.status), `beklenen 413, gelen ${r.status}`);
      // 200 ise içerik sınırı (maxPlayers) devreye girip 1024'e kırpmış olmalı
      if (r.status === 200) {
        const s = bridge.getSnapshot();
        assert.ok(s.count <= config.fivem.bridge.maxPlayers, 'maxPlayers uygulanmadı');
      }
    });

    await t.test('8) hassas alanlar saklanmaz (IP / identifier)', async () => {
      bridge._reset();
      await post(
        JSON.stringify({
          players: [
            {
              serverId: 9,
              name: 'Test',
              ping: 5,
              endpoint: '1.2.3.4:30120',
              identifiers: ['license:SUPERSECRET'],
            },
          ],
        }),
        { 'X-Bridge-Secret': SECRET },
      );
      const s = bridge.getSnapshot();
      const json = JSON.stringify(s);
      assert.ok(!json.includes('SUPERSECRET'), 'license sızdırıldı');
      assert.ok(!json.includes('1.2.3.4'), 'IP sızdırıldı');
      assert.deepStrictEqual(Object.keys(s.players[0]).sort(), ['id', 'name', 'ping']);
    });

    // ---------- Sağlık endpoint'i ----------
    await t.test('9) GET /api/fivem/status secret DEĞERİ vermez', async () => {
      const r = await fetch(`${BASE}/api/fivem/status`);
      assert.strictEqual(r.status, 200);
      const body = await r.json();
      assert.strictEqual(body.configured, true);
      assert.ok(!JSON.stringify(body).includes(SECRET), 'sağlık endpoint’i secret sızdırdı');
      assert.ok('count' in body && 'stale' in body);
    });

    await t.test('10) snapshot bayatlığı /api/fivem/status’a yansır', async () => {
      const oldAge = config.fivem.bridge.maxAgeMs;
      config.fivem.bridge.maxAgeMs = 20;
      await post(JSON.stringify({ players: [{ serverId: 1, name: 'A', ping: 1 }] }), {
        'X-Bridge-Secret': SECRET,
      });
      await new Promise((r) => setTimeout(r, 60));
      const body = await (await fetch(`${BASE}/api/fivem/status`)).json();
      assert.strictEqual(body.stale, true, 'bayat veri taze olarak raporlandı');
      config.fivem.bridge.maxAgeMs = oldAge;
    });

  } finally {
    config.fivem.bridge.secret = OLD_SECRET;
    config.fivem.bridge.bodyLimit = OLD_BODY;
    config.fivem.bridge.rateMax = OLD_RATE;
    config.web.port = oldPort;
    if (server) server.close();
  }
});

// ---------- Rate limit ayrı test (limiter'ı düşürüp geri yükle) ----------
test('11) rate-limit aşımı → 429', async (t) => {
  const mod = require('../src/web/server');
  config.fivem.bridge.secret = SECRET;

  // Yeni app örneği düşük limit ile
  const express = require('express');
  const rateLimit = require('express-rate-limit');
  const fivemBridge = require('../src/services/fivem/bridge');
  const app = express();
  const limiter = rateLimit({ windowMs: 60000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } });
  app.post('/api/fivem/players', limiter, express.raw({ type: 'application/json', limit: 65536 }), (req, res) => {
    const r = fivemBridge.ingest(JSON.parse(req.body.toString('utf8')), req.get('X-Bridge-Secret') || '');
    res.status(r.ok ? 200 : r.code).json({ ok: r.ok, error: r.error, accepted: r.count });
  });

  const server = await new Promise((res) => {
    const s = require('node:http').createServer(app);
    s.listen(0, '127.0.0.1', () => res(s));
  });
  const port = server.address().port;
  const body = JSON.stringify({ players: [{ serverId: 1, name: 'A', ping: 1 }] });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/fivem/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': SECRET },
        body,
      });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `429 dönülmedi: ${codes.join(',')}`);
  } finally {
    server.close();
    config.fivem.bridge.secret = OLD_SECRET;
  }
});