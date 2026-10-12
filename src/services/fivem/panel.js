/**
 * FiveM canlı panel — SPAM YAPMAZ.
 *
 * Davranış:
 *  - Yeni mesaj her yoklamada ATILMAZ. Tek bir mesaj `edit` ile güncellenir.
 *  - Panel mesajının ID'si kalıcı dosyada saklanır; bot yeniden başlasa bile
 *    AYNI mesaj güncellenmeye devam eder (kanal spam olmaz).
 *  - Discord'a erişilemezse panik yok: hata yutulur, bot çökmez, yeniden dener.
 *  - Panel kanalı yapılandırılmamışsa modül hiç çalışmaz.
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../../utils/logger');
const service = require('./service');
const { buildPanelEmbed } = require('../../utils/fivemEmbeds');

const STATE_FILE = path.join(process.cwd(), 'data', 'fivem-panel.json');

let timer = null;
let state = { channelId: null, messageId: null };
let clientRef = null;
let consecutiveErrors = 0;

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { channelId: null, messageId: null };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      channelId: /^\d{17,20}$/.test(String(raw?.channelId || '')) ? String(raw.channelId) : null,
      messageId: /^\d{17,20}$/.test(String(raw?.messageId || '')) ? String(raw.messageId) : null,
    };
  } catch {
    return { channelId: null, messageId: null };
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (err) {
    logger.warn(`Panel durumu kaydedilemedi: ${err.message}`);
  }
}

/** Mesajı yeni gönder veya mevcutu güncelle. */
async function upsert(embed) {
  const { channelId, messageId } = state;

  if (messageId) {
    try {
      const channel = await clientRef.channels.fetch(channelId);
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [embed] });
      consecutiveErrors = 0;
      return 'edited';
    } catch (err) {
      // Mesaj silinmiş/kanal silinmiş → yeniden gönder.
      if (err?.code === 10008 || err?.code === 10003 || err?.code === 50007) {
        logger.warn('Panel mesajı bulunamadı — yeniden gönderiliyor.');
        state.messageId = null;
      } else {
        throw err;
      }
    }
  }

  const channel = await clientRef.channels.fetch(channelId);
  const msg = await channel.send({ embeds: [embed] });
  state.messageId = msg.id;
  saveState();
  consecutiveErrors = 0;
  return 'sent';
}

/** Tek tur: sorgula + paneli güncelle. */
async function tick() {
  if (!clientRef || !state.channelId) return;
  try {
    const q = await service.queryServer();
    const embed = buildPanelEmbed(q, Date.now());
    const mode = await upsert(embed);
    logger.debug(`Panel ${mode} (${q.status}, ${q.onlineCount ?? '?'} oyuncu).`);
    if (consecutiveErrors > 0) {
      logger.success('FiveM paneli tekrar güncelleniyor.');
      consecutiveErrors = 0;
    }
  } catch (err) {
    consecutiveErrors++;
    // Üst üste hatalarda spam yapma; sadece ilk hatayı ve her 10. hatayı logla.
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      logger.warn(`FiveM paneli güncellenemedi (hata ${consecutiveErrors}): ${err.message}`);
    }
  }
}

/**
 * Paneli başlat. Kanal yapılandırılmamışsa no-op döner.
 * @param {import('discord.js').Client} client
 */
function start(client) {
  const cfg = config.fivem.panel;
  if (!cfg.enabled) {
    logger.info('FiveM paneli devre dışı (FIVEM_PANEL_ENABLED=false).');
    return false;
  }
  if (!cfg.channelId || !/^\d{17,20}$/.test(cfg.channelId)) {
    logger.info('FiveM paneli kapalı (FIVEM_PANEL_CHANNEL_ID tanımlı değil). Spam önleme için mesaj gönderilmiyor.');
    return false;
  }

  clientRef = client;
  state = loadState();
  // .env'de mesaj ID verilmişse onu esas al (elle taşınmışsa).
  if (cfg.messageId && /^\d{17,20}$/.test(cfg.messageId)) state.messageId = cfg.messageId;
  state.channelId = cfg.channelId;

  const interval = Math.max(5000, config.fivem.pollIntervalMs);
  // İlk tur biraz geciktirilir: bot tam hazır olmadan Discord'a gitmesin.
  setTimeout(() => {
    tick();
    timer = setInterval(tick, interval);
    if (timer.unref) timer.unref();
  }, 15000);
  logger.success(`FiveM paneli etkin: kanal ${state.channelId}, aralık ${interval}ms (tek mesaj güncellenir).`);
  return true;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  clientRef = null;
}

function getState() {
  return { ...state, running: timer !== null };
}

module.exports = { start, stop, tick, getState, STATE_FILE };