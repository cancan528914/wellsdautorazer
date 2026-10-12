/**
 * Birim testleri: parser, güvenlik, adres normalizasyonu, bridge doğrulama.
 * AĞ KULLANMAZ — tamamen yerel ve deterministik.
 */
const test = require('node:test');
const assert = require('node:assert');

const parser = require('../src/services/fivem/parser');
const client = require('../src/services/fivem/client');
const bridge = require('../src/services/fivem/bridge');
const config = require('../src/config');

// ==================== PARSER ====================

test('parsePlayers: gerçek veriyi doğru okur', () => {
  const r = parser.parsePlayers([
    { id: 5, name: 'Ali', ping: 20, endpoint: '1.2.3.4:30120', identifiers: ['license:x'] },
    { id: 2, name: 'Veli', ping: 55 },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.anonymized, false);
  assert.strictEqual(r.players.length, 2);
  // Sunucu ID artan sıralanır
  assert.deepStrictEqual(r.players.map((p) => p.id), [2, 5]);
});

test('parsePlayers: yalnız id/name/png dışarı verir (identifier SIZDIRMAZ)', () => {
  const r = parser.parsePlayers([
    { id: 5, name: 'Ali', ping: 20, endpoint: '1.2.3.4:30120', identifiers: ['license:SECRET'] },
  ]);
  const keys = Object.keys(r.players[0]).sort();
  assert.deepStrictEqual(keys, ['id', 'name', 'ping']);
  const json = JSON.stringify(r.players[0]);
  assert.ok(!json.includes('SECRET'), 'license sızdırıldı!');
  assert.ok(!json.includes('1.2.3.4'), 'IP sızdırıldı!');
});

test('parsePlayers: tüm kayıtlar id=0/Player ise ANONYMIZED sayılır', () => {
  const r = parser.parsePlayers([
    { id: 0, name: 'Player', ping: 0, endpoint: '127.0.0.1', identifiers: [] },
    { id: 0, name: 'Player', ping: 0, endpoint: '127.0.0.1', identifiers: [] },
  ]);
  assert.strictEqual(r.anonymized, true, 'anonimleştirilmiş veri gerçek gibi gösterildi!');
  assert.strictEqual(r.players.length, 0);
});

test('parsePlayers: karışık listede gerçek kayıt varsa anonim DEĞİL', () => {
  const r = parser.parsePlayers([
    { id: 0, name: 'Player', ping: 0 },
    { id: 9, name: 'Gerçek', ping: 10 },
  ]);
  assert.strictEqual(r.anonymized, false);
  assert.strictEqual(r.players.length, 1);
});

test('parsePlayers: boş liste ANONYMIZED değildir (sunucuda oyuncu yok)', () => {
  const r = parser.parsePlayers([]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.anonymized, false, 'boş liste anonim sanılmamalı');
  assert.strictEqual(r.players.length, 0);
});

test('parsePlayers: dizi değilse ok:false döner (throw etmez)', () => {
  assert.strictEqual(parser.parsePlayers(null).ok, false);
  assert.strictEqual(parser.parsePlayers('hata').ok, false);
  assert.strictEqual(parser.parsePlayers({ a: 1 }).ok, false);
});

test('parsePlayers: bozuk kayıtlar atlanır, skipped sayılır', () => {
  const r = parser.parsePlayers([
    { id: 'abc', name: 'X' },
    null,
    'string',
    { id: 999999, name: 'Fazla' },
    { id: 3, name: 'İyi' },
  ]);
  assert.strictEqual(r.players.length, 1);
  assert.strictEqual(r.players[0].id, 3);
  assert.ok(r.skipped >= 4);
});

test('sanitizeName: @everyone ve mention kaçışı kırılır', () => {
  const evil = parser.sanitizeName('@everyone <@123> **bold**');
  assert.ok(!evil.includes('@everyone'), '@everyone kırılmadı');
  assert.ok(!evil.includes('<@'), 'mention kırılmadı');
});

test('sanitizeName: newline temizlenir', () => {
  assert.ok(!parser.sanitizeName('ali\nve\nveli').includes('\n'));
});

test('validatePlayerId: yalnız 1..100000 tam sayı', () => {
  assert.strictEqual(parser.validatePlayerId('42'), 42);
  assert.strictEqual(parser.validatePlayerId(42), 42);
  assert.strictEqual(parser.validatePlayerId('0'), null);
  assert.strictEqual(parser.validatePlayerId('-1'), null);
  assert.strictEqual(parser.validatePlayerId('abc'), null);
  assert.strictEqual(parser.validatePlayerId(''), null);
  assert.strictEqual(parser.validatePlayerId('999999'), null);
});

test('searchByName: Türkçe İ/ı ve büyük/küçük harf duyarsız', () => {
  const list = [{ id: 1, name: 'İbrahim' }, { id: 2, name: 'Wellsd' }];
  assert.deepStrictEqual(parser.searchByName(list, 'wellsd').map((p) => p.id), [2]);
  assert.deepStrictEqual(parser.searchByName(list, 'WELLSD').map((p) => p.id), [2]);
  assert.deepStrictEqual(parser.searchByName(list, 'ibrahim').map((p) => p.id), [1]);
});

// ==================== ADRES NORMALİZASYONU ====================

test('normalizeBase: geçersiz/şüpheli girdileri reddeder (sahte host üretmez)', () => {
  assert.strictEqual(client.normalizeBase(''), null);
  assert.strictEqual(client.normalizeBase('ftp://x.com'), null, 'ftp kabul edildi');
  assert.strictEqual(client.normalizeBase('http://'), null);
  assert.strictEqual(client.normalizeBase('javascript:alert(1)'), null);
  assert.strictEqual(client.normalizeBase('ws://a.b'), null);
  assert.strictEqual(client.normalizeBase('http://host:notaport'), null);
  assert.strictEqual(client.normalizeBase('http:30120'), null);
});

test('normalizeBase: geçerli girdileri kabul eder', () => {
  assert.strictEqual(client.normalizeBase('5.231.120.202:30120'), 'http://5.231.120.202:30120');
  assert.strictEqual(client.normalizeBase('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
  assert.strictEqual(client.normalizeBase('https://play.example.com'), 'https://play.example.com:30120');
  assert.strictEqual(
    client.normalizeBase('http://5.231.120.202:30120/players.json'),
    'http://5.231.120.202:30120',
    'yol taban adrese indirgenmeli',
  );
});

// ==================== "Nope." / PARANOIA ====================

test('isParanoiaBody: sv_requestParanoia gövdesini tanır', () => {
  assert.strictEqual(client.isParanoiaBody('Nope.'), true);
  assert.strictEqual(client.isParanoiaBody('nope.'), true);
  assert.strictEqual(client.isParanoiaBody('  NOPE.  '), true);
  assert.strictEqual(client.isParanoiaBody('"Nope."'), true);
  assert.strictEqual(client.isParanoiaBody('[]'), false);
  assert.strictEqual(client.isParanoiaBody('{"a":1}'), false);
  assert.strictEqual(client.isParanoiaBody(''), false);
  assert.strictEqual(client.isParanoiaBody(null), false);
});

// ==================== BRIDGE GÜVENLİĞİ (Yöntem C) ====================

test('secretsMatch: doğru/yanlış secret ayrımı', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.strictEqual(bridge.secretsMatch(a, a), true);
  assert.strictEqual(bridge.secretsMatch(a, b), false);
  assert.strictEqual(bridge.secretsMatch('kisa', a), false);
  assert.strictEqual(bridge.secretsMatch('', a), false);
  assert.strictEqual(bridge.secretsMatch(a, ''), false);
});

test('sanitizeEntry: yalnız serverId/name/ping kabul eder', () => {
  const r = bridge.sanitizeEntry({ serverId: 12, name: 'Ali', ping: 30 });
  assert.deepStrictEqual(r.player, { id: 12, name: 'Ali', ping: 30 });
  assert.deepStrictEqual(Object.keys(r.player).sort(), ['id', 'name', 'ping']);
});

test('sanitizeEntry: identifier/IP alanlarını düşürür', () => {
  const r = bridge.sanitizeEntry({
    serverId: 12,
    name: 'Ali',
    ping: 30,
    endpoint: '1.2.3.4:30120',
    identifiers: ['license:SECRET'],
  });
  const json = JSON.stringify(r.player);
  assert.ok(!json.includes('SECRET'), 'identifier sızdırıldı');
  assert.ok(!json.includes('1.2.3.4'), 'IP sızdırıldı');
  assert.ok(!json.includes('identifiers'));
  assert.ok(!json.includes('endpoint'));
});

test('sanitizeEntry: geçersiz kayıtları reddeder', () => {
  assert.strictEqual(bridge.sanitizeEntry(null).ok, false);
  assert.strictEqual(bridge.sanitizeEntry({ name: 'x' }).ok, false); // id yok
  assert.strictEqual(bridge.sanitizeEntry({ serverId: -1, name: 'x' }).ok, false);
  assert.strictEqual(bridge.sanitizeEntry({ serverId: 999999, name: 'x' }).ok, false);
  assert.strictEqual(bridge.sanitizeEntry({ serverId: 1, name: '' }).ok, false);
  assert.strictEqual(bridge.sanitizeEntry({ serverId: 1, name: 123 }).ok, false);
});

test('sanitizeEntry: string serverId kabul edilir (Lua tonumber çıktısı)', () => {
  const r = bridge.sanitizeEntry({ serverId: '12', name: 'Ali', ping: '30' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.player.id, 12);
});

test('ingest: secret yanlışsa 401 döner, veri SAKLANMAZ', () => {
  const old = config.fivem.bridge.secret;
  config.fivem.bridge.secret = 'x'.repeat(64);
  bridge._reset();
  const r = bridge.ingest({ players: [{ serverId: 1, name: 'A', ping: 1 }] }, 'yanlis');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.strictEqual(bridge._hasSnapshot(), false, 'yetkisiz veri saklandı!');
  config.fivem.bridge.secret = old;
});

test('ingest: secret tanımlı değilse 503 döner', () => {
  const old = config.fivem.bridge.secret;
  config.fivem.bridge.secret = null;
  bridge._reset();
  const r = bridge.ingest({ players: [] }, 'herhangi');
  assert.strictEqual(r.code, 503);
  config.fivem.bridge.secret = old;
});

test('ingest: geçersiz JSON yapısı 400 döner', () => {
  const old = config.fivem.bridge.secret;
  config.fivem.bridge.secret = 'y'.repeat(64);
  bridge._reset();
  assert.strictEqual(bridge.ingest(null, 'y'.repeat(64)).code, 400);
  assert.strictEqual(bridge.ingest([], 'y'.repeat(64)).code, 400);
  assert.strictEqual(bridge.ingest({ oyuncular: [] }, 'y'.repeat(64)).code, 400);
  config.fivem.bridge.secret = old;
});

test('ingest: oyuncu yoksa boş liste GEÇERLİ sonuçtur', () => {
  const old = config.fivem.bridge.secret;
  config.fivem.bridge.secret = 'z'.repeat(64);
  bridge._reset();
  const r = bridge.ingest({ players: [] }, 'z'.repeat(64));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 0);
  const s = bridge.getSnapshot();
  assert.strictEqual(s.hasData, true);
  assert.strictEqual(s.stale, false);
  config.fivem.bridge.secret = old;
});

test('ingest: maxPlayers sınırı uygulanır', () => {
  const oldSecret = config.fivem.bridge.secret;
  const oldMax = config.fivem.bridge.maxPlayers;
  config.fivem.bridge.secret = 'm'.repeat(64);
  config.fivem.bridge.maxPlayers = 5;
  bridge._reset();
  const players = Array.from({ length: 50 }, (_, i) => ({ serverId: i + 1, name: 'P' + i, ping: 1 }));
  const r = bridge.ingest({ players }, 'm'.repeat(64));
  assert.strictEqual(r.count, 5, 'maxPlayers aşıldı');
  config.fivem.bridge.secret = oldSecret;
  config.fivem.bridge.maxPlayers = oldMax;
});

test('getSnapshot: bayat veri bayat olarak işaretlenir', () => {
  const oldSecret = config.fivem.bridge.secret;
  const oldAge = config.fivem.bridge.maxAgeMs;
  config.fivem.bridge.secret = 's'.repeat(64);
  config.fivem.bridge.maxAgeMs = 15; // 15ms
  bridge._reset();
  bridge.ingest({ players: [{ serverId: 1, name: 'A', ping: 1 }] }, 's'.repeat(64));
  assert.strictEqual(bridge.getSnapshot().stale, false, 'taze veri bayat sayıldı');
  return new Promise((resolve) => {
    setTimeout(() => {
      const s = bridge.getSnapshot();
      assert.strictEqual(s.stale, true, 'eski veri bayat sayılmadı');
      config.fivem.bridge.secret = oldSecret;
      config.fivem.bridge.maxAgeMs = oldAge;
      resolve();
    }, 60);
  });
});