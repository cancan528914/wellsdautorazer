/**
 * /ingame - INGAME katılım / ayrılma paneli
 * Butonlar restart-safe: customId statik, durum DB'den message.id ile çözülür.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { buildIngameEmbed, buildErrorEmbed } = require('../utils/embeds');
const { upsertSystem } = require('../database/database');
const { canUseIngame } = require('../utils/permissions');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ingame_join').setLabel('Katıl').setStyle(ButtonStyle.Success).setEmoji('🟢'),
    new ButtonBuilder().setCustomId('ingame_leave').setLabel('Ayrıl').setStyle(ButtonStyle.Danger).setEmoji('🔴'),
  );
}

/**
 * Panel mesajını doğrula. withResponse ile mesaj POST cevabında gelir (ekstra GET
 * yok → Unknown Message (10008) yarışı olmaz). Nadir Discord yayılma gecikmesine
 * karşı kısa retry fallback'i vardır.
 */
async function resolvePanelMessage(interaction, response) {
  let message = response?.resource?.message ?? null;
  for (let i = 0; i < 5 && !message?.id; i++) {
    await sleep(1000);
    try {
      message = await interaction.fetchReply();
    } catch {
      message = null;
    }
  }
  return message;
}

module.exports = {
  data: new SlashCommandBuilder().setName('ingame').setDescription('INGAME katılım paneli oluşturur.'),

  async execute(interaction) {
    if (!canUseIngame(interaction.member)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Bu komutu kullanma yetkiniz yok.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      const embed = buildIngameEmbed([], []);
      const response = await interaction.reply({
        embeds: [embed],
        components: [buildButtons()],
        withResponse: true,
      });

      const message = await resolvePanelMessage(interaction, response);
      if (!message?.id) throw new Error('Panel mesajı doğrulanamadı (fetchReply başarısız).');

      upsertSystem({
        messageId: message.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        type: 'ingame',
        createdBy: interaction.user.id,
      });

      logger.success(`INGAME paneli oluşturuldu: ${message.id} (#${interaction.channel?.name || interaction.channelId})`);
    } catch (err) {
      logger.error('Interaction failed: /ingame oluşturulamadı.', err);
      const payload = {
        embeds: [buildErrorEmbed('Panel oluşturulurken bir hata oluştu. Lütfen tekrar deneyin.')],
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },

  buildButtons,
  resolvePanelMessage,
};
