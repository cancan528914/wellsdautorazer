/**
 * WELLSD AUTORAZER - Ana giriş noktası
 */
require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const { initDatabase } = require('./src/database/database');
const { loadCommands } = require('./src/handlers/commandHandler');
const { buildRestOptions, isNetworkError } = require('./src/utils/restTransport');
const { createSessionWatch } = require('./src/utils/sessionWatch');
const readyEvent = require('./src/events/ready');
const interactionEvent = require('./src/events/interactionCreate');
const messageEvent = require('./src/events/messageCreate');
const memberRemoveEvent = require('./src/events/guildMemberRemove');
const memberUpdateEvent = require('./src/events/guildMemberUpdate');
const guardEvents = require('./src/guard/events');

// --- Global crash koruması: bot hiçbir durumda crash olmamalı ---
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection.', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (bot çalışmaya devam ediyor).', err);
});
process.on('warning', (w) => logger.warn(`Node warning: ${w.name}: ${w.message}`));

function isTokenError(err) {
  return /invalid token|tokeninvalid|401/i.test(String(err?.message || '') + ' ' + String(err?.code || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Login + exponential backoff retry.
 * Geçici ağ kesintilerinde bot hemen ölmeyip tekrar dener;
 * PM2/systemd yoksa bile kısa süreli kopmalardan kurtulur.
 */
async function loginWithRetry(client, maxAttempts = 5) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.login(config.token);
      return;
    } catch (err) {
      const last = attempt === maxAttempts;

      if (isTokenError(err)) {
        logger.error('Geçersiz token. Developer Portal → Bot → Reset Token ile yeni token alıp .env dosyasına yazın.');
        throw err;
      }

      if (!isNetworkError(err) || last) throw err;

      logger.warn(
        `Login attempt ${attempt}/${maxAttempts} failed (network). Retrying in ${delay / 1000}s... ` +
          `If this persists: check firewall/antivirus rules for node.exe, VPN/proxy, and that discord.com is reachable.`,
      );
      await client.destroy().catch(() => {});
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

async function main() {
  if (!config.token) {
    logger.error('DISCORD_TOKEN bulunamadı. .env dosyasını doldurun ve tekrar başlatın.');
    process.exit(1);
  }

  // DB'yi en başta başlat (tablolar yoksa oluşur)
  initDatabase();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, // slash command + butonlar için zorunlu
      GatewayIntentBits.GuildMembers, // /dmmesaj üye listesi için zorunlu (Developer Portal'da SERVER MEMBERS INTENT açın)
      GatewayIntentBits.GuildMessages, // /clear + IC kanal takibi için
      GatewayIntentBits.GuildVoiceStates, // ses kanalı bağlantısı için zorunlu (VOICE_STATE_UPDATE almadan voice Ready olmaz)
      // IC isim içeriğini anında okumak için. Portal'da MESSAGE CONTENT INTENT açılmalı;
      // kapalıysa bot API'den çekmeye devam eder (biraz daha yavaş).
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.GuildMember, Partials.Channel, Partials.User],
    rest: buildRestOptions(),
  });

  loadCommands(client);

  // v15 uyumluluğu: 'ready' -> 'clientReady'. İkisini de dinleyip tek sefer çalıştır.
  let readyFired = false;
  const onReady = () => {
    if (readyFired) return;
    readyFired = true;
    readyEvent.execute(client);
  };
  client.once('clientReady', onReady);
  client.once(readyEvent.name, onReady); // eski davranışla uyumluluk
  client.on(interactionEvent.name, (i) => interactionEvent.execute(i));
  client.on(messageEvent.name, (m) => messageEvent.execute(m));
  client.on(memberRemoveEvent.name, (m) => memberRemoveEvent.execute(m));
  client.on(memberUpdateEvent.name, (o, n) => memberUpdateEvent.execute(o, n));
  // Guard izleme (her listener kendi hatasını yutar; mevcut sistemler etkilenmez)
  client.on('roleCreate', (r) => guardEvents.onRoleCreate(client, r));
  client.on('roleDelete', (r) => guardEvents.onRoleDelete(client, r));
  client.on('roleUpdate', (o, n) => guardEvents.onRoleUpdate(client, o, n));
  client.on('channelCreate', (c) => guardEvents.onChannelCreate(client, c));
  client.on('channelDelete', (c) => guardEvents.onChannelDelete(client, c));
  client.on('channelUpdate', (o, n) => guardEvents.onChannelUpdate(client, o, n));
  client.on('guildMemberUpdate', (o, n) => guardEvents.onGuildMemberUpdate(client, o, n));
  client.on('guildBanAdd', (b) => guardEvents.onGuildBanAdd(client, b));
  client.on('guildBanRemove', (b) => guardEvents.onGuildBanRemove(client, b));
  client.on('guildMemberRemove', (m) => guardEvents.onGuildMemberRemove(client, m));
  client.on('webhooksUpdate', (c) => guardEvents.onWebhookUpdate(client, c));
  client.on('guildUpdate', (o, n) => guardEvents.onGuildUpdate(client, o, n));
  client.on('emojiCreate', (e) => guardEvents.onEmojiCreate(client, e));
  client.on('emojiDelete', (e) => guardEvents.onEmojiDelete(client, e));
  client.on('emojiUpdate', (o, n) => guardEvents.onEmojiUpdate(client, o, n));
  client.on('stickerCreate', (s) => guardEvents.onStickerCreate(client, s));
  client.on('stickerDelete', (s) => guardEvents.onStickerDelete(client, s));
  client.on('stickerUpdate', (o, n) => guardEvents.onStickerUpdate(client, o, n));
  client.on('threadCreate', (t) => guardEvents.onThreadCreate(client, t));
  client.on('threadDelete', (t) => guardEvents.onThreadDelete(client, t));

  client.on('error', (err) => logger.error('Discord client error.', err));
  client.on('warn', (msg) => logger.warn(`Discord warning: ${msg}`));

  // --- Oturum çakışma dedektörü: aynı token'la 2 örnek = sürekli kopma ---
  const sessionWatch = createSessionWatch({
    onWarn: () =>
      logger.error(
        'UYARI: Gateway son 5 dakikada 3+ kez koptu! Büyük olasılıkla aynı token ile BAŞKA BİR BOT ÖRNEĞİ çalışıyor ' +
          '(PC + Railway aynı anda? Railway replicas > 1?). Tek örnek bırakın, yoksa ses dahil her şey kopup durur.',
      ),
  });
  client.on('shardDisconnect', (event, shardId) => {
    logger.warn(`Gateway bağlantısı koptu (shard ${shardId}, kod: ${event?.code}). Yeniden bağlanılıyor...`);
    sessionWatch.noteDisconnect();
  });
  client.on('shardReconnecting', () => logger.warn('Gateway yeniden bağlanıyor...'));
  client.on('shardResume', () => logger.success('Gateway oturumu kaldığı yerden devam etti.'));
  client.on('invalidated', () => {
    logger.error(
      'OTURUM GEÇERSİZ KILINDI (invalidated): aynı token ile BAŞKA bir örnek giriş yaptı! ' +
        'Diğer örneği KAPATIN, yoksa ses dahil her şey kopup durur.',
    );
  });

  await loginWithRetry(client);
}

main().catch((err) => {
  logger.error('Bot başlatılamadı.', err);
  process.exit(1);
});
