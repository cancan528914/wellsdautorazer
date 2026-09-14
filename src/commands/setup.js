/**
 * /setup - Botun ihtiyaç duyduğu log kanallarını kurar (sadece sunucu yöneticileri).
 * - Yoksa oluşturur, kayıtlıysa dokunmaz, aynı isimde kanal varsa devralır.
 * - .env'i yedekli günceller, ayar anında aktif olur (restart gerekmez).
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildSetupResultEmbed } = require('../utils/ticketEmbeds');
const { buildErrorEmbed } = require('../utils/embeds');
const { runSetup } = require('../handlers/setupHandler');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Log kanallarını kurar (ekip + yöneticiler).')
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await runSetup(interaction.guild);
      if (!result.ok && result.reason === 'bot-permission') {
        return interaction.editReply({
          embeds: [buildErrorEmbed('Log kanalı kuramıyorum — bota **Kanalları Yönet** yetkisi verin.')],
        });
      }
      if (!result.ok) {
        return interaction.editReply({ embeds: [buildErrorEmbed('Kurulum sırasında bir hata oluştu. Logları kontrol edin.')] });
      }
      return interaction.editReply({ embeds: [buildSetupResultEmbed(result)] });
    } catch (err) {
      logger.error('Interaction failed: /setup.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Kurulum sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
