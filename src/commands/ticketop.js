/**
 * /ticketop - En fazla ticket sahiplenen ilk 10 yetkiliyi gösterir.
 * Yetki: ticket ekibi (canManageTickets) — diğer ticket komutlarıyla aynı kapı.
 * Veri loglardan değil, kalıcı istatistik tablosundan okunur.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildTopEmbed } = require('../utils/ticketEmbeds');
const { getTopClaimers } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder().setName('ticketop').setDescription('En fazla ticket sahiplenen ilk 10 yetkiliyi gösterir.'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ content: '❌ Bu komutu kullanma yetkiniz yok.', flags: MessageFlags.Ephemeral });
    }

    try {
      const rows = getTopClaimers(interaction.guildId, 10);
      return interaction.reply({ embeds: [buildTopEmbed(rows)], flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /ticketop.', err);
      const payload = { embeds: [buildErrorEmbed('Sıralama alınırken bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
