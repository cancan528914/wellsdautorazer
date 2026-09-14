/**
 * Ses kanalı yöneticisi (/sesgir + /sescik).
 * - Bot kanala girer ve orada kalır (24/7 tarzı; audio çalınmaz, self-mute+deaf).
 * - Beklenmedik kopmalarda sınırlı oto-rejoin (GoodbyeDPI/VPN arkası ağlar için).
 * - Son kanal DB'de saklanır → restart sonrası ready.js otomatik geri katılır.
 */
const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const { getSetting, setSetting, deleteSetting } = require('../database/database');

const MAX_REJOIN_ATTEMPTS = 5;
const REJOIN_DELAY_MS = 5000;
const READY_TIMEOUT_MS = 30000;

const voiceKey = (guildId) => `voice_channel_${guildId}`;
// guildId -> { channelId, adapterCreator, attempts, intentional }
const sessions = new Map();

/** Oto-rejoin devam etmeli mi? (saf karar fonksiyonu — test edilebilir) */
function shouldRejoin(attempts) {
  return Number.isInteger(attempts) && attempts < MAX_REJOIN_ATTEMPTS;
}

function getSavedVoiceChannel(guildId) {
  return getSetting(voiceKey(guildId));
}

function getCurrentChannelId(guildId) {
  try {
    return getVoiceConnection(guildId)?.joinConfig?.channelId || null;
  } catch {
    return null;
  }
}

function resolveVoiceChannel(guild, channelOrId) {
  const channel =
    channelOrId && typeof channelOrId === 'object'
      ? channelOrId
      : guild.channels.cache.get(channelOrId) || null;
  if (!channel) {
    const err = new Error('Ses kanalı bulunamadı (silinmiş olabilir).');
    err.code = 'NO_CHANNEL';
    throw err;
  }
  if (channel.type !== ChannelType.GuildVoice) {
    const err = new Error('Yalnızca normal ses kanallarına giriş yapılabilir.');
    err.code = 'NOT_VOICE';
    throw err;
  }
  const me = guild.members.me;
  if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) {
    const err = new Error('Bu ses kanalına **Bağlan** yetkim yok. Kanal izinlerini kontrol edin.');
    err.code = 'NO_CONNECT_PERM';
    throw err;
  }
  return channel;
}

function attachHandlers(connection, session) {
  connection.on('error', (err) => {
    logger.error(`Ses bağlantı hatası (guild ${session.guildId}).`, err);
  });
  // Teşhis kaydı: kopma/düşme noktası terminalde milisaniyesiyle görünür
  connection.on('stateChange', (oldState, newState) => {
    try {
      const t = Date.now() - (session.t0 || Date.now());
      let extra = '';
      if (newState && newState.status === VoiceConnectionStatus.Disconnected) {
        extra = ` (sebep: ${newState.reason || 'bilinmiyor'})`;
      }
      logger.info(`Ses durumu [+${t}ms]: ${oldState.status} -> ${newState.status}${extra}`);
    } catch {
      /* log kritik değil */
    }
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (session.intentional) {
      sessions.delete(session.guildId);
      return;
    }
    session.attempts += 1;
    if (!shouldRejoin(session.attempts)) {
      logger.error(
        `Ses bağlantısı koptu ve ${MAX_REJOIN_ATTEMPTS} denemede kurulamadı (guild ${session.guildId}). ` +
          `Kayıtlı kanal korunuyor — restart sonrası tekrar denenecek veya /sesgir ile manuel katılın. ` +
          `Sebep için yukarıdaki 'Ses durumu' satırlarına bakın.`,
      );
      sessions.delete(session.guildId);
      try {
        connection.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    logger.warn(`Ses bağlantısı koptu, ${REJOIN_DELAY_MS / 1000}sn sonra yeniden deneniyor (${session.attempts}/${MAX_REJOIN_ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, REJOIN_DELAY_MS));
    if (session.intentional || sessions.get(session.guildId) !== session) return;
    try {
      const fresh = joinVoiceChannel({
        channelId: session.channelId,
        guildId: session.guildId,
        adapterCreator: session.adapterCreator,
        selfDeaf: true,
        selfMute: true,
      });
      session.connection = fresh;
      attachHandlers(fresh, session);
      await entersState(fresh, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      session.attempts = 0;
      logger.success(`Ses bağlantısı yeniden kuruldu (guild ${session.guildId}).`);
    } catch (err) {
      logger.warn(`Ses rejoin başarısız: ${err.code || err.message}`);
      // Disconnected handler tekrar tetiklenecek veya döngü bir sonraki kopuşta devam edecek
      try {
        session.connection?.destroy();
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * Ses kanalına katıl (veya taşın). Başarılı olursa kanal ID'sini döner.
 * Aynı kanaldaysa hata fırlatır (ALREADY_THERE).
 */
async function joinVoice(guild, channelOrId) {
  const channel = resolveVoiceChannel(guild, channelOrId);
  const guildId = guild.id;

  const current = getCurrentChannelId(guildId);
  if (current === channel.id) {
    const err = new Error(`Bot zaten <#${channel.id}> kanalında.`);
    err.code = 'ALREADY_THERE';
    throw err;
  }

  // Başka kanaldaysa önce oradan ayrıl (taşınma)
  const moved = !!current;
  if (current) await leaveVoice(guildId, { intentional: true, keepSetting: true });

  const session = {
    guildId,
    channelId: channel.id,
    adapterCreator: guild.voiceAdapterCreator,
    attempts: 0,
    intentional: false,
    connection: null,
    t0: Date.now(),
  };

  let connection;
  // Gateway sinyali geçip UDP'de takılma oldu mu? (teşhis için izlenir)
  let sawConnecting = false;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });
    session.connection = connection;
    sessions.set(guildId, session);
    attachHandlers(connection, session);
    const watch = (oldState, newState) => {
      if (
        newState.status === VoiceConnectionStatus.Connecting ||
        newState.status === VoiceConnectionStatus.Ready
      ) {
        sawConnecting = true;
      }
    };
    connection.on('stateChange', watch);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } finally {
      connection.off('stateChange', watch);
    }
  } catch (err) {
    sessions.delete(guildId);
    try {
      connection?.destroy();
    } catch {
      /* ignore */
    }
    logger.error(`Ses kanalına katılım başarısız: #${channel.name || channel.id}`, err);
    if (err?.code === 10003) {
      const e = new Error('Ses kanalı bulunamadı (silinmiş olabilir).');
      e.code = 'NO_CHANNEL';
      throw e;
    }
    if (err?.name === 'AbortError' && sawConnecting) {
      // Gateway OK ama ses sunucusuna UDP kurulamadı → ağ engeli (ISS/DPI), kod hatası değil
      const e = new Error(
        'Ses sunucusuna bağlanılamadı (ses trafiği engelleniyor olabilir). ' +
          'VPN’i bağlayıp tekrar deneyin veya botu yurtdışında bir sunucuda çalıştırın.',
      );
      e.code = 'VOICE_UDP_BLOCKED';
      throw e;
    }
    const e = new Error('Ses kanalına bağlanılamadı (ağ zaman aşımı). Lütfen tekrar deneyin.');
    e.code = 'JOIN_TIMEOUT';
    throw e;
  }

  setSetting(voiceKey(guildId), channel.id);
  logger.success(`Sese girildi: #${channel.name || channel.id} (guild ${guildId})${moved ? ' [taşındı]' : ''}`);
  return { channelId: channel.id, moved };
}

/** Sesten ayrıl. intentional=true ise oto-rejoin tetiklenmez. */
async function leaveVoice(guildId, { intentional = true, keepSetting = false } = {}) {
  const session = sessions.get(guildId);
  if (session) session.intentional = intentional;
  const connection = getVoiceConnection(guildId);
  const channelId = connection?.joinConfig?.channelId || session?.channelId || null;
  try {
    connection?.destroy();
  } catch {
    /* ignore */
  }
  sessions.delete(guildId);
  if (intentional && !keepSetting) {
    try {
      deleteSetting(voiceKey(guildId));
    } catch {
      /* ignore */
    }
  }
  if (channelId) logger.success(`Sesten çıkıldı (guild ${guildId}).`);
  return channelId;
}

module.exports = {
  MAX_REJOIN_ATTEMPTS,
  REJOIN_DELAY_MS,
  READY_TIMEOUT_MS,
  voiceKey,
  shouldRejoin,
  getSavedVoiceChannel,
  getCurrentChannelId,
  joinVoice,
  leaveVoice,
  attachHandlers, // test/diagnostik için açık
};
