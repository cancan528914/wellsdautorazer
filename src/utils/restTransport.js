/**
 * Paylaşılan Discord REST transport ayarları (index.js + deploy-commands.js tek kaynaktan kullanır).
 *
 * GERÇEK SEBEP (workaround değil, ölçülmüş uyumluluk ayarı):
 * Bu makinede GoodbyeDPI çalışıyor ve undici'nin HTTP/2 ALPN içeren büyük TLS
 * ClientHello paketleri el sıkışmada takılıp ConnectTimeoutError veriyor.
 * Ölçüm: node https (http/1.1) = OK 200, undici default (h2) = FAIL,
 * undici http/1.1-only agent = OK 200. TCP ve DNS sorunsuz.
 * Discord API HTTP/1.1'i tam desteklediği için bu ayar her yerde güvenlidir.
 * Ortamda proxy YOKTUR (WinHTTP: direct, proxy env değişkeni yok) — gereksiz proxy ayarı eklenmedi.
 *
 * Kapatmak için: REST_HTTP1_ONLY=false
 * Süreler: REST_TIMEOUT_MS (varsayılan 60000), REST_CONNECT_TIMEOUT_MS (30000), REST_RETRIES (3)
 */

const { Agent } = require('undici');

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Production süreleri: DPI'lı ağlarda TLS handshake tek başına 10sn+ sürebiliyor (ölçüldü: ~12sn).
const REST_TIMEOUT_MS = intEnv('REST_TIMEOUT_MS', 60000);
const REST_CONNECT_TIMEOUT_MS = intEnv('REST_CONNECT_TIMEOUT_MS', 30000);
const REST_RETRIES = intEnv('REST_RETRIES', 3);
// Havuzdaki TLS bağlantısının boşta tutulma süresi. DPI'lı ağlarda YENİ handshake
// 10sn+ sürer ve Discord etkileşim ACK'leri 3sn içinde gitmelidir; bu yüzden
// bağlantılar uzun süre sıcak tutulur. (Cloudflare ~100sn'de kapatır, 60sn güvenli.)
const REST_KEEPALIVE_MS = intEnv('REST_KEEPALIVE_MS', 60000);
const HTTP1_ONLY = (process.env.REST_HTTP1_ONLY || 'true').toLowerCase() !== 'false';

function buildRestAgent() {
  if (!HTTP1_ONLY) return undefined;
  return new Agent({
    connect: { ALPNProtocols: ['http/1.1'], timeout: REST_CONNECT_TIMEOUT_MS },
    keepAliveTimeout: REST_KEEPALIVE_MS,
    keepAliveMaxTimeout: 600000,
  });
}

/** @discordjs/rest ve Client `rest` opsiyonlarına doğrudan verilebilir obje. */
function buildRestOptions() {
  const agent = buildRestAgent();
  return { timeout: REST_TIMEOUT_MS, retries: REST_RETRIES, ...(agent ? { agent } : {}) };
}

// Tekrar denenebilir / ağ kaynaklı hatalar
const RETRYABLE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_RESPONSE_CLOSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

function isNetworkError(err) {
  if (!err) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  return /connect timeout|headers timeout|fetch failed|network|socket hang up|getaddrinfo|temporary failure|aborted|timed out/i.test(
    String(err.message || ''),
  );
}

/**
 * REST/deploy hatasını sınıflandırıp açık, uygulanabilir bir açıklama döner.
 * @returns {{ kind: 'config'|'auth'|'network'|'api'|'unknown', hint: string }}
 */
function describeRestError(err) {
  const status = typeof err?.status === 'number' ? err.status : null;

  if (status === 401) {
    return {
      kind: 'auth',
      hint: 'Invalid token (401 Unauthorized). Developer Portal → Bot → Reset Token ile yeni token alıp .env dosyasındaki DISCORD_TOKEN alanına yazın.',
    };
  }
  if (status === 403) {
    return {
      kind: 'auth',
      hint: 'Missing Access (403). Bot bu sunucuda değil, GUILD_ID yanlış ya da botun yetkisi yok. Botu sunucuya applications.commands scope ile davet edin.',
    };
  }
  if (status === 404) {
    return {
      kind: 'config',
      hint: 'Unknown endpoint (404). CLIENT_ID veya GUILD_ID yanlış. Developer Portal ve sunucu ayarlarından ID’leri doğrulayın.',
    };
  }
  if (status && status >= 400 && status < 500) {
    return { kind: 'api', hint: `Discord API isteği reddetti (${status}): ${err?.message || 'bilinmeyen hata'}` };
  }
  if (isNetworkError(err)) {
    return {
      kind: 'network',
      hint:
        'Discord API’ye (discord.com:443) HTTPS bağlantısı kurulamadı — sorun ağ katmanında, komut mantığında değil. ' +
        'Kontrol edin: (1) internet bağlantısı, (2) GoodbyeDPI/VPN açık mı — bot HTTP/1.1 modunda çalışacak şekilde ayarlı (REST_HTTP1_ONLY), ' +
        'yine de olmuyorsa VPN’i bağlayıp tekrar deneyin, (3) antivirüs/güvenlik duvarında node.exe engeli, ' +
        `(4) ayrıntılı teşhis için: npm run doctor. (timeout=${REST_TIMEOUT_MS}ms, retries=${REST_RETRIES})`,
    };
  }
  return { kind: 'unknown', hint: `Beklenmeyen hata: ${err?.message || String(err)}` };
}

module.exports = {
  REST_TIMEOUT_MS,
  REST_CONNECT_TIMEOUT_MS,
  REST_RETRIES,
  REST_KEEPALIVE_MS,
  HTTP1_ONLY,
  buildRestAgent,
  buildRestOptions,
  isNetworkError,
  describeRestError,
};
