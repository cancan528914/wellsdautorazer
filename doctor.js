/**
 * Bağlantı teşhis aracı: sorunun ağda mı, config'de mi olduğunu netleştirir.
 * Çalıştırma: npm run doctor
 * Değerleri ASLA yazdırmaz — sadece varlık/format kontrolü yapar.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { Agent, fetch: ufetch } = require('undici');

const SNOWFLAKE = /^\d{17,20}$/;
const HOST = 'discord.com';
let failures = 0;

function line(ok, name, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** Bilgi amaçlı kontrol: başarısız olsa bile sonucu etkilemez (⚠️). */
function infoLine(ok, name, detail = '') {
  console.log(`${ok ? '✅' : '⚠️'} ${name}${detail ? ' — ' + detail : ''}`);
}

function timedFetch(url, { dispatcher, timeout }) {
  const start = Date.now();
  return ufetch(url, { dispatcher, signal: AbortSignal.timeout(timeout) }).then((r) => ({
    status: r.status,
    ms: Date.now() - start,
  }));
}

function httpsGetStatus(url, timeout) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const q = https.get(url, { timeout }, (r) => {
      r.resume();
      resolve({ status: r.statusCode, ms: Date.now() - start });
    });
    q.on('timeout', () => q.destroy(new Error('TIMEOUT')));
    q.on('error', reject);
  });
}

function tcpCheck(host, port, timeout) {
  const start = Date.now();
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.setTimeout(timeout);
    s.on('connect', () => {
      const ms = Date.now() - start;
      s.destroy();
      resolve({ ok: true, ms });
    });
    const fail = (code) => {
      s.destroy();
      resolve({ ok: false, code });
    };
    s.on('timeout', () => fail('TIMEOUT'));
    s.on('error', (e) => fail(e.code || e.message));
  });
}

async function main() {
  console.log('--- Javrex Bot System bağlantı teşhisi ---\n');

  // 1. .env + config (değer yazdırılmaz)
  const envPath = path.join(__dirname, '.env');
  line(fs.existsSync(envPath), '.env dosyası mevcut');
  const token = (process.env.DISCORD_TOKEN || '').trim();
  const clientId = (process.env.CLIENT_ID || '').trim();
  const guildId = (process.env.GUILD_ID || '').trim();
  line(!!token, 'DISCORD_TOKEN yüklendi', token ? `(${token.length} karakter, değer gizli)` : '(eksik!)');
  line(!!clientId && SNOWFLAKE.test(clientId), 'CLIENT_ID formatı geçerli', clientId ? '(17-20 haneli snowflake)' : '(eksik!)');
  line(!!guildId && SNOWFLAKE.test(guildId), 'GUILD_ID formatı geçerli', guildId ? '(17-20 haneli snowflake)' : '(eksik!)');

  // 2. DNS
  try {
    const addrs = await dns.resolve4(HOST);
    line(true, `DNS çözümleme (${HOST})`, addrs.slice(0, 3).join(', '));
  } catch (err) {
    line(false, `DNS çözümleme (${HOST})`, err.code || err.message);
  }

  // 3. TCP (bilgi amaçlı — DPI ilk SYN paketini düşürebilir, HTTPS yine de çalışabilir)
  const tcp = await tcpCheck(HOST, 443, 10000);
  infoLine(tcp.ok, 'TCP bağlantısı (discord.com:443)', tcp.ok ? `${tcp.ms}ms` : `${tcp.code} (geçici olabilir, HTTPS sonucuna bakın)`);

  // 4. Klasik HTTPS (http/1.1)
  try {
    const r = await httpsGetStatus('https://discord.com/api/v10/gateway', 30000);
    line(r.status === 200, 'HTTPS klasik yığın (http/1.1)', `HTTP ${r.status}, ${r.ms}ms`);
  } catch (err) {
    line(false, 'HTTPS klasik yığın (http/1.1)', err.code || err.message);
  }

  // 5. undici default (bilgi amaçlı — bot/deploy bu yolu kullanmaz)
  try {
    const r = await timedFetch('https://discord.com/api/v10/gateway', { timeout: 25000 });
    infoLine(r.status === 200, 'undici default (http/2 ALPN)', `HTTP ${r.status}, ${r.ms}ms`);
  } catch (err) {
    infoLine(false, 'undici default (http/2 ALPN)', `${err.cause?.code || err.code || err.message} (beklenen: DPI bu handshake'i bozuyor, bot http/1.1 yolunu kullanır)`);
  }

  // 6. undici http/1.1 agent (botun + deploy'un kullandığı yol)
  const h1 = new Agent({ connect: { ALPNProtocols: ['http/1.1'], timeout: 30000 } });
  try {
    const r = await timedFetch('https://discord.com/api/v10/gateway', { dispatcher: h1, timeout: 45000 });
    line(r.status === 200, 'undici http/1.1 agent (bot/deploy yolu)', `HTTP ${r.status}, ${r.ms}ms`);
  } catch (err) {
    line(false, 'undici http/1.1 agent (bot/deploy yolu)', err.cause?.code || err.code || err.message);
  } finally {
    await h1.close().catch(() => {});
  }

  console.log(`\n--- Sonuç: ${failures === 0 ? 'her şey yolunda, npm run deploy çalışmalı' : failures + ' kontrol başarısız — yukarıdaki ❌ satırlarına bakın'} ---`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Teşhis çalıştırılamadı:', err.message || err);
  process.exit(1);
});
