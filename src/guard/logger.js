/**
 * Guard log gönderici: ban / threat / unresolved embedleri.
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { getGuardSettings } = require('../database/database');
const { LOGCHANNEL_CACHE_TTL_MS } = require('./constants');

// guildId -> { ts, id, channel } — her ihlalde 1 GET kazanır
const channelCache = new Map();

const trDate = () => new Date().toLocaleString('tr-TR', { hour12: false });

async function getLogChannel(guild) {
  try {
    const settings = getGuardSettings(guild.id);
    const id = settings?.log_channel_id;
    if (!id) {
      logger.warn('Guard log kanalı ayarlı değil (/guardsetup gerekli).');
      return null;
    }
    const hit = channelCache.get(guild.id);
    if (hit && hit.id === id && Date.now() - hit.ts < LOGCHANNEL_CACHE_TTL_MS) return hit.channel;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch?.isTextBased()) {
      channelCache.delete(guild.id);
      logger.warn(`Guard log kanalı bulunamadı: ${id}`);
      return null;
    }
    channelCache.set(guild.id, { ts: Date.now(), id, channel: ch });
    return ch;
  } catch (err) {
    logger.error('Guard log kanalı çözülemedi.', err);
    return null;
  }
}

function baseEmbed(color) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `${config.botName} | Guard` })
    .setTimestamp();
}

function userLabel(executor) {
  if (!executor) return { mention: '`bilinmiyor`', tag: 'Bilinmeyen', id: '—' };
  const id = String(executor.id || '—');
  return { mention: `<@${id}>`, tag: executor.tag || 'Bilinmeyen', id };
}

/** TEST 11/12 + spec 15-20: ban ve threat logları. */
async function sendBanLog(guild, { executor, actionLabel, guardLabel, targetDesc, punishment, rollback }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const u = userLabel(executor);
  const punished = punishment?.ok;
  const embed = baseEmbed(punished ? 0xe74c3c : 0xf1c40f)
    .setTitle(punished ? '🛡️ GUARD — USER BANNED' : '🛡️ GUARD — THREAT DETECTED')
    .addFields(
      { name: '👤 Kullanıcı', value: u.mention, inline: true },
      { name: '📛 Kullanıcı Adı', value: u.tag.slice(0, 100), inline: true },
      { name: '🆔 Kullanıcı ID', value: `\`${u.id}\``, inline: false },
      { name: '🚨 Tetiklenen Guard', value: guardLabel, inline: true },
      { name: '⚠️ Yapılan İşlem', value: actionLabel, inline: true },
      { name: '🎯 Hedef', value: String(targetDesc || '—').slice(0, 200), inline: false },
      { name: '🔍 Audit Log Executor', value: u.mention, inline: true },
      {
        name: '🔨 Ceza',
        value: punished ? 'Sunucudan Banlandı' : `❌ Ban başarısız\nSebep: ${punishment?.detail || 'bilinmiyor'}`,
        inline: false,
      },
      {
        name: '↩️ Rollback',
        value: !rollback
          ? 'Uygulanmadı'
          : rollback.ok
            ? `✅ Başarılı\n${rollback.detail}`
            : `❌ Başarısız\nSebep: ${rollback.detail}`,
        inline: false,
      },
      { name: '🕐 Tarih', value: trDate(), inline: false },
    );
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard ban logu gönderilemedi.', err);
    return false;
  }
}

async function sendUnresolvedLog(guild, { actionLabel, targetDesc, reason }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const embed = baseEmbed(0x95a5a6)
    .setTitle('🛡️ GUARD — Executor Bulunamadı')
    .setDescription('Kritik bir işlem tespit edildi ancak Audit Log’da executor doğrulanamadı. Ceza uygulanmadı.')
    .addFields(
      { name: '⚠️ İşlem', value: actionLabel, inline: true },
      { name: '🎯 Hedef', value: String(targetDesc || '—').slice(0, 200), inline: true },
      { name: '🔍 Sebep', value: String(reason || 'Audit Log eşleşmedi.').slice(0, 500), inline: false },
      { name: '🕐 Tarih', value: trDate(), inline: false },
    );
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard unresolved logu gönderilemedi.', err);
    return false;
  }
}

module.exports = { getLogChannel, sendBanLog, sendUnresolvedLog, _channelCache: channelCache };
