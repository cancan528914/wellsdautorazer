/**
 * Sunucu takip botu testleri:
 *   • tracker: oyuncu sayısı geçmişi, zirve, katılma/ayrılma olayları
 *   • Kesinti "herkes ayrıldı" sayılmaz
 *   • Embed'ler gerçek veriden beslenir, sahte isim ÜRETİLMEZ
 */
const test = require('node:test');
const assert = require('node:assert');

const tracker = require('../src/services/fivem/tracker');
const { buildActivityEmbed, buildCountEmbed, buildPrivacyNoticeEmbed } = require('../src/utils/fivemTracking');

// ---------- tracker ----------
function reset() {
  tracker.reset();
}

test('T1: ilk örnek olay üretmez (temel durum)', () => {
  reset();
  const ev = tracker.record({ status: 'ANONYMIZED', onlineCount: 100 });
  assert.strictEqual(ev, null);
  assert.strictEqual(tracker.summary().current, 100);
});

test('T2: oyuncu artışı "katıldı" olayı üretir', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  const ev = tracker.record({ status: 'LIVE', onlineCount: 105 });
  assert.ok(ev, 'olay üretilmedi');
  assert.strictEqual(ev.type, 'join');
  assert.strictEqual(ev.delta, 5);
  assert.strictEqual(ev.from, 100);
  assert.strictEqual(ev.to, 105);
  const s = tracker.summary();
  assert.strictEqual(s.current, 105);
  assert.strictEqual(s.joined, 5);
  assert.strictEqual(s.left, 0);
});

test('T3: oyuncu azalışı "ayrıldı" olayı üretir', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  const ev = tracker.record({ status: 'LIVE', onlineCount: 93 });
  assert.strictEqual(ev.type, 'leave');
  assert.strictEqual(ev.delta, -7);
  assert.strictEqual(tracker.summary().left, 7);
});

test('T4: değişiklik yoksa olay üretilmez', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  assert.strictEqual(tracker.record({ status: 'LIVE', onlineCount: 100 }), null);
});

test('T5: zirve takip edilir', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 50 });
  tracker.record({ status: 'LIVE', onlineCount: 180 });
  tracker.record({ status: 'LIVE', onlineCount: 120 });
  const s = tracker.summary();
  assert.strictEqual(s.peak.count, 180);
  assert.strictEqual(s.current, 120);
});

test('T6: ortalama hesaplanır', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  tracker.record({ status: 'LIVE', onlineCount: 200 });
  assert.strictEqual(tracker.summary().avg, 150);
});

test('T7: KESİNTİ "herkes ayrıldı" SAYMAZ', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  const s1 = tracker.summary();
  const ev = tracker.record({ status: 'OFFLINE', detail: 'timeout', onlineCount: null });
  assert.ok(ev, 'kesinti olayı üretilmedi');
  assert.strictEqual(ev.type, 'offline');
  assert.strictEqual(ev.outage, true);
  const s2 = tracker.summary();
  // "left" ARTMIYOR — çünkü kimse ayrılmadı, sunucu kapanmıştı
  assert.strictEqual(s2.left, s1.left, 'kesinti oyuncu çıkışı sayıldı!');
  assert.strictEqual(s2.outage, true);
});

test('T8: kesintiden dönüşte yanlış "katıldı" sayılmaz', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  tracker.record({ status: 'OFFLINE', detail: 'timeout' });
  // Sunucu 5 dakika sonra 300 oyuncuyla döndü — bu 200 kişinin "katıldığı" değil
  const ev = tracker.record({ status: 'LIVE', onlineCount: 300 });
  assert.strictEqual(ev, null, 'kesintiden dönüşte sahte katılma olayı üretildi');
  const s = tracker.summary();
  assert.strictEqual(s.current, 300);
  assert.strictEqual(s.joined, 0, 'kesintiden dönüşte katılma sayıldı');
});

test('T9: countFrom — OFFLINE/ERROR sayı üretmez', () => {
  assert.strictEqual(tracker.countFrom({ status: 'OFFLINE' }), null);
  assert.strictEqual(tracker.countFrom({ status: 'ERROR' }), null);
  assert.strictEqual(tracker.countFrom({ status: 'ANONYMIZED', onlineCount: 42 }), 42);
  assert.strictEqual(tracker.countFrom({ status: 'LIVE', onlineCount: 0 }), 0);
  assert.strictEqual(tracker.countFrom({ status: 'LIVE', players: [1, 2, 3] }), 3);
});

test('T10: abone olayları alır', () => {
  reset();
  const seen = [];
  const off = tracker.subscribe((ev) => seen.push(ev));
  tracker.record({ status: 'LIVE', onlineCount: 10 });
  tracker.record({ status: 'LIVE', onlineCount: 12 });
  tracker.record({ status: 'LIVE', onlineCount: 11 });
  off();
  tracker.record({ status: 'LIVE', onlineCount: 20 });
  assert.strictEqual(seen.length, 2, `2 olay bekleniyordu, ${seen.length} geldi`);
  assert.strictEqual(seen[0].delta, 2);
  assert.strictEqual(seen[1].delta, -1);
});

// ---------- embed'ler ----------
test('E1: gizlilik bildirimi erişilemeyeni açıkça söyler', () => {
  const e = buildPrivacyNoticeEmbed({ status: 'ANONYMIZED', onlineCount: 119, hostname: 'TEST' }, 'search').toJSON();
  const text = JSON.stringify(e);
  assert.ok(text.includes('Paylaşılmıyor'));
  assert.ok(text.includes('119'), 'erişilebilen sayı gösterilmeli');
  assert.ok(text.includes('Erişemediğimiz'), 'erişilemeyen veri belirtilmeli');
  // Sahte oyuncu ismi/ID ÜRETİLMEMELİ
  // Discord embed alanlari da "name" kullandigi icin "name" alanina
  // bakilamaz; liste GOSTERGELERINE bakilir.
  assert.ok(!text.includes('Ping:'), 'sahte ping listesi uretilmis');
  // 'Server ID' metni gizlilik ACIKLAMASINDA gecer (bu dogru, erisilemedigi belirtiliyor).
  // Asil liste gostergesi: oyuncu satiri (Ping) uretilmemeli.
  assert.ok(text.includes('Erişemediğimiz'), 'erisilemeyen veri belirtilmeli');
});

test('E2: hareketlilik embed\'i gerçek veriyi gösterir', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  tracker.record({ status: 'LIVE', onlineCount: 130 });
  const e = buildActivityEmbed(tracker.summary()).toJSON();
  const text = e.description + JSON.stringify(e.fields);
  assert.ok(text.includes('130'), 'güncel sayı yok');
  assert.ok(text.includes('+30'), 'toplam artış yok');
  assert.ok(text.includes('Zirve'), 'zirve yok');
});

test('E3: grafik en az 4 örnekten sonra çizilir', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 10 });
  const e1 = buildActivityEmbed(tracker.summary()).toJSON();
  assert.ok(!JSON.stringify(e1).includes('Grafik'), 'tek örnekten grafik çizilmemeli');
  tracker.record({ status: 'LIVE', onlineCount: 20 });
  tracker.record({ status: 'LIVE', onlineCount: 30 });
  tracker.record({ status: 'LIVE', onlineCount: 25 });
  const e2 = buildActivityEmbed(tracker.summary()).toJSON();
  assert.ok(JSON.stringify(e2).includes('Grafik'), '4 örnekten sonra grafik olmalı');
});

test('E4: /oyuncular embed\'i sayı gösterir, isim listesi ÜRETMEZ', () => {
  reset();
  tracker.record({ status: 'ANONYMIZED', onlineCount: 119 });
  const e = buildCountEmbed(
    { onlineCount: 119, maxClients: 1000, hostname: 'SON SESSIZLIK' },
    tracker.summary(),
  ).toJSON();
  const text = JSON.stringify(e);
  assert.ok(text.includes('119'), 'sayı yok');
  assert.ok(text.includes('1000'), 'kapasite yok');
  assert.ok(text.includes('paylaşılmıyor'), 'gizlilik notu yok');
  // Oyuncu listesi alanı OLMAMALI
  assert.ok(!text.includes('Ping:'), 'sahte ping listesi üretilmiş');
});

test('E5: kesintide hareketlilik embed\'i dürüst mesaj verir', () => {
  reset();
  tracker.record({ status: 'LIVE', onlineCount: 100 });
  tracker.record({ status: 'OFFLINE' });
  const e = buildActivityEmbed(tracker.summary()).toJSON();
  const text = JSON.stringify(e);
  assert.ok(text.includes('erişilemiyor') || text.includes('Erişilemiyor'), 'kesinti bildirilmedi');
  assert.ok(text.includes('DEĞİLDİR') || text.includes('eklenmez'),
    'kesintinin cikis sayilmadigi belirtilmeli');
});