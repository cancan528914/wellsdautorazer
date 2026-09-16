/**
 * /ticketop - Ticket leaderboard'unu herkese açık PNG olarak gösterir.
 * Yetki kapısı + hatalar ephemeral; BAŞARILI sonuç herkese açık mesajdır.
 * Görsel her çağrıda güncel DB verisiyle dinamik üretilir (buffer, temp dosya yok).
 */
const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildTopEmbed } = require('../utils/ticketEmbeds');
const { fetchTopData, renderTopImage, fetchAvatar } = require('../utils/leaderboard');
const { getTopClaimers } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

async function fetchGuildIcon(guild) {
  try {
    const url = guild.iconURL?.({ extension: 'png', size: 128, forceStatic: true }) || null;
    if (!url) return null;
    return fetchAvatar(url);
  } catch {
    return null;
  }
}

module.exports = {
  data: new SlashCommandBuilder().setName('ticketop').setDescription('En fazla ticket sahiplenen ilk 10 yetkiliyi gösterir.'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ content: '❌ Bu komutu kullanma yetkiniz yok.', flags: MessageFlags.Ephemeral });
    }

    let rows = [];
    try {
      rows = getTopClaimers(interaction.guildId, 10);
    } catch (err) {
      logger.error('Interaction failed: /ticketop (db).', err);
      return interaction.reply({ embeds: [buildErrorEmbed('Sıralama alınırken bir hata oluştu.')], flags: MessageFlags.Ephemeral });
    }
    if (!rows.length) {
      return interaction.reply({ embeds: [buildTopEmbed([])], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const [data, iconBuffer] = await Promise.all([
        fetchTopData(interaction.guild, rows),
        fetchGuildIcon(interaction.guild),
      ]);
      const png = await renderTopImage({ guildName: interaction.guild.name, iconBuffer, rows: data });
      const attachment = new AttachmentBuilder(png, { name: 'ticketop.png' });
      return interaction.editReply({ content: '🏆 **Ticket Top 10**', files: [attachment] });
    } catch (err) {
      logger.error('Interaction failed: /ticketop (render).', err);
      return interaction.editReply({ content: '❌ Ticket leaderboard oluşturulurken bir hata oluştu.' }).catch(() => {});
    }
  },
};
