/**
 * /dmmesaj - Sunucudaki üyelere kontrollü toplu DM.
 * - Sadece yetkililer (ADMIN_ROLE_ID / Administrator / ManageGuild).
 * - Botlara göndermez, kendine göndermez.
 * - Her DM arası config.dm.delayMs bekler (rate-limit dostu, seri gönderim).
 * - Sonuç ephemeral özet olarak gösterilir.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildDmResultEmbed, buildErrorEmbed } = require('../utils/embeds');
const { canUseDm } = require('../utils/permissions');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dmmesaj')
    .setDescription('Sunucudaki üyelere DM gönderir (sadece yetkililer).')
    .addStringOption((opt) =>
      opt.setName('mesaj').setDescription('Gönderilecek mesaj').setRequired(true).setMaxLength(1800),
    ),

  async execute(interaction) {
    if (!canUseDm(interaction.member)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Bu komutu kullanma yetkiniz yok.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const text = interaction.options.getString('mesaj', true).trim();
    if (!text) {
      return interaction.reply({ embeds: [buildErrorEmbed('Mesaj boş olamaz.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply({ embeds: [buildErrorEmbed('Bu komut sadece sunucuda kullanılabilir.')] });
      }

      // Tüm üyeleri çek (büyük sunucularda biraz sürebilir)
      const members = await guild.members.fetch();
      let targets = [...members.values()].filter((m) => !m.user.bot && m.user.id !== interaction.client.user.id);

      if (config.dm.maxTargets > 0) targets = targets.slice(0, config.dm.maxTargets);

      let success = 0;
      let failed = 0;

      logger.info(`DM gönderimi başladı: ${targets.length} hedef (başlatan: ${interaction.user.tag})`);

      const prefix = `📩 **${guild.name}** duyurusu:\n\n`;

      for (const member of targets) {
        try {
          await member.send(`${prefix}${text}`);
          success++;
        } catch (err) {
          // DM kapalı / engelli / API hatası -> başarısız say, devam et
          failed++;
        }

        // Rate-limit koruması: her gönderim arası bekle
        if (config.dm.delayMs > 0) await sleep(config.dm.delayMs);
      }

      const total = success + failed;
      logger.success(`DM gönderimi tamamlandı: başarılı=${success} başarısız=${failed} toplam=${total}`);

      await interaction.editReply({ embeds: [buildDmResultEmbed(success, failed, total)] });
    } catch (err) {
      logger.error('Interaction failed: /dmmesaj çalışırken hata.', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('DM gönderimi sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
