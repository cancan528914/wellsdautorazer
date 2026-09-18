/**
 * fivem-local-bridge — merkezi yapılandırma.
 * Bridge HER ZAMAN 127.0.0.1'e bağlanır (dış ağa açılmaz).
 */
const path = require('path');

function intEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const config = {
  // Sabit loopback — değiştirilemez (güvenlik: bridge dışarı açılamaz).
  host: '127.0.0.1',
  port: intEnv('BRIDGE_PORT', 37911, 1024, 65535),
  // API anahtarı: env > kayıtlı dosya > ilk çalışta üretilir (keyStore).
  apiKey: (process.env.BRIDGE_API_KEY || '').trim() || null,
  keyFile: path.join(__dirname, '..', 'data', '.bridge-key'),
  // Provider: 'simulator' (varsayılan). Poll aralığı ms.
  provider: (process.env.BRIDGE_PROVIDER || 'simulator').trim().toLowerCase() || 'simulator',
  pollMs: intEnv('BRIDGE_POLL_MS', 2000, 500, 30000),
  // Rate limit: localhost istemcileri için cömert ama spam korumalı.
  rateWindowMs: 60 * 1000,
  rateMax: intEnv('BRIDGE_RATE_MAX', 300, 10, 5000),
};

module.exports = config;
