/**
 * /çekiliş - Ödüllü çekiliş başlatır (sadece yetkililer).
 * Yetki: admin VEYA staff rolü (diğer ekip komutlarıyla aynı kapı).
 * Kullanım: /çekiliş ödül:<metin> süre:<30s|5m|2h|3d> kazanan:<sayı> limit:<sayı|0=sınırsız> rol:<@rol|boş=herkes>
 * Katılım: paneldeki 🎉 reaksiyonu. Sonuç otomatik + 🔄 Reroll destekli.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageTickets } = require('../utils/permissions');
const { parseDuration, durationHelp, formatDurationShort, MAX_WINNERS, MAX_LIMIT, MAX_PRIZE_LEN } = require('../utils/giveawayEmbeds');
const { createGiveawayFlow } = require('../handlers/giveawayHandler');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('çekiliş')
    .setDescription('Ödüllü çekiliş başlatır (sadece yetkililer).')
    .addStringOption((opt) => opt.setName('ödül').setDescription('Çekiliş ödülü').setRequired(true).setMaxLength(MAX_PRIZE_LEN))
    .addStringOption((opt) => opt.setName('süre').setDescription('Örn: 30s, 5m, 2h, 3d (en az 30sn, en fazla 30 gün)').setRequired(true).setMaxLength(20))
    .addIntegerOption((opt) => opt.setName('kazanan').setDescription(`Kazanan sayısı (1-${MAX_WINNERS})`).setRequired(false).setMinValue(1).setMaxValue(MAX_WINNERS))
    .addIntegerOption((opt) => opt.setName('limit').setDescription('Kişi sınırı (0 = sınırsız)').setRequired(false).setMinValue(0).setMaxValue(MAX_LIMIT))
    .addRoleOption((opt) => opt.setName('rol').setDescription('Katılabilecek rol (boş = herkes)').setRequired(false)),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    const prize = (interaction.options.getString('ödül', true) || '').trim();
    const durationRaw = (interaction.options.getString('süre', true) || '').trim();
    const winnerCount = interaction.options.getInteger('kazanan') ?? 1;
    const maxParticipants = interaction.options.getInteger('limit') ?? 0;
    const requiredRole = interaction.options.getRole('rol') || null;

    if (!prize) {
      return interaction.reply({ embeds: [buildErrorEmbed('Ödül boş olamaz.')], flags: MessageFlags.Ephemeral });
    }
    const durationSec = parseDuration(durationRaw);
    if (!durationSec) {
      return interaction.reply({ embeds: [buildErrorEmbed(`Geçersiz süre: \`${durationRaw.slice(0, 20)}\`\n\n${durationHelp()}`)], flags: MessageFlags.Ephemeral });
    }
    if (requiredRole && requiredRole.managed) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bot/entegrasyon rolleri katılım şartı olarak seçilemez.')], flags: MessageFlags.Ephemeral });
    }

    const me = interaction.guild.members.me;
    if (!me?.permissions?.has('SendMessages')) {
      return interaction.reply({ embeds: [buildErrorEmbed('Botun bu kanala mesaj gönderme yetkisi yok.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const msg = await createGiveawayFlow(interaction, {
        prize,
        durationSec,
        winnerCount,
        maxParticipants,
        requiredRole,
      });
      logger.success(`Çekiliş paneli gönderildi: <#${interaction.channelId}> (${interaction.user.tag})`);
      return interaction.editReply({
        content: `✅ Çekiliş oluşturuldu: ${msg.url}\n🎁 **${prize.slice(0, 100)}** • ⏱️ ${formatDurationShort(durationSec)} • 🏆 ${winnerCount} kazanan`,
      });
    } catch (err) {
      logger.error('Interaction failed: /çekiliş.', err);
      const payload = { embeds: [buildErrorEmbed('Çekiliş oluşturulurken bir hata oluştu. Bot yetkilerini ve kanalı kontrol edin.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};
