/**
 * /sunucudurum — FiveM sunucusunun DURUMU ve hareketliliği.
 *
 * Bu, artık projenin ana komutudur: sunucu sahibi oyuncu isimlerini
 * paylaşmadığı için burada ERİŞİLEBİLEN gerçek veriler gösterilir.
 *
 * Her şey gerçek veriden gelir; sunucuya ulaşılamıyorsa dürüstçe söylenir.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildServerStatusEmbed, buildPanelEmbed } = require('../utils/fivemEmbeds');
const { buildActivityEmbed } = require('../utils/fivemTracking');
const { service, tracker } = require('../services/fivem');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sunucudurum')
    .setDescription('FiveM sunucusunun durumunu, oyuncu sayısını ve hareketliliğini gösterir.'),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const q = await service.queryServer();
      // Bu sorguyu da takipçiye kaydet (panel kapalıysa bile geçmiş oluşsun).
      tracker.record(q);

      // Durum embed'ini hareketlilik alanıyla zenginleştir.
      const status = buildServerStatusEmbed({ ...q, onlineCount: q.onlineCount ?? tracker.summary().current });

      if (q.status === 'OFFLINE' || q.status === 'ERROR') {
        return interaction.editReply({ embeds: [status] });
      }

      const activity = buildActivityEmbed(tracker.summary());

      // Çok satırlı embed yükünü düşürmek için tek embed + kısa özet
      return interaction.editReply({
        embeds: [
          status,
          {
            ...activity.toJSON(),
            footer: { text: 'Sayısal takip • isimler sunucu tarafından paylaşılmıyor' },
          },
        ],
      });
    } catch (err) {
      logger.error('Interaction failed: /sunucudurum.', err);
      const payload = { embeds: [buildErrorEmbed('Sunucu durumu sorgulanırken bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};