/**
 * API anahtarı yönetimi: env > kayıtlı dosya > ilk çalışta üretim.
 * Anahtar dosyası git'e girmez (.gitignore) ve kimseyle paylaşılmaz.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function loadOrCreateKey() {
  if (config.apiKey) return { key: config.apiKey, created: false };
  try {
    const raw = fs.readFileSync(config.keyFile, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(raw)) return { key: raw, created: false };
  } catch {
    /* dosya yoksa üretilir */
  }
  const key = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(config.keyFile), { recursive: true });
    fs.writeFileSync(config.keyFile, key + '\n', { mode: 0o600 });
  } catch {
    /* yazılamazsa sadece bellekte yaşar (yeniden başlatınca değişir) */
  }
  return { key, created: true };
}

module.exports = { loadOrCreateKey };
