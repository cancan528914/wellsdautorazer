/**
 * /tag — FiveM oyuncu isimlerinde geçen metni arar (case-insensitive substring, spec §13).
 * Toplam eşleşme sayısı HER ZAMAN gösterilir (spec §15). Başarılı sonuç herkese açık.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildTagEmptyEmbed, buildListUnavailableEmbed, buildPagedPayload, errorTextFor } = require('../utils/fivemEmbeds');
const { service, pagination } = require('../services/fivem');
const { validateSearchTerm } = require('../services/fivem/parser');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tag')
    .setDescription('FiveM aktif oyuncularında isim arar (örn. /tag wellsd).')
    .addStringOption((o) =>
      o.setName('isim').setDescription('Aranan metin (isim içinde geçer)').setRequired(true).setMaxLength(64),
    ),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    const term = validateSearchTerm(interaction.options.getString('isim'));
    if (!term) {
      return interaction.reply({ content: '❌ Geçersiz arama metni (1-64 karakter).', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const { query, matches } = await service.searchPlayers(term);

      if (query.status === 'LIVE') {
        if (!matches.length) {
          return interaction.editReply({ embeds: [buildTagEmptyEmbed({ term })] });
        }
        const session = {
          type: 'tag',
          term,
          ownerId: String(interaction.user.id),
          players: matches,
          hostname: query.hostname,
          onlineCount: query.onlineCount,
          maxClients: query.maxClients,
          latencyMs: query.latencyMs,
          serverReported: query.serverReported,
          page: 1,
        };
        const total = pagination.totalPagesFor(matches.length);
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

      if (query.status === 'PARTIAL') {
        return interaction.editReply({
          embeds: [
            buildListUnavailableEmbed({
              hostname: query.hostname,
              onlineCount: query.onlineCount,
              maxClients: query.maxClients,
              latencyMs: query.latencyMs,
              detail: query.detail,
            }),
          ],
        });
      }

      return interaction.editReply({ embeds: [buildErrorEmbed(errorTextFor(query, query.base))] });
    } catch (err) {
      logger.error('Interaction failed: /tag.', err);
      const payload = { embeds: [buildErrorEmbed('Sorgu sırasında bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};
