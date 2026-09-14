/**
 * Mazeret sistemi: panel butonu → modal → bildirim mesajı panel kanalına düşer.
 * Durumsuzdur (DB gerekmez); spam koruması bellek-içi cooldown ile yapılır.
 */
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { buildErrorEmbed, buildMazeretReportEmbed } = require('../utils/embeds');

const MODAL_ID = 'mazeret_modal';
const cooldowns = new Map(); // `${guildId}:${userId}` -> timestamp

/**
 * Bildirim hedefi: MAZERET_CHANNEL_ID ayarlı ve geçerliyse orası,
 * yoksa panelin kanalı (geri uyumluluk + dayanıklılık).
 */
async function resolveMazeretChannel(interaction) {
  const id = config.mazeretChannelId;
  if (id && interaction.guild) {
    try {
      const ch = await interaction.guild.channels.fetch(id).catch(() => null);
      if (ch?.isTextBased()) return ch;
      logger.warn(`MAZERET_CHANNEL_ID geçersiz: ${id} (panel kanalı kullanılacak)`);
    } catch {
      /* alta düş */
    }
  }
  return interaction.channel;
}

function buildMazeretModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Mazeret Bildirimi')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('mazeret_sure')
          .setLabel('Süre (örn: 3 gün)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('mazeret_metin')
          .setLabel('Mazeretiniz')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

async function handleMazeretOpen(interaction) {
  try {
    await interaction.showModal(buildMazeretModal());
  } catch (err) {
    logger.error('Mazeret modalı açılamadı.', err);
    if (!interaction.replied && !interaction.deferred && interaction.isRepliable()) {
      await interaction.reply({ embeds: [buildErrorEmbed('Form açılamadı. Lütfen tekrar deneyin.')], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

async function handleMazeretSubmit(interaction) {
  try {
    const text = (interaction.fields.getTextInputValue('mazeret_metin') || '').trim();
    const sure = (interaction.fields.getTextInputValue('mazeret_sure') || '').trim();
    if (!text) {
      await interaction.reply({ embeds: [buildErrorEmbed('Mazeret metni boş olamaz.')], flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }

    const key = `${interaction.guildId}:${interaction.user.id}`;
    const waitMs = config.mazeretCooldownMs - (Date.now() - (cooldowns.get(key) || 0));
    if (waitMs > 0) {
      const secs = Math.ceil(waitMs / 1000);
      await interaction.reply({ content: `⏳ Çok sık bildirim yapıyorsunuz — **${secs} sn** sonra tekrar deneyin.`, flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }

    // Bildirim hedefi: ayarlı mazeret kanalı, yoksa panelin kanalı
    const target = await resolveMazeretChannel(interaction);
    await target.send({
      embeds: [buildMazeretReportEmbed({ userId: interaction.user.id, sure, text })],
    });
    cooldowns.set(key, Date.now());

    await interaction.reply({ content: '✅ Mazeretiniz bildirildi.', flags: MessageFlags.Ephemeral }).catch(() => {});
    logger.success(`Mazeret bildirildi (${interaction.user.tag})`);
  } catch (err) {
    if (err?.code === 10062) {
      logger.error('Interaction EXPIRED: [mazeret submit].');
      return true;
    }
    logger.error('Interaction failed: mazeret submit.', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [buildErrorEmbed('Bildirim gönderilemedi.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.isRepliable()) {
        await interaction.reply({ embeds: [buildErrorEmbed('Bildirim gönderilemedi.')], flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* sessiz geç */
    }
  }
  return true;
}

module.exports = { MODAL_ID, buildMazeretModal, handleMazeretOpen, handleMazeretSubmit, _cooldowns: cooldowns };
