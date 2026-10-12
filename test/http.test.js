/**
 * HTTP & zincir testleri (Yöntem A/B hata sınıflandırması).
 *
 * Tüm testler YAPAY FiveM sunucusuna (test/helpers/mock-fivem.js) gider.
 * Gerçek sunucu testleri ayrı dosyadadır (test/live.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const { createMockFivem } = require('./helpers/mock-fivem');

const config = require('../src/config');
const { service, client } = require('../src/services/fivem');
const bridge = require('../src/services/fivem/bridge');

// Her testten önce/sonra config'i temizle
const saved = {};
function saveConfig() {
  saved.host = config.fivem.host;
  saved.port = config.fivem.port;
  saved.token = config.fivem.playersToken;
  saved.rconPw = config.fivem.rcon.password;
  saved.bridgeSecret = config.fivem.bridge.secret;
  saved.endpoint = config.fivem.endpoint;
}
function restoreConfig() {
  config.fivem.host = saved.host;
  config.fivem.port = saved.port;
  config.fivem.playersToken = saved.token;
  config.fivem.rcon.password = saved.rconPw;
  config.fivem.bridge.secret = saved.bridgeSecret;
  config.fivem.endpoint = saved.endpoint;
}
/**
 * @param {object} [opts]
 * @param {boolean} [opts.keepBridge] true ise bridge snapshot'ı SİLME
 *        (test bridge verisi ingest ettiyse çağrıldıktan sonra bunu kullan).
 */
function resetAll(opts = {}) {
  client._cache.clear();
  client._inflight.clear();
  service._resetNegCache();
  if (!opts.keepBridge) bridge._reset();
}
saveConfig();

/** Mock sunucuyu ayağa kaldır, config'i yönlendir, testi çalıştır, kapat. */
async function withMock(opts, fn) {
  const mock = createMockFivem(opts);
  const addr = await mock.listen();
  resetAll();
  config.fivem.host = addr.host;
  config.fivem.port = addr.port;
  config.fivem.playersToken = null;
  config.fivem.rcon.password = null;
  config.fivem.bridge.secret = null;
  config.fivem.endpoint = null;
  try {
    return await fn(mock, addr);
  } finally {
    await mock.close();
    resetAll();
    restoreConfig();
  }
}

// ============ YÖNTEM A: PUBLIC HTTP ============

test('A1: sunucu erişilebilir → gerçek oyuncu listesi (LIVE)', async () => {
  await withMock({ mode: 'real' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'LIVE');
    assert.strictEqual(q.baseSource, 'players_public');
    assert.strictEqual(q.players.length, 3);
    assert.strictEqual(q.verified, true);
    // id/name/ping dışında alan SIZDIRILMAZ
    assert.deepStrictEqual(Object.keys(q.players[0]).sort(), ['id', 'name', 'ping']);
    assert.ok(!JSON.stringify(q.players).includes('license:'));
  });
});

test('A2: anonimleştirilmiş yanıt → ANONYMIZED, sahte oyuncu ÜRETİLMEZ', async () => {
  await withMock({ mode: 'anonymized' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ANONYMIZED', 'anonim veri gerçek gibi gösterildi');
    assert.strictEqual(q.players.length, 0, 'sahte oyuncu üretildi');
    // Oyuncu SAYISI yine de dynamic.json'dan doğrulanır
    assert.strictEqual(q.onlineCount, 3);
    assert.strictEqual(q.hostname, 'TEST SUNUCU');
  });
});

test('A3: oyuncu yok → boş liste, ANONYMIZED DEĞİL', async () => {
  await withMock({ mode: 'empty' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'LIVE');
    assert.strictEqual(q.players.length, 0);
    assert.strictEqual(q.onlineCount, 0);
  });
});

test('A4: HTTP 403 → forbidden (erişim engelli)', async () => {
  await withMock({ mode: 'forbidden' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ERROR');
    assert.ok(['forbidden', 'not_configured'].includes(q.detail));
    assert.strictEqual(q.players, null);
  });
});

test('A5: "Nope." (sv_requestParanoia) → forbidden, invalid_json DEĞİL', async () => {
  await withMock({ mode: 'paranoia' }, async () => {
    resetAll();
    const r = await client.fetchJson(`http://${config.fivem.host}:${config.fivem.port}/players.json`, {
      attempts: 1,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'forbidden', `"Nope." yanlış sınıflandırıldı: ${r.kind}`);
    assert.strictEqual(r.status, 200, '"Nope." HTTP 200 ile gelir');
  });
});

test('A6: HTTP 404 → not_found', async () => {
  await withMock({ mode: 'notfound' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ERROR');
    assert.strictEqual(q.detail, 'not_found');
  });
});

test('A7: HTTP 429 → rate_limited', async () => {
  await withMock({ mode: 'ratelimited' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ERROR');
    assert.strictEqual(q.detail, 'rate_limited');
  });
});

test('A8: HTTP 500 → server_error', async () => {
  await withMock({ mode: 'servererror' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ERROR');
    assert.strictEqual(q.detail, 'server_error');
  });
});

test('A9: bozuk JSON → invalid_json', async () => {
  await withMock({ mode: 'badjson' }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ERROR');
    assert.strictEqual(q.detail, 'invalid_json');
  });
});

test('A10: timeout → OFFLINE (ERROR değil), bot çökmez', async () => {
  const oldTimeout = config.fivem.apiTimeoutMs;
  config.fivem.apiTimeoutMs = 800; // testi hızlandır
  await withMock({ mode: 'slow', slowMs: 30000 }, async () => {
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'OFFLINE', `OFFLINE bekleniyordu, ${q.status} geldi`);
    assert.strictEqual(q.detail, 'timeout');
    assert.strictEqual(q.players, null, 'timeout\'ta sahte veri üretilmemeli');
  });
  config.fivem.apiTimeoutMs = oldTimeout;
});

test('A11: sunucu KAPALI (bağlantı reddedilir) → OFFLINE', async () => {
  // Hiçbir şeyi dinlemeyen bir port kullan (sunucu kapalı).
  const dead = createMockFivem({ mode: 'real' });
  const addr = await dead.listen();
  await dead.close(); // hemen kapat → bağlantı reddedilir

  resetAll();
  const oldTimeout = config.fivem.apiTimeoutMs;
  config.fivem.apiTimeoutMs = 2000;
  config.fivem.host = addr.host;
  config.fivem.port = addr.port;
  config.fivem.playersToken = null;
  config.fivem.rcon.password = null;
  config.fivem.bridge.secret = null;
  config.fivem.endpoint = null;

  const q = await service.queryServer();
  assert.strictEqual(q.status, 'OFFLINE', `OFFLINE bekleniyordu, ${q.status} geldi`);
  assert.ok(
    ['connection_refused', 'timeout', 'unreachable', 'connection_reset'].includes(q.detail),
    `beklenmeyen hata türü: ${q.detail}`,
  );
  config.fivem.apiTimeoutMs = oldTimeout;
  resetAll();
  restoreConfig();
});

// ============ YÖNTEM B: X-Players-Token ============

test('B1: token YANLIŞ → 403 → gerçek veri alınmaz (sahte veri YOK)', async () => {
  await withMock({ mode: 'token', token: 'dogru-token' }, async (mock) => {
    config.fivem.playersToken = 'yanlis-token';
    const q = await service.queryServer();
    assert.notStrictEqual(q.status, 'LIVE', 'yanlış tokenla LIVE oldu!');
    assert.strictEqual(q.players === null || q.players.length === 0, true);
  });
});

test('B2: token DOĞRU → gerçek veri LIVE (Yöntem B)', async () => {
  await withMock({ mode: 'token', token: 'gizli-token-abc' }, async () => {
    config.fivem.playersToken = 'gizli-token-abc';
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'LIVE');
    assert.strictEqual(q.baseSource, 'players_token', 'Yöntem B seçilmedi');
    assert.strictEqual(q.players.length, 3);
    assert.strictEqual(q.verified, true);
  });
});

test('B3: token doğru ama sunucu yine de anonim dönerse ANONYMIZED', async () => {
  await withMock({ mode: 'anonymized' }, async () => {
    config.fivem.playersToken = 'bir-token';
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ANONYMIZED');
    assert.strictEqual(q.players.length, 0, 'token varken sahte oyuncu üretildi');
    assert.strictEqual(q.tokenMismatch, true, 'token uyuşmazlığı raporlanmadı');
  });
});

// ============ YÖNTEM C: RESOURCE BRIDGE ============

test('C1: bridge verisi ulaştı → LIVE (Yöntem C, token olmadan)', async () => {
  await withMock({ mode: 'anonymized' }, async () => {
    // Gerçek HTTP sunucusunda anonim veri var; bridge verisi onu EZER.
    config.fivem.bridge.secret = 'bridge-secret-'.padEnd(64, 'x');
    const r = bridge.ingest(
      { players: [{ serverId: 5, name: 'Bridge Oyuncu', ping: 22 }, { serverId: 3, name: 'Diğer', ping: 9 }] },
      'bridge-secret-'.padEnd(64, 'x'),
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);

    // resetAll bridge snapshot'ini SİLMEYİ (veri hâlâ canlı).
    resetAll({ keepBridge: true });
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'LIVE');
    assert.strictEqual(q.baseSource, 'resource_bridge');
    assert.strictEqual(q.players.length, 2);
    assert.ok(q.players.some((p) => p.name === 'Bridge Oyuncu'));
  });
});

test('C2: bridge secret YANLIŞ → veri alınmaz, sunucuya düşülür', async () => {
  await withMock({ mode: 'real' }, async () => {
    config.fivem.bridge.secret = 'dogru-secret-'.padEnd(64, 'y');
    const r = bridge.ingest({ players: [{ serverId: 1, name: 'Hack', ping: 1 }] }, 'yanlis');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 401);
    assert.strictEqual(bridge.getSnapshot().hasData, false);

    resetAll();
    const q = await service.queryServer();
    assert.strictEqual(q.baseSource, 'players_public', 'yetkisiz veri kullanıldı!');
  });
});

test('C3: bayat bridge verisi LIVE sayılmaz', async () => {
  await withMock({ mode: 'anonymized' }, async () => {
    const secret = 'stale-secret-'.padEnd(64, 'z');
    config.fivem.bridge.secret = secret;
    const oldAge = config.fivem.bridge.maxAgeMs;
    config.fivem.bridge.maxAgeMs = 20;
    bridge.ingest({ players: [{ serverId: 1, name: 'Eski', ping: 1 }] }, secret);

    await new Promise((r) => setTimeout(r, 60));
    resetAll();
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'ANONYMIZED', 'bayat veri güncelmiş gibi gösterildi!');
    config.fivem.bridge.maxAgeMs = oldAge;
  });
});

test('C4: bridge önceliği — token da varsa token (B) kazanır', async () => {
  await withMock({ mode: 'token', token: 'tok-123' }, async () => {
    config.fivem.playersToken = 'tok-123';
    const secret = 'prio-secret-'.padEnd(64, 'p');
    config.fivem.bridge.secret = secret;
    bridge.ingest({ players: [{ serverId: 99, name: 'Bridge', ping: 1 }] }, secret);

    resetAll({ keepBridge: true });
    const q = await service.queryServer();
    assert.strictEqual(q.status, 'LIVE');
    assert.strictEqual(q.baseSource, 'players_token', 'Yöntem B önceliği ihlal edildi');
  });
});

test('C5: oyuncu bağlandı / ayrıldı → sayaç güncellenir', async () => {
  await withMock({ mode: 'real' }, async (mock) => {
    resetAll();
    const first = await service.queryServer();
    assert.strictEqual(first.players.length, 3);

    mock.addPlayer({ id: 99, name: 'Yeni Katılan', ping: 12, endpoint: '127.0.0.1', identifiers: [] });
    resetAll();
    const second = await service.queryServer();
    assert.strictEqual(second.players.length, 4, 'yeni oyuncu listelenmedi');
    assert.ok(second.players.some((p) => p.name === 'Yeni Katılan'));

    mock.removePlayer(99);
    resetAll();
    const third = await service.queryServer();
    assert.strictEqual(third.players.length, 3, 'ayrılan oyuncu listeden kalkmadı');
  });
});

// ============ SPAM / HIZ KONTROLÜ ============

test('S1: negatif önbellek — arka arkaya isteklerde tek sorgu yapılır', async () => {
  await withMock({ mode: 'forbidden' }, async (mock) => {
    resetAll();
    await service.queryServer();
    const afterFirst = mock.state.calls.players;
    await service.queryServer();
    await service.queryServer();
    assert.strictEqual(
      mock.state.calls.players,
      afterFirst,
      'negatif önbellek çalışmadı — her komutta sunucuya istek atılıyor',
    );
  });
});

test('S2: coalescing — 10 eşzamanlı sorgu tek HTTP isteği üretir', async () => {
  await withMock({ mode: 'real' }, async (mock) => {
    resetAll();
    mock.resetCalls();
    await Promise.all(Array.from({ length: 10 }, () => service.queryServer()));
    assert.strictEqual(mock.state.calls.players, 1, `beklenen 1 istek, ${mock.state.calls.players} yapıldı`);
  });
});

test('S3: timeout sonrası sonsuz retry YAPILMAZ', async () => {
  const oldTimeout = config.fivem.apiTimeoutMs;
  config.fivem.apiTimeoutMs = 700;
  await withMock({ mode: 'slow', slowMs: 30000 }, async (mock) => {
    resetAll();
    mock.resetCalls();
    const t0 = Date.now();
    await service.queryServer();
    const elapsed = Date.now() - t0;
    // Kontrollü retry: en fazla 2 deneme + 1 kısa bekleme. Sonsuz döngü OLMAZ.
    assert.ok(mock.state.calls.players <= 2, `çok fazla deneme: ${mock.state.calls.players}`);
    assert.ok(elapsed < 10000, `timeout sonrası ${elapsed}ms — aşırı bekleme`);
  });
  config.fivem.apiTimeoutMs = oldTimeout;
});