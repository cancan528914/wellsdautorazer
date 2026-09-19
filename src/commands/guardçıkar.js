/**
 * /guardçıkar - Kullanıcıyı Guard whitelistinden siler (sadece Guard yöneticileri).
 * Kullanım config loguna yazılır (eski seviye dahil).
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { getGuardLevel, removeGuard } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { sendConfigLog } = require('../guard/logger');
const { LEVEL_META } = require('../guard/constants');
const logger = require('../utils/logger');

module.exports = {
  // Guard-yönetici rolü global kapıdan muaf tutulur (yetki canManageGuard ile denetlenir).
  openToGuardManagers: true,
  data: new SlashCommandBuilder()
    .setName('guardçıkar')
    .setDescription('Kullanıcıyı Guard whitelistinden çıkarır (sadece Guard yöneticileri).')
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
      const oldLevel = getGuardLevel(interaction.guildId, user.id);
      const oldLabel = LEVEL_META[oldLevel] ? `${LEVEL_META[oldLevel].emoji} ${LEVEL_META[oldLevel].label}` : '—';
      const deleted = removeGuard(interaction.guildId, user.id);
      if (deleted) {
        logger.success(`Guard whitelistten çıkarıldı: ${user.tag}`);
        await sendConfigLog(interaction.guild, {
          executor: interaction.user,
          action: '/guardçıkar',
          target: `<@${user.id}>`,
          detail: `Eski Seviye: ${oldLabel}`,
          resultOk: true,
        }).catch(() => {});
        const embed = new EmbedBuilder()
          .setColor(config.colors?.guardConfig ?? 0x3498db)
          .setTitle('🛡️ GUARD YETKİSİ ÇIKARILDI')
          .addFields(
            { name: 'Kullanıcı', value: `<@${user.id}>`, inline: true },
            { name: 'ID', value: `\`${user.id}\``, inline: true },
            { name: 'Eski Seviye', value: oldLabel, inline: false },
            { name: 'İşlemi yapan', value: `<@${interaction.user.id}>`, inline: false },
          )
          .setFooter({ text: `${config.botName} | Guard` })
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
