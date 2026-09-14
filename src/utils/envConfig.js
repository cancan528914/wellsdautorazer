/**
 * .env dosyasına güvenli yazma yardımcıları.
 * - Sadece çağrılan anahtar satırına dokunur, dosyanın geri kalanı byte-byte korunur.
 * - Yazmadan önce .env.backup yedeği alınır.
 * - Değerler asla loglanmaz (çağıran taraf loglamadan sorumludur).
 */
const fs = require('fs');
const logger = require('./logger');

function backupEnvFile(envPath) {
  try {
    if (!fs.existsSync(envPath)) return false;
    fs.copyFileSync(envPath, `${envPath}.backup`);
    return true;
  } catch (err) {
    logger.error(`.env yedeği alınamadı: ${envPath}`, err);
    return false;
  }
}

/**
 * key satırını günceller veya dosya sonuna ekler. Aynı anahtardan çift satır bırakmaz.
 * key: sabit kodlanmış anahtar adı olmalı (örn. TICKET_LOG_CHANNEL_ID).
 */
function upsertEnvKey(envPath, key, value) {
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error(`Geçersiz env anahtarı: ${key}`);
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += `${line}\n`;
  }
  fs.writeFileSync(envPath, text);
}

module.exports = { backupEnvFile, upsertEnvKey };
