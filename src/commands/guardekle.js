/**
 * /guardekle - Kullanıcıyı Guard whitelist'ine ekler/günceller (sadece Guard yöneticileri).
 * Whitelistte olmak bu komuta erişim vermez. Kullanım config loguna yazılır.
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { setGuardLevel } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { sendConfigLog } = require('../guard/logger');
const { LEVEL_META } = require('../guard/constants');
const logger = require('../utils/logger');

module.exports = {
  // Guard-yönetici rolü global kapıdan muaf tutulur (yetki canManageGuard ile denetlenir).
  openToGuardManagers: true,
  data: new SlashCommandBuilder()
    .setName('guardekle')
    .setDescription('Kullanıcıyı Guard whitelistine ekler (sadece Guard yöneticileri).')
    .addUserOption((opt) => opt.setName('user').setDescription('Whiteliste eklenecek kişi').setRequired(true))
    .addIntegerOption((opt) =>
      opt
        .setName('level')
        .setDescription('Guard seviyesi')
        .setRequired(true)
        .addChoices(
          { name: '🎭 Rol Guard', value: 1 },
          { name: '📁 Kanal Guard', value: 2 },
          { name: '🔨 Ban & Kick Guard', value: 3 },
          { name: '👑 URL Guard', value: 4 },
        ),
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageGuard(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca Guard yöneticileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const user = interaction.options.getUser('user', true);
      const level = interaction.options.getInteger('level', true);
      if (!LEVEL_META[level]) {
        return interaction.reply({ embeds: [buildErrorEmbed('Geçersiz Guard seviyesi (1-4).')], flags: MessageFlags.Ephemeral });
      }
      const { created } = setGuardLevel(interaction.guildId, user.id, level, interaction.user.id);
      const meta = LEVEL_META[level];
      logger.success(`Guard whitelist ${created ? 'eklendi' : 'güncellendi'}: ${user.tag} → ${meta.label}`);
      await sendConfigLog(interaction.guild, {
        executor: interaction.user,
        action: '/guardekle',
        target: `<@${user.id}>`,
        detail: `New Level: ${meta.emoji} ${meta.label} (${created ? 'yeni kayıt' : 'güncelleme'})`,
        resultOk: true,
      }).catch(() => {});
      const embed = new EmbedBuilder()
        .setColor(config.colors?.guardConfig ?? 0x3498db)
        .setTitle('🛡️ GUARD YETKİSİ VERİLDİ')
        .addFields(
          { name: 'Kullanıcı', value: `<@${user.id}>`, inline: true },
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Seviye', value: `${meta.emoji} ${meta.label}`, inline: false },
          { name: 'İşlemi yapan', value: `<@${interaction.user.id}>`, inline: false },
        )
        .setFooter({ text: `${config.botName} | Guard` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /guardekle.', err);
      const payload = { embeds: [buildErrorEmbed('Kayıt sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
