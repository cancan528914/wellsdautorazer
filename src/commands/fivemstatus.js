/**
 * /fivemstatus — FiveM endpoint katmanlı sağlık teşhisi (sadece yetkililer, ephemeral).
 * DNS → TCP → HTTP(info/dynamic/players) → JSON aşamalarını ayrı raporlar (§27, §38, §39).
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildStatusEmbed } = require('../utils/fivemEmbeds');
const { service } = require('../services/fivem');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder().setName('fivemstatus').setDescription('FiveM sunucu endpoint sağlık teşhisi (sadece yetkililer).'),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ content: '❌ Bu komutu kullanma yetkiniz yok.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const h = await service.getEndpointHealth();
      return interaction.editReply({ embeds: [buildStatusEmbed(h)] });
    } catch (err) {
      logger.error('Interaction failed: /fivemstatus.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Teşhis sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
