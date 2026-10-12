/**
 * /sunucudurum — herkese açık, kısa sunucu durumu.
 *
 * /fivemstatus'tan farklıdır: /fivemstatus yalnızca yetkililere açılan DERİN
 * teşhis (DNS/TCP/HTTP katmanları, RCON, token durumu) sunar. Bu komut
 * herkese açıktır ve sadece "sunucu açık mı, kaç oyuncu var, veri nereden
 * geliyor" bilgisini verir.
 *
 * Gerçek veri alınamıyorsa sahte bilgi ÜRETİLMEZ; durum açıkça raporlanır.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildServerStatusEmbed } = require('../utils/fivemEmbeds');
const { service } = require('../services/fivem');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sunucudurum')
    .setDescription('FiveM sunucusunun durumunu ve aktif oyuncu sayısını gösterir.'),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const q = await service.queryServer();
      return interaction.editReply({ embeds: [buildServerStatusEmbed(q)] });
    } catch (err) {
      logger.error('Interaction failed: /sunucudurum.', err);
      const payload = { embeds: [buildErrorEmbed('Sunucu durumu sorgulanırken bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};