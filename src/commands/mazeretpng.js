/**
 * /mazeretpng - Mazeret panel görselini değiştirir (sadece yetkililer).
 * /mazeretpng png:[GÖRSEL]  → yeni görseli kaydeder, kayıtlı paneli günceller.
 * /mazeretpng sıfırla:True  → varsayılan görsele döner.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed, buildMazeretPanelEmbed, validateImageAttachment, PANEL_IMAGE_EXTS } = require('../utils/embeds');
const { setSetting, deleteSetting, getMazeretPanel } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mazeretpng')
    .setDescription('Mazeret panel görselini değiştirir (sadece yetkililer).')
    .addAttachmentOption((opt) => opt.setName('png').setDescription('Panelde kullanılacak görsel').setRequired(false))
    .addBooleanOption((opt) => opt.setName('sifirla').setDescription('Varsayılan görsele dön').setRequired(false)),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
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
        setSetting('mazeret_panel_image', attachment.url);
        logger.success(`Mazeret panel görseli güncellendi (${interaction.user.tag}): ${attachment.name}`);
      } else {
        deleteSetting('mazeret_panel_image');
        logger.success(`Mazeret panel görseli sıfırlandı (${interaction.user.tag})`);
      }

      // Kayıtlı mevcut paneli de güncelle
      let panelNote = '';
      const panel = getMazeretPanel(interaction.guildId);
      if (panel) {
        try {
          const ch = await interaction.guild.channels.fetch(panel.channel_id).catch(() => null);
          const msg = ch?.isTextBased() ? await ch.messages.fetch(panel.message_id).catch(() => null) : null;
          if (msg) {
            await msg.edit({ embeds: [buildMazeretPanelEmbed()] });
            panelNote = '\nMevcut panel de güncellendi.';
          } else {
            panelNote = '\nNot: Kayıtlı panel mesajı bulunamadı (silinmiş olabilir). Sonraki panellerde yeni görsel kullanılacak.';
          }
        } catch (err) {
          logger.warn(`Mazeret paneli güncellenemedi: ${err.code || err.message}`);
          panelNote = '\nNot: Mevcut panel güncellenemedi. Sonraki panellerde yeni görsel kullanılacak.';
        }
      } else {
        panelNote = '\nNot: Kayıtlı panel yok. Sonraki `/mazeret` çıktısında yeni görsel kullanılacak.';
      }

      return interaction.editReply({
        content: reset ? `✅ Panel görseli sıfırlandı.${panelNote}` : `✅ Panel görseli güncellendi.${panelNote}`,
      });
    } catch (err) {
      logger.error('Interaction failed: /mazeretpng.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Görsel kaydedilirken bir hata oluştu.')] }).catch(() => {});
    }
  },
};
