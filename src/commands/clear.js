/**
 * /clear - Mesaj silme (bulk delete limitlerine uygun).
 * - Yetki: ManageMessages veya admin.
 * - Miktar config.clear.min/max aralığında doğrulanır.
 * - 14 günden eski mesajlar Discord tarafından silinemez -> bulkDelete(..., true) ile filtrelenir.
 */
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildClearEmbed, buildErrorEmbed } = require('../utils/embeds');
const { canUseClear } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Belirtilen sayıda mesajı siler (sadece yetkililer).')
    .addIntegerOption((opt) =>
      opt.setName('miktar').setDescription(`Silinecek mesaj sayısı (${config.clear.min}-${config.clear.max})`).setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    if (!canUseClear(interaction.member)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Bu komutu kullanmak için **Mesajları Yönet** yetkisine sahip olmalısınız.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const amount = interaction.options.getInteger('miktar', true);

    if (!Number.isInteger(amount) || amount < config.clear.min || amount > config.clear.max) {
      return interaction.reply({
        embeds: [buildErrorEmbed(`Geçersiz miktar. Lütfen **${config.clear.min}-${config.clear.max}** arasında bir sayı girin.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Botun kanal iznini kontrol et
    const botMember = interaction.guild?.members?.me;
    const channel = interaction.channel;
    if (!channel?.isTextBased()) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu kanal türünde mesaj silinemiyor.')], flags: MessageFlags.Ephemeral });
    }
    if (botMember && !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Mesajları silebilmem için bu kanalda **Mesajları Yönet** iznine ihtiyacım var.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      // bulkDelete(amount, true): 14 günden eski mesajları otomatik filtreler
      const deleted = await channel.bulkDelete(amount, true);
      const count = deleted?.size ?? 0;

      logger.success(`CLEAR: #${channel.name || channel.id} kanalında ${count} mesaj silindi (isteyen: ${interaction.user.tag})`);

      const note =
        count < amount
          ? ' (Not: 14 günden eski mesajlar Discord tarafından silinemez, bu yüzden sayı düşük olabilir.)'
          : '';

      await interaction.reply({
        embeds: [buildClearEmbed(count, interaction.user.tag)],
        content: undefined,
        flags: MessageFlags.Ephemeral,
      });

      if (note) {
        await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (err) {
      logger.error('Interaction failed: /clear çalışırken hata.', err);
      const payload = { embeds: [buildErrorEmbed('Mesajlar silinirken bir hata oluştu. Botun yetkilerini kontrol edin.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
