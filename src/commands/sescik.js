/**
 * /sescik - Botu bulunduğu ses kanalından çıkarır (oto-katılım kaydını da siler).
 * Yetki: ticket ekibi / admin (canManageTickets).
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { leaveVoice, getCurrentChannelId } = require('../handlers/voiceHandler');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder().setName('sescik').setDescription('Botu ses kanalından çıkarır.'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const current = getCurrentChannelId(interaction.guildId);
      if (!current) {
        return interaction.reply({ content: 'ℹ️ Bot şu anda bir ses kanalında değil.', flags: MessageFlags.Ephemeral });
      }
      await leaveVoice(interaction.guildId);
      logger.success(`Sesten çıkıldı (komut: ${interaction.user.tag})`);
      return interaction.reply({ content: `🔇 Bot <#${current}> kanalından çıkarıldı.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /sescik.', err);
      const payload = { embeds: [buildErrorEmbed('Sesten çıkılırken bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
