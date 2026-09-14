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
const dgram = require('node:dgram');
const crypto = require('node:crypto');
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

function voiceDebugOn() {
  return process.env.VOICE_DEBUG === 'true';
}

/**
 * Katılım hatası taksonomisi (saf fonksiyon — test edilebilir).
 * Kullanıcıya sade mesaj, terminale teknik detay (çağıran loglar) gider.
 * Kodlar: NO_CHANNEL | VOICE_UDP_BLOCKED | JOIN_TIMEOUT
 */
function classifyJoinError(err, sawConnecting) {
  if (err?.code === 10003) {
    return { code: 'NO_CHANNEL', message: 'Ses kanalı bulunamadı (silinmiş olabilir).' };
  }
  if (err?.name === 'AbortError' && sawConnecting) {
    // Gateway sinyali geçti (VOICE_STATE/SERVER_UPDATE OK) ama UDP handshake bitmedi
    return {
      code: 'VOICE_UDP_BLOCKED',
      message:
        'Ses sunucusuna bağlanılamadı (ses trafiği engelleniyor olabilir). ' +
        'VPN’i bağlayıp tekrar deneyin veya botu yurtdışında bir sunucuda çalıştırın.',
    };
  }
  return { code: 'JOIN_TIMEOUT', message: 'Ses kanalına bağlanılamadı (ağ zaman aşımı). Lütfen tekrar deneyin.' };
}

/**
 * Genel UDP çıkış testi: gerçek bir DNS sorgusu gönderip cevap bekler.
 * (UDP'de "gönderim başarısı" anlamsızdır — cevap gelmesi gerekir.)
 * @returns {Promise<boolean>} true = bu makineden UDP çıkışı çalışıyor
 */
function probeUdpEgress(host = '1.1.1.1', port = 53, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    let socket;
    try {
      socket = dgram.createSocket('udp4');
      // Minimal DNS sorgusu (discord.com, A kaydı)
      const txid = crypto.randomBytes(2);
      const header = Buffer.concat([txid, Buffer.from([0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])]);
      const labels = 'discord.com'.split('.').map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'utf8')]));
      const question = Buffer.concat([...labels, Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01])]);
      const packet = Buffer.concat([header, question]);
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.once('message', () => {
        clearTimeout(timer);
        finish(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      socket.send(packet, port, host, (err) => {
        if (err) {
          clearTimeout(timer);
          finish(false);
        }
      });
    } catch {
      finish(false);
    }
  });
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
      if (voiceDebugOn()) {
        try {
          const st = connection.state || {};
          const net = st.networking?.state?.status || st.networking?.status || 'yok';
          extra += ` | net=${net}`;
        } catch {
          /* detay kritik değil */
        }
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
  if (voiceDebugOn()) {
    logger.info(
      `Ses katilim: guild=${guildId} kanal=${channel.id} adapter=${typeof guild.voiceAdapterCreator} ` +
        `(selfDeaf+selfMute, receive yok)`,
    );
  }
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
    const classified = classifyJoinError(err, sawConnecting);
    if (classified.code === 'VOICE_UDP_BLOCKED') {
      // Genel UDP çıkışını da yoklayıp mesajı netleştir (ortam engeli mi, Discord'a özel mi?)
      let udpNote = '';
      try {
        const udpOk = await probeUdpEgress();
        udpNote = udpOk
          ? ' (Not: genel UDP çıkışı çalışıyor — engel Discord sesine özel görünüyor.)'
          : ' (Not: bu makineden genel UDP çıkışı da yok — ortam UDP engelliyor.)';
      } catch {
        /* prob kritik değil */
      }
      const e = new Error(classified.message + udpNote);
      e.code = classified.code;
      throw e;
    }
    const e = new Error(classified.message);
    e.code = classified.code;
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
  probeUdpEgress,
  classifyJoinError,
  getSavedVoiceChannel,
  getCurrentChannelId,
  joinVoice,
  leaveVoice,
  attachHandlers, // test/diagnostik için açık
};
