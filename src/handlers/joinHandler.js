/**
 * Join log handler — guildMemberAdd eventinde çalışır.
 * 1533266772633850027 kanalına profesyonel embed gönderir.
 */
const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { buildJoinLogEmbed } = require('../utils/embeds');

// Hard-coded join log channel per spec (env override allowed but default is this ID)
const JOIN_LOG_CHANNEL_ID = config.joinLogChannelId || '1533266772633850027';

async function handleMemberAdd(member) {
  try {
    if (!member?.guild) return;
    const guild = member.guild;

    const channelId = JOIN_LOG_CHANNEL_ID;
    if (!channelId) {
      logger.warn('JOIN LOG CHANNEL NOT FOUND — joinLogChannelId tanımlı değil.');
      return;
    }

    let channel = null;
    try {
      channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) channel = guild.channels.cache.get(channelId) || null;
    } catch {}
    if (!channel) {
      logger.warn(`JOIN LOG CHANNEL NOT FOUND — kanal bulunamadı: ${channelId}`);
      return;
    }
    if (!channel.isTextBased?.()) {
      logger.warn(`JOIN LOG CHANNEL NOT FOUND — metin kanalı değil: ${channelId} (type ${channel.type})`);
      return;
    }

    // Bot permission kontrolü (spec 14) — yoksa crash olmadan logla
    try {
      const me = guild.members.me;
      if (me) {
        const perms = channel.permissionsFor(me);
        if (perms) {
          const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
          const missing = need.filter((f) => !perms.has(f));
          if (missing.length) {
            logger.warn(`Join log kanalında yetki eksik: ${channelId} — ViewChannel/SendMessages/EmbedLinks gerekli (member ${member.user?.id}).`);
            // yine de göndermeyi dene — Discord hata verirse aşağıda yakalanır
          }
        }
      }
    } catch {}

    // Embed oluştur (avatar alınamazsa bot crash olmamalı — embeds.js içinde try/catch var)
    let embed = null;
    try {
      embed = buildJoinLogEmbed({ member, guild });
    } catch (err) {
      logger.warn(`Join log embed oluşturulamadı: ${err.message}`);
      return;
    }

    // Mesaj gönder — mention gerçek <@USER_ID> olarak hem content hem embed description içinde zaten var
    // Content'te de mention ile herkes tarafından görülebilir etikette hoş geldin mesajı
    const content = `👋 Hoş geldin <@${member.user.id}>! Sunucumuza katıldığın için teşekkürler.`;

    try {
      await channel.send({
        content,
        embeds: [embed],
        allowedMentions: { users: [member.user.id] },
      });
      logger.success(`Join log: ${member.user.tag} (${member.user.id}) → #${channel.name} (üye: ${guild.memberCount})`);
    } catch (err) {
      // Permission, rate limit, API hatası — crash olmadan logla
      if (err?.code === 50013 || err?.status === 403) {
        logger.warn(`Join log gönderilemedi — yetki yok (kanal ${channelId}): ${err.code || err.message}`);
      } else if (err?.code === 50007 || err?.status === 429) {
        logger.warn(`Join log rate limit / API hatası: ${err.code || err.message}`);
      } else {
        logger.warn(`Join log gönderilemedi (kanal ${channelId}): ${err.code || err.message}`);
      }
    }
  } catch (err) {
    logger.error('handleMemberAdd failed (crash korumalı).', err);
  }
}

module.exports = { handleMemberAdd, JOIN_LOG_CHANNEL_ID };
