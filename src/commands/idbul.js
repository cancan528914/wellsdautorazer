/**
 * /idbul — FiveM aktif oyuncuları arasında İSİM araması.
 *
 * DURUM: Sunucu sahibi oyuncu isimlerini paylaşmıyor (`players.json`
 * anonimleştirilmiş). Bu komut bu şartlarda çalışamaz ve SAHTE SONUÇ
 * ÜRETMEZ — durumu ve nedenini dürüstçe bildirir.
 *
 * Sunucu sahibi ileride izin verirse (sv_playersToken / rcon_password /
 * resource bridge) komut kendiliğinden gerçek aramaya döner; mantık
 * aynen korunmuştur.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const {
  buildTagEmptyEmbed,
  buildListUnavailableEmbed,
  buildAnonymizedEmbed,
  buildPagedPayload,
  errorTextFor,
} = require('../utils/fivemEmbeds');
const { buildPrivacyNoticeEmbed } = require('../utils/fivemTracking');
const { service, pagination, tracker } = require('../services/fivem');
const { validateSearchTerm } = require('../services/fivem/parser');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('idbul')
    .setDescription('Aktif oyuncular arasında isim arar.')
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
      const { query: q, matches } = await service.searchPlayers(term);
      tracker.record(q);

      // --- Gerçek arama mümkünse (sunucu sahibi izin vermişse) ---
      if (q.status === 'LIVE') {
        if (matches.length === 0) {
          return interaction.editReply({ embeds: [buildTagEmptyEmbed({ term })] });
        }
        const session = {
          type: 'tag',
          term,
          ownerId: String(interaction.user.id),
          players: matches,
          hostname: q.hostname,
          onlineCount: q.onlineCount,
          maxClients: q.maxClients,
          latencyMs: q.latencyMs,
          serverReported: q.serverReported,
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

      // --- İsimler gizli: dürüst cevap, sahte sonuÇ YOK ---
      if (q.status === 'ANONYMIZED') {
        return interaction.editReply({ embeds: [buildPrivacyNoticeEmbed(q, 'search')] });
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
      logger.error('Interaction failed: /idbul.', err);
      const payload = { embeds: [buildErrorEmbed('Arama sırasında bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};