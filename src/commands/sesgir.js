/**
 * /sesgir - Botu seçilen ses kanalına sokar (orada kalır).
 * Yetki: ticket ekibi / admin (canManageTickets).
 */
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { joinVoice } = require('../handlers/voiceHandler');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sesgir')
    .setDescription('Botu ses kanalına sokar (kanalda kalır).')
    .addChannelOption((opt) =>
      opt
        .setName('kanal')
        .setDescription('Botun gireceği ses kanalı')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const channel = interaction.options.getChannel('kanal', true);
      const { channelId, moved } = await joinVoice(interaction.guild, channel);
      return interaction.editReply({
        content: moved ? `🔀 Bot <#${channelId}> kanalına **taşındı** ve orada kalacak.` : `🔊 Bot <#${channelId}> kanalına **girdi** ve orada kalacak.`,
      });
    } catch (err) {
      if (err?.code === 'ALREADY_THERE') {
        return interaction.editReply({ content: `ℹ️ ${err.message}` }).catch(() => {});
      }
      logger.error('Interaction failed: /sesgir.', err);
      const msg = err?.code && ['NO_CHANNEL', 'NOT_VOICE', 'NO_CONNECT_PERM', 'JOIN_TIMEOUT', 'VOICE_UDP_BLOCKED'].includes(err.code)
        ? err.message
        : 'Ses kanalına girilemedi. Lütfen tekrar deneyin.';
      return interaction.editReply({ embeds: [buildErrorEmbed(msg)] }).catch(() => {});
    }
  },
};
