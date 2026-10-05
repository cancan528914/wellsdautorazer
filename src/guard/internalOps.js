/**
 * Internal Operations — bot'un KENDİ yaptığı işlemlerin takibi.
 *
 * SORUNUN KÖKÜ:
 *   Bot bir log kanalına izin yazıyor → Discord channelUpdate eventi üretiyor →
 *   event handler log kanalını "bozulmuş" görüp izinleri YENİDEN yazıyor →
 *   yeni event → ... sonsuz döngü.
 *
 * ÇÖZÜM:
 *   Bot bir şey yazmadan ÖNCE burada işaretler. Event geldiğinde
 *   isInternalOp() true döner → handler sessizce çıkar (log/ceza yok).
 *
 * TASARIM (kalıcı):
 *   - Hedef bazlı: `${guildId}:${scope}:${targetId}` → son geçerlilik
 *   - TTL ile otomatik temizlik (memory leak YOK)
 *   - Boyut tavanı + sweep (sınırsız büyüme YOK)
 *   - Scope ayrımı: 'create', 'delete', 'perm', 'generic', 'send'
 *     Böylece botun KENDİ yazması elenir, ama BAŞKA birinin yazdığı loglanır.
 */

// scope:what -> expiry
const ops = new Map();

// Bellek tavanı (aşılırsa en eski budanır)
const MAX_OPS = 500;

// TTL'ler: yazma sonrası event'in gelmesi beklenen pencere.
// Kısa tutulur — bot kendi işlemini "unutmalı", sonraki gerçek değişiklik loglanmalı.
const TTL = {
  create: 3000, // kanal/rol oluşturma → channelCreate/roleCreate eventi
  delete: 3000,
  perm: 8000, // izin yazımı → channelUpdate/roleUpdate eventi (daha geç gelir)
  generic: 4000,
  send: 1500, // mesaj gönderimi (event üretmez ama güvenlik)
};

/** `guildId:scope:targetId` anahtarı. */
function key(guildId, scope, targetId) {
  return `${guildId}:${scope}:${targetId ?? '*'}`;
}

/**
 * Bot bir işlem yapmadan ÖNCE çağır.
 * @param {string} guildId
 * @param {string} scope - 'create' | 'delete' | 'perm' | 'generic' | 'send'
 * @param {string} [targetId] - hedef ID (yoksa '*' = guild geneli)
 * @param {number} [ttlMs]
 */
function markInternalOp(guildId, scope, targetId, ttlMs) {
  if (!guildId || !scope) return;
  const t = ttlMs || TTL[scope] || TTL.generic;
  try {
    ops.set(key(guildId, scope, targetId), Date.now() + t);
    // Ölü kayıtları temizle + taşmayı sınırla
    if (ops.size > MAX_OPS || ops.size % 25 === 0) sweepOps();
  } catch {
    /* takip kritik değil — temizlik başarısız olsa bile akış durmaz */
  }
}

/**
 * Bu event botun kendi işleminden mi?
 * @returns {boolean} true ise bu event KENDİMİZİN yaptığımız iş → log/ceza YOK
 */
function isInternalOp(guildId, scope, targetId) {
  if (!guildId || !scope) return false;
  try {
    const k = key(guildId, scope, targetId);
    const exp = ops.get(k);
    if (!exp) {
      // '*' kaydı varsa hedef-spesifik olmayan genel işlem olabilir
      const g = ops.get(key(guildId, scope, '*'));
      if (g && g > Date.now()) return true;
      return false;
    }
    if (exp > Date.now()) return true;
    // Süresi dolmuş → sil, artık geçerli değil
    ops.delete(k);
    return false;
  } catch {
    return false;
  }
}

/** Bot bir işlem yapıldıktan SONRA çağır — pencereyi hemen kapat. */
function clearInternalOp(guildId, scope, targetId) {
  try {
    ops.delete(key(guildId, scope, targetId));
  } catch {
    /* ignore */
  }
}

/** Süresi dolmuş kayıtları siler (memory leak koruması). */
function sweepOps(now = Date.now()) {
  for (const [k, exp] of ops) {
    if (exp <= now) ops.delete(k);
  }
  if (ops.size > MAX_OPS) {
    // En eski yarısını at (sıralı: value = expiry)
    const sorted = [...ops.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, Math.floor(ops.size / 2))) ops.delete(k);
  }
}

/**
 * Async bir işlemi "internal" olarak çalıştırır.
 * Yazma BAŞLARKEN işaretler, BİTİNCE kapatmaz — çünkü event asenkron gelir.
 * Bu yüzden scope kapatılmaz, TTL ile kendiliğinden düşer.
 *
 * @param {string} guildId
 * @param {string} scope
 * @param {string} targetId
 * @param {Function} fn - async yazma işlemi
 */
async function runInternalOp(guildId, scope, targetId, fn) {
  markInternalOp(guildId, scope, targetId);
  return fn();
}

module.exports = {
  markInternalOp,
  isInternalOp,
  clearInternalOp,
  runInternalOp,
  sweepOps,
  _ops: ops,
  TTL,
  MAX_OPS,
};