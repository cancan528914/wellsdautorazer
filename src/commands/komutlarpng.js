/**
 * /komutlarpng - Yardım menüsü görselini değiştirir (sadece yetkililer).
 * /komutlarpng png:[GÖRSEL]  → yeni görseli kaydeder (sağ üstte rozet olarak görünür).
 * /komutlarpng sıfırla:True  → varsayılana döner.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed, validateImageAttachment, PANEL_IMAGE_EXTS } = require('../utils/embeds');
const { setSetting, deleteSetting } = require('../database/database');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('komutlarpng')
    .setDescription('Yardım menüsü görselini değiştirir (sadece yetkililer).')
    .addAttachmentOption((opt) => opt.setName('png').setDescription('Menüde kullanılacak görsel').setRequired(false))
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
        setSetting('komutlar_image', attachment.url);
        logger.success(`Yardım menüsü görseli güncellendi (${interaction.user.tag}): ${attachment.name}`);
      } else {
        deleteSetting('komutlar_image');
        logger.success(`Yardım menüsü görseli sıfırlandı (${interaction.user.tag})`);
      }

      return interaction.editReply({
        content: reset
          ? '✅ Yardım menüsü görseli sıfırlandı. `/komutlar` ile kontrol edin.'
          : '✅ Yardım menüsü görseli güncellendi. `/komutlar` ile kontrol edin.',
      });
    } catch (err) {
      logger.error('Interaction failed: /komutlarpng.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Görsel kaydedilirken bir hata oluştu.')] }).catch(() => {});
    }
  },
};
