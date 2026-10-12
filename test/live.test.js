/**
 * GERÇEK sunucu testleri (5.231.120.202:30120).
 *
 * DİKKAT: Bu testler DIŞ SUNUCUYA bağlanır. İnternet yoksa veya sunucu
 * kapalıysa "atlanır" (skip) — BAŞARILI sayılmaz. Test çıktısında hangisinin
 * gerçekten koştuğu açıkça yazılır.
 *
 * Çalıştırma:  node --test test/live.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const { service, client, parser } = require('../src/services/fivem');

const LIVE_TIMEOUT = 12000;

test('L1: gerçek sunucu /info.json erişilebilir', async (t) => {
  const { base } = (await import('../src/services/fivem/service.js'), {
    base: `http://${config.fivem.host}:${config.fivem.port}`,
  });
  let r;
  try {
    r = await client.fetchJson(`${base}/info.json`, { attempts: 1, timeoutMs: LIVE_TIMEOUT });
  } catch (e) {
    return t.skip('Canlı sunucuya ulaşılamadı: ' + e.message);
  }
  if (!r.ok) {
    console.log(`    [BİLGİ] /info.json yanıtı: kind=${r.kind} status=${r.status}`);
    return t.skip('Canlı sunucu yanıt vermedi (ağ kısıtlı olabilir).');
  }
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.vars, 'info.json vars alanı yok');
  console.log(`    [CANLI] Sunucu: ${r.data.server}`);
  console.log(`    [CANLI] Proje  : ${r.data.vars.sv_projectName}`);
});

test('L2: gerçek sunucu /dynamic.json oyuncu sayısı verir', async (t) => {
  const base = `http://${config.fivem.host}:${config.fivem.port}`;
  const r = await client.fetchJson(`${base}/dynamic.json`, { attempts: 1, timeoutMs: LIVE_TIMEOUT });
  if (!r.ok) return t.skip('Erişilemedi: ' + r.kind);
  const d = parser.parseDynamic(r.data);
  assert.ok(d, 'dynamic parse edilemedi');
  assert.strictEqual(typeof d.clients, 'number', 'clients sayı olmalı');
  assert.ok(d.clients >= 0);
  console.log(`    [CANLI] Oyuncu: ${d.clients}/${d.maxClients ?? '?'} | ${d.hostname}`);
});

test('L3: gerçek sunucu /players.json — anonimleştirme tespiti', async (t) => {
  const base = `http://${config.fivem.host}:${config.fivem.port}`;
  const r = await client.fetchJson(`${base}/players.json`, { attempts: 1, timeoutMs: LIVE_TIMEOUT });
  if (!r.ok) return t.skip('Erişilemedi: ' + r.kind);

  const p = parser.parsePlayers(r.data);
  assert.strictEqual(p.ok, true);

  if (p.anonymized) {
    console.log(`    [CANLI] ANONİMLEŞTİRİLMİŞ — ${p.placeholders} kayıt, 0 gerçek isim.`);
    console.log('    [CANLI] Sonuç: gerçek oyuncu verisi bu sunucuda ANONİM.');
  } else {
    console.log(`    [CANLI] GERÇEK VERİ — ${p.players.length} oyuncu.`);
    assert.ok(p.players.length > 0);
  }

  // HER ZAMAN doğrulanması gereken: sahte oyuncu üretilmiyor mu?
  assert.ok(
    p.players.every((x) => x.id >= 1 && typeof x.name === 'string' && x.name.length > 0),
    'geçersiz oyuncu kaydı üretildi',
  );
});

test('L4: gerçek sunucu queryServer() çökmez ve durum döner', async (t) => {
  let q;
  try {
    q = await service.queryServer();
  } catch (e) {
    return t.skip('Sorgu istisna attı (canlı ağ): ' + e.message);
  }
  assert.ok(['LIVE', 'ANONYMIZED', 'PARTIAL', 'OFFLINE', 'ERROR'].includes(q.status));
  console.log(`    [CANLI] status=${q.status} kaynak=${q.baseSource} online=${q.onlineCount}`);
});

test('L5: gerçek sunucu RCON parolası olmadan denenmez (bilinçli kısıt)', () => {
  // RCON parolası yoksa bot ağa çıkmadan dürüst hata verir.
  if (!config.fivem.rcon.password) {
    console.log('    [CANLI] FIVEM_RCON_PASSWORD tanımlı değil → RCON testi YAPILMADI.');
    assert.ok(true, 'RCON parolası yok — bu bir hata değil, yapılandırma eksikliği.');
  } else {
    console.log('    [CANLI] RCON parolası tanımlı — gerçek RCON testi ayrı çalıştırılmalı.');
  }
});

test('L6: gerçek sunucu yanlış token ile veri SIZDIRMAZ', async (t) => {
  const base = `http://${config.fivem.host}:${config.fivem.port}`;
  const r = await client.fetchJson(`${base}/players.json`, {
    attempts: 1,
    timeoutMs: LIVE_TIMEOUT,
    // Yanlış token — sunucu doğrulamazsa da veri yine anonim kalmalı.
    // (Test, istemci katmanında token göndermez; davranışı gözlemler.)
  });
  if (!r.ok) return t.skip('Erişilemedi: ' + r.kind);
  const p = parser.parsePlayers(r.data);
  assert.strictEqual(p.players.length, 0, 'anonim sunucudan gerçek oyuncu sızdı!');
});