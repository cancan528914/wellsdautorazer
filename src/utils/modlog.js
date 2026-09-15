/**
 * Moderasyon logu (ban/unban başarı + başarısızlık).
 * Hedef: MOD_LOG_CHANNEL_ID ayarlıysa oraya embed düşer, yoksa sessizce
 * geçilir (console logları zaten tutulur). Asla throw etmez.
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const logger = require('./logger');

const trDate = () => new Date().toLocaleString('tr-TR', { hour12: false });

async function resolveModLogChannel(guild) {
  try {
    const id = (config.modLogChannelId || '').trim();
    if (!id || !guild) return null;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`Mod-log kanalı bulunamadı: ${id}`);
      return null;
    }
    return ch;
  } catch (err) {
    logger.error('Mod-log kanalı çözülemedi.', err);
    return null;
  }
}

/**
 * @param {object} p - { kind: 'ban'|'unban', ok: boolean, targetId, targetTag, executor, reason, detail }
 */
async function sendModLog(guild, p = {}) {
  try {
    const ch = await resolveModLogChannel(guild);
    if (!ch) return false;
    const isBan = p.kind !== 'unban';
    const title = p.ok
      ? isBan
        ? '🔨 MEMBER BANNED'
        : '🔓 MEMBER UNBANNED'
      : isBan
        ? '⚠️ BAN FAILED'
        : '⚠️ UNBAN FAILED';
    const embed = new EmbedBuilder()
      .setColor(p.ok ? (isBan ? 0xe74c3c : 0x2ecc71) : 0xe67e22)
      .setTitle(title)
      .addFields(
        { name: 'Hedef', value: `<@${p.targetId}>`, inline: true },
        { name: 'User ID', value: `\`${p.targetId}\``, inline: true },
        { name: 'Hedef Adı', value: String(p.targetTag || 'Bilinmeyen').slice(0, 100), inline: false },
        { name: 'Executor', value: `<@${p.executor?.id}>`, inline: true },
        { name: 'Executor ID', value: `\`${p.executor?.id}\``, inline: true },
        { name: 'Action', value: isBan ? 'BAN' : 'UNBAN', inline: true },
        ...(p.reason ? [{ name: 'Sebep', value: String(p.reason).slice(0, 500), inline: false }] : []),
        {
          name: 'Result',
          value: p.ok ? '✅ SUCCESS' : `❌ FAILED\nReason: ${p.detail || 'bilinmiyor'}`,
          inline: false,
        },
        { name: 'Timestamp', value: trDate(), inline: false },
      )
      .setFooter({ text: `${config.botName} | Mod Log` })
      .setTimestamp();
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Mod-log gönderilemedi.', err);
    return false;
  }
}

module.exports = { sendModLog, resolveModLogChannel };
