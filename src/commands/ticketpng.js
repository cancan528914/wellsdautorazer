/**
 * /ticketpng - Ticket panel görselini değiştirir (sadece ticket yetkilileri).
 * /ticketpng png:[GÖRSEL]  → yeni görseli kaydeder, kayıtlı paneli günceller.
 * /ticketpng sıfırla:True  → varsayılan görsele döner.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed, validateImageAttachment, PANEL_IMAGE_EXTS } = require('../utils/embeds');
const { buildTicketPanelEmbed } = require('../utils/ticketEmbeds');
const { setSetting, deleteSetting, getTicketPanel } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticketpng')
    .setDescription('Ticket panel görselini değiştirir (sadece yetkililer).')
    .addAttachmentOption((opt) => opt.setName('png').setDescription('Panelde kullanılacak görsel').setRequired(false))
    .addBooleanOption((opt) => opt.setName('sifirla').setDescription('Varsayılan görsele dön').setRequired(false)),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca ticket yetkilileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const reset = interaction.options.getBoolean('sifirla') || false;
      const attachment = interaction.options.getAttachment('png') || null;

      if (!reset) {
        if (!attachment) {
          return interaction.editReply({ embeds: [buildErrorEmbed('Bir görsel yükleyin (`png` seçeneği) veya `sıfırla:True` kullanın.')] });
        }
        const check = validateImageAttachment(attachment);
        if (!check.ok && check.reason === 'size') {
          return interaction.editReply({ embeds: [buildErrorEmbed('Görsel çok büyük (en fazla 8 MB).')] });
        }
        if (!check.ok) {
          return interaction.editReply({
            embeds: [buildErrorEmbed(`Desteklenmeyen format. İzin verilenler: ${PANEL_IMAGE_EXTS.join(', ').toUpperCase()}`)],
          });
        }
        setSetting('ticket_panel_image', attachment.url);
        logger.success(`Ticket panel görseli güncellendi (${interaction.user.tag}): ${attachment.name}`);
      } else {
        deleteSetting('ticket_panel_image');
        logger.success(`Ticket panel görseli sıfırlandı (${interaction.user.tag})`);
      }

      // Kayıtlı mevcut paneli de güncelle
      let panelNote = '';
      const panel = getTicketPanel(interaction.guildId);
      if (panel) {
        try {
          const ch = await interaction.guild.channels.fetch(panel.channel_id).catch(() => null);
          const msg = ch?.isTextBased() ? await ch.messages.fetch(panel.message_id).catch(() => null) : null;
          if (msg) {
            await msg.edit({ embeds: [buildTicketPanelEmbed(interaction.guild)] });
            panelNote = '\nMevcut panel de güncellendi.';
          } else {
            panelNote = '\nNot: Kayıtlı panel mesajı bulunamadı (silinmiş olabilir). Sonraki panellerde yeni görsel kullanılacak.';
          }
        } catch (err) {
          logger.warn(`Ticket paneli güncellenemedi: ${err.code || err.message}`);
          panelNote = '\nNot: Mevcut panel güncellenemedi. Sonraki panellerde yeni görsel kullanılacak.';
        }
      } else {
        panelNote = '\nNot: Kayıtlı panel yok. Sonraki `/ticketpanel` çıktısında yeni görsel kullanılacak.';
      }

      return interaction.editReply({
        content: reset ? `✅ Panel görseli sıfırlandı.${panelNote}` : `✅ Panel görseli güncellendi.${panelNote}`,
      });
    } catch (err) {
      logger.error('Interaction failed: /ticketpng.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Görsel kaydedilirken bir hata oluştu.')] }).catch(() => {});
    }
  },
};
