/**
 * /mazeret - Mazeret bildirim panelini komutun kullanıldığı kanala gönderir (sadece yetkililer).
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed, buildMazeretPanelEmbed, buildMazeretOpenRow } = require('../utils/embeds');
const { upsertMazeretPanel } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder().setName('mazeret').setDescription('Mazeret bildirim paneli gönderir (sadece yetkililer).'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const panelMsg = await interaction.channel.send({
        embeds: [buildMazeretPanelEmbed()],
        components: [buildMazeretOpenRow()],
      });
      try {
        upsertMazeretPanel(interaction.guildId, interaction.channelId, panelMsg.id);
      } catch {
        /* panel takibi kritik değil */
      }
      logger.success(`Mazeret paneli gönderildi (#${interaction.channel?.name || interaction.channelId})`);
      return interaction.reply({ content: '✅ Mazeret paneli bu kanala gönderildi.', flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /mazeret.', err);
      const payload = { embeds: [buildErrorEmbed('Panel gönderilirken bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
