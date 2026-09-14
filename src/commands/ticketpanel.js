/**
 * /ticketpanel - Ticket açma paneli gönderir (sadece ticket yetkilileri).
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildTicketPanelEmbed, buildCategoryMenu } = require('../utils/ticketEmbeds');
const { buildErrorEmbed } = require('../utils/embeds');
const { upsertTicketPanel } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Ticket açma paneli gönderir (sadece yetkililer).')
    .addChannelOption((opt) =>
      opt
        .setName('kanal')
        .setDescription('Panelin gönderileceği kanal (boşsa bu kanal / ayarlı panel kanalı)')
        .addChannelTypes(ChannelType.GuildText),
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca ticket yetkilileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      // Hedef kanal: opsiyon > TICKET_PANEL_CHANNEL_ID > mevcut kanal
      let target = interaction.options.getChannel('kanal') || null;
      if (!target && config.ticket.panelChannelId) {
        target = (await interaction.guild.channels.fetch(config.ticket.panelChannelId).catch(() => null)) || null;
        if (config.ticket.panelChannelId && !target) {
          logger.warn(`TICKET_PANEL_CHANNEL_ID geçersiz: ${config.ticket.panelChannelId} (mevcut kanal kullanılacak)`);
        }
      }
      target = target || interaction.channel;

      if (!target?.isTextBased()) {
        return interaction.reply({ embeds: [buildErrorEmbed('Panel yalnızca bir metin kanalına gönderilebilir.')], flags: MessageFlags.Ephemeral });
      }
      const me = interaction.guild.members.me;
      if (
        me &&
        (!target.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ||
          !target.permissionsFor(me)?.has(PermissionFlagsBits.EmbedLinks))
      ) {
        return interaction.reply({
          embeds: [buildErrorEmbed('Bu kanala mesaj/embed gönderme iznim yok. Bot izinlerini kontrol edin.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const response = await target.send({
        embeds: [buildTicketPanelEmbed(interaction.guild)],
        components: [buildCategoryMenu()],
      });

      upsertTicketPanel(interaction.guildId, target.id, response.id);
      logger.success(`Ticket paneli gönderildi: ${response.id} (#${target.name || target.id})`);

      const where = target.id === interaction.channelId ? 'bu kanala' : `<#${target.id}> kanalına`;
      return interaction.reply({ content: `✅ Ticket paneli ${where} gönderildi.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /ticketpanel oluşturulamadı.', err);
      const payload = { embeds: [buildErrorEmbed('Panel gönderilirken bir hata oluştu. Lütfen tekrar deneyin.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
