/**
 * /oyuncular — Aktif oyuncu SAYISI ve hareketlilik.
 *
 * ÖNEMLİ: Bu komut artık oyuncu LİSTESİ basmaz. Sunucu sahibi
 * `players.json` çıktısını gizlediği için isimler ve Server ID'ler
 * alınamıyor. Bot sahte liste URETMEZ; erişebildiği gerçek veriyi gösterir.
 *
 * Erişim açılırsa (sunucu sahibi sv_playersToken tanımlarsa) komut otomatik
 * olarak gerçek listeye döner — çünkü service.queryServer() zinciri B/C
 * yollarını hâlâ deniyor.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const {
  buildOnlineEmptyEmbed,
  buildListUnavailableEmbed,
  buildAnonymizedEmbed,
  buildPagedPayload,
  errorTextFor,
} = require('../utils/fivemEmbeds');
const { buildCountEmbed, buildPrivacyNoticeEmbed } = require('../utils/fivemTracking');
const { service, pagination, tracker } = require('../services/fivem');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('oyuncular')
    .setDescription('Aktif oyuncu sayısını ve sunucu hareketliliğini gösterir.'),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const q = await service.queryServer();
      tracker.record(q);

      // --- Erişim açıldıysa gerçek liste (sunucu sahibi izin verirse) ---
      if (q.status === 'LIVE' && Array.isArray(q.players) && q.players.length) {
        const session = {
          type: 'players',
          term: null,
          ownerId: String(interaction.user.id),
          players: q.players,
          hostname: q.hostname,
          onlineCount: q.onlineCount,
          maxClients: q.maxClients,
          latencyMs: q.latencyMs,
          serverReported: q.serverReported,
          page: 1,
        };
        const total = pagination.totalPagesFor(q.players.length);
        const payload = buildPagedPayload(session, 1, total);
        await interaction.editReply(payload);
        try {
          const msg = await interaction.fetchReply();
          if (msg?.id) pagination.createSession(msg.id, session);
        } catch {
          /* oturum kurulamadıysa ilk sayfa yine de görünür */
        }
        return;
      }

      // --- Erişim kapalı: gerçek sayıyı göster, sahte liste YOK ---
      if (q.status === 'LIVE') {
        return interaction.editReply({
          embeds: [
            buildOnlineEmptyEmbed({
              hostname: q.hostname,
              maxClients: q.maxClients,
              latencyMs: q.latencyMs,
            }),
          ],
        });
      }

      if (q.status === 'ANONYMIZED') {
        return interaction.editReply({
          embeds: [buildCountEmbed(q, tracker.summary())],
        });
      }

      if (q.status === 'PARTIAL') {
        return interaction.editReply({
          embeds: [
            buildListUnavailableEmbed({
              hostname: q.hostname,
              onlineCount: q.onlineCount,
              maxClients: q.maxClients,
              latencyMs: q.latencyMs,
              detail: q.detail,
            }),
          ],
        });
      }

      return interaction.editReply({ embeds: [buildErrorEmbed(errorTextFor(q, q.base))] });
    } catch (err) {
      logger.error('Interaction failed: /oyuncular.', err);
      const payload = { embeds: [buildErrorEmbed('Sorgu sırasında bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};