/**
 * Quit takibi: ayrılan üyenin paneli + eski roller butonu.
 * Roller guildMemberUpdate ile anlık DB'ye yazılır (üye cache'de yoksa bile bulunur).
 * Buton customId statiktir → restart-safe (panel mesaj ID üzerinden çözülür).
 */
const { MessageFlags } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { buildErrorEmbed, buildQuitPanelEmbed, buildQuitRolesRow, buildQuitRolesEmbed } = require('../utils/embeds');
const { trackMemberRoles, getMemberRoles, createQuitLog, getQuitByPanel, setQuitPanel, pruneQuitLogs } = require('../database/database');

function snapshotRoles(member) {
  try {
    return [...(member.roles?.cache?.values?.() || [])].map((r) => ({ id: String(r.id), name: String(r.name || 'Bilinmeyen rol') }));
  } catch {
    return [];
  }
}

async function handleMemberUpdate(oldMember, newMember) {
  try {
    if (!newMember?.guild || newMember.user?.bot) return;
    trackMemberRoles(newMember.guild.id, newMember.user.id, snapshotRoles(newMember));
  } catch (err) {
    logger.error('Quit rol takibi başarısız.', err);
  }
}

async function handleMemberRemove(member) {
  const guild = member?.guild;
  if (!guild) return;
  const channelId = config.quitLogChannelId;
  if (!channelId) return; // ayarlı değilse sessiz geç

  try {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn(`Quit log kanalı bulunamadı veya metin kanalı değil: ${channelId}`);
      return;
    }

    const user = member.user;
    let roles = getMemberRoles(guild.id, user.id);
    if (!roles.length && member.roles?.cache?.size) {
      roles = snapshotRoles(member).filter((r) => r.id !== guild.id);
    }

    const panelMsg = await channel.send({
      embeds: [buildQuitPanelEmbed({ user, roles, joinedAt: member.joinedAt ? member.joinedAt.getTime() : null })],
      components: [buildQuitRolesRow()],
    });

    const id = createQuitLog({
      guildId: guild.id,
      userId: user.id,
      userTag: user.tag,
      channelId: channel.id,
      roles,
    });
    setQuitPanel(id, panelMsg.id);
    pruneQuitLogs(guild.id);
    logger.success(`Quit logu: ${user.tag} (${roles.length} rol kaydı)`);
  } catch (err) {
    logger.error('Quit log gönderilemedi.', err);
  }
}

async function handleQuitButton(interaction) {
  try {
    const rec = getQuitByPanel(interaction.message?.id);
    if (!rec) {
      await interaction
        .reply({ embeds: [buildErrorEmbed('Kayıt bulunamadı.')], flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }
    let roles = [];
    try {
      const parsed = JSON.parse(rec.roles || '[]');
      if (Array.isArray(parsed)) roles = parsed;
    } catch {
      /* bozuk kayıt → boş liste */
    }
    await interaction
      .reply({
        embeds: [buildQuitRolesEmbed({ userId: rec.user_id, userTag: rec.user_tag, roles, guild: interaction.guild })],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  } catch (err) {
    if (err?.code === 10062) {
      logger.error('Interaction EXPIRED: [quit_roles].');
      return true;
    }
    logger.error('Interaction failed: quit button.', err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* sessiz geç */
    }
  }
  return true;
}

module.exports = { handleMemberUpdate, handleMemberRemove, handleQuitButton };
