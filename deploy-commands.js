/**
 * Slash command register.
 * Guild command kullanılır (development için anında güncellenir).
 * Çalıştırma: npm run deploy
 *
 * Endpoint: PUT /v10/applications/{CLIENT_ID}/guilds/{GUILD_ID}/commands
 * Transport: src/utils/restTransport.js (bot ile aynı ayarlar — timeout 60sn, retry 3).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const logger = require('./src/utils/logger');
const { buildRestOptions, describeRestError } = require('./src/utils/restTransport');

const SNOWFLAKE = /^\d{17,20}$/;

function loadConfig() {
  const token = (process.env.DISCORD_TOKEN || '').trim();
  const clientId = (process.env.CLIENT_ID || '').trim();
  const guildId = (process.env.GUILD_ID || '').trim();

  const problems = [];
  if (!token) problems.push('DISCORD_TOKEN eksik — .env dosyasına bot tokenını yazın.');
  if (!clientId) problems.push('CLIENT_ID eksik — Developer Portal → General Information → Application ID.');
  else if (!SNOWFLAKE.test(clientId)) problems.push('CLIENT_ID formatı hatalı — 17-20 haneli sayı olmalı.');
  if (!guildId) problems.push('GUILD_ID eksik — sunucuya sağ tık → Sunucu ID’sini Kopyala (Geliştirici Modu açık olmalı).');
  else if (!SNOWFLAKE.test(guildId)) problems.push('GUILD_ID formatı hatalı — 17-20 haneli sayı olmalı.');

  return { token, clientId, guildId, problems };
}

function loadCommandBodies() {
  const commandsDir = path.join(__dirname, 'src', 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  const body = [];
  for (const file of files) {
    const cmd = require(path.join(commandsDir, file));
    if (cmd?.data?.name) body.push(cmd.data.toJSON());
    else logger.warn(`Komut atlandı (eksik data): ${file}`);
  }
  return body;
}

async function main() {
  const { token, clientId, guildId, problems } = loadConfig();
  if (problems.length > 0) {
    for (const p of problems) logger.error(`Config error: ${p}`);
    logger.error('Deploy durduruldu: .env içindeki eksik/hatalı alanları düzeltin. (Değerler güvenlik için loglanmaz.)');
    process.exit(1);
  }
  logger.info(`Config OK: token yüklendi (${token.length} karakter), CLIENT_ID/GUILD_ID formatı geçerli.`);

  const body = loadCommandBodies();
  if (body.length === 0) {
    logger.error('Deploy durduruldu: src/commands içinde kayıt edilecek komut bulunamadı.');
    process.exit(1);
  }

  const rest = new REST({ version: '10', ...buildRestOptions() }).setToken(token);

  logger.info(`${body.length} komut guild'e kaydediliyor (guild: ${guildId}) ...`);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    logger.success(`Kaydedildi: ${body.map((c) => '/' + c.name).join(', ')}`);
  } catch (err) {
    const { kind, hint } = describeRestError(err);
    logger.error(`Komut kaydı başarısız [${kind}]: ${hint}`);
    logger.error('Teknik detay:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  const { kind, hint } = describeRestError(err);
  logger.error(`Komut kaydı başarısız [${kind}]: ${hint}`);
  logger.error('Teknik detay:', err);
  process.exit(1);
});
