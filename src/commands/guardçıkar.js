/**
 * /guardçıkar - Kullanıcıyı Guard whitelistinden siler (sadece adminler).
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { removeGuard } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guardçıkar')
    .setDescription('Kullanıcıyı Guard whitelistinden çıkarır (sadece adminler).')
    .addUserOption((opt) => opt.setName('user').setDescription('Whitelistten çıkarılacak kişi').setRequired(true)),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageGuard(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca Guard yöneticileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const user = interaction.options.getUser('user', true);
      const deleted = removeGuard(interaction.guildId, user.id);
      if (deleted) {
        logger.success(`Guard whitelistten çıkarıldı: ${user.tag}`);
        return interaction.reply({ content: `✅ <@${user.id}> Guard whitelistinden çıkarıldı.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: 'ℹ️ Bu kullanıcı Guard whitelistinde değil.', flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /guardçıkar.', err);
      const payload = { embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
