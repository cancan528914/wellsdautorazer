/**
 * /topluses - Seste aktif olan herkesi seçilen ses kanalına taşır.
 * Botlar taşınmaz. Kişi başı hata sayılır, işlem devam eder.
 * Yetki: ekip (canManageTickets) + botun Üyeleri Taşı yetkisi.
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOVE_DELAY_MS = 250; // rate-limit dostu bekleme

module.exports = {
  data: new SlashCommandBuilder()
    .setName('topluses')
    .setDescription('Sesteki herkesi seçilen ses kanalına taşır.')
    .addChannelOption((opt) =>
      opt
        .setName('kanal')
        .setDescription('Herkesin taşınacağı ses kanalı')
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
      const guild = interaction.guild;
      const target = interaction.options.getChannel('kanal', true);

      const me = guild.members.me;
      if (!me?.permissions?.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.editReply({ embeds: [buildErrorEmbed('Üyeleri taşıyamıyorum — bota **Üyeleri Taşı** yetkisi verin.')] });
      }

      const members = await guild.members.fetch();
      const inVoice = [...members.values()].filter(
        (m) => !m.user.bot && m.voice?.channelId && m.voice.channelId !== target.id,
      );

      if (!inVoice.length) {
        return interaction.editReply({ content: 'ℹ️ Seste taşınacak kimse bulunamadı.' });
      }

      let moved = 0;
      let failed = 0;
      logger.info(`Toplu taşıma başladı: ${inVoice.length} kişi → #${target.name || target.id} (${interaction.user.tag})`);

      for (const member of inVoice) {
        try {
          await member.voice.setChannel(target.id, `Toplu taşıma: ${interaction.user.tag}`);
          moved++;
        } catch (err) {
          failed++;
          logger.warn(`Taşınamadı: ${member.user.tag} (${err.code || err.message})`);
        }
        if (MOVE_DELAY_MS > 0) await sleep(MOVE_DELAY_MS);
      }

      logger.success(`Toplu taşıma bitti: taşınan=${moved} başarısız=${failed}`);
      const embed = new EmbedBuilder()
        .setColor(config.colors.success)
        .setTitle('🔊 Toplu Taşıma Sonucu')
        .setDescription(`Hedef: <#${target.id}>`)
        .addFields(
          { name: '✅ Taşınan', value: String(moved), inline: true },
          { name: '❌ Başarısız', value: String(failed), inline: true },
          { name: '📊 Toplam', value: String(moved + failed), inline: true },
        )
        .setFooter({ text: `${config.botName} | Ses` })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction failed: /topluses.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Taşıma sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
