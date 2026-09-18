/**
 * /aktifoyuncular — FiveM sunucusundaki TÜM aktif oyuncuları listeler.
 * BAŞARILI sonuç HERKESE AÇIK mesajdır (ephemeral YOK — spec §11).
 * Uzun listeler pagination ile sayfalanır; sayfa çevirme yeni API isteği yapmaz.
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
const { service, pagination } = require('../services/fivem');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder().setName('aktifoyuncular').setDescription('FiveM sunucusundaki tüm aktif oyuncuları listeler.'),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const q = await service.queryServer();

      if (q.status === 'LIVE') {
        if (!q.players.length) {
          // Online ama 0 oyuncu — OFFLINE ile karıştırma (spec §34)
          return interaction.editReply({
            embeds: [buildOnlineEmptyEmbed({ hostname: q.hostname, maxClients: q.maxClients, latencyMs: q.latencyMs })],
          });
        }
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
        const sent = await interaction.editReply(payload);
        // Oturumu gönderilen mesaja bağla (butonlar message.id ile çözer)
        try {
          const msg = await interaction.fetchReply();
          if (msg?.id) pagination.createSession(msg.id, session);
        } catch {
          /* oturum kurulamadıysa ilk sayfa yine de görünür */
        }
        void sent;
        return;
      }

      if (q.status === 'ANONYMIZED') {
        return interaction.editReply({
          embeds: [
            buildAnonymizedEmbed({
              hostname: q.hostname,
              onlineCount: q.onlineCount,
              maxClients: q.maxClients,
              latencyMs: q.latencyMs,
              base: q.base,
            }),
          ],
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
      logger.error('Interaction failed: /aktifoyuncular.', err);
      const payload = { embeds: [buildErrorEmbed('Sorgu sırasında bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};
