/**
 * /id — FiveM Server ID ile oyuncu sorgusu.
 *
 * DURUM: Sunucu sahibi oyuncu ID'lerini gizliyor (`players.json` her kayıtta
 * `id=0` döndürüyor). Bu komut bu şartlarda çalışamaz ve SAHTE SONUÇ
 * ÜRETMEZ — durumu ve nedenini dürüstçe bildirir.
 *
 * Sunucu sahibi ileride izin verirse komut kendiliğinden gerçek sorguya
 * döner; mantık aynen korunmuştur.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const {
  buildPlayerEmbed,
  buildPlayerNotFoundEmbed,
  buildAnonymizedEmbed,
  errorTextFor,
} = require('../utils/fivemEmbeds');
const { buildPrivacyNoticeEmbed } = require('../utils/fivemTracking');
const { service, tracker } = require('../services/fivem');
const { validatePlayerId } = require('../services/fivem/parser');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('id')
    .setDescription('FiveM sunucusundaki aktif oyuncuyu Server ID ile sorgular.')
    .addIntegerOption((o) =>
      o
        .setName('id')
        .setDescription('FiveM Server ID (örn. 42)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100000),
    ),
  openToEveryone: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    const raw = interaction.options.getInteger('id');
    const id = validatePlayerId(raw);
    if (id === null) {
      return interaction.reply({ content: '❌ Geçersiz FiveM oyuncu ID’si.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      const { found, query: q, player } = await service.findPlayerById(id);
      tracker.record(q);

      // --- Gerçek sorgu mümkünse ---
      if (q.status === 'LIVE' && found && player) {
        return interaction.editReply({
          embeds: [
            buildPlayerEmbed({
              player,
              hostname: q.hostname,
              onlineCount: q.onlineCount,
              maxClients: q.maxClients,
              latencyMs: q.latencyMs,
              base: q.base,
            }),
          ],
        });
      }
      if (q.status === 'LIVE') {
        return interaction.editReply({
          embeds: [
            buildPlayerNotFoundEmbed({
              id,
              hostname: q.hostname,
              onlineCount: q.onlineCount,
              maxClients: q.maxClients,
              latencyMs: q.latencyMs,
            }),
          ],
        });
      }

      // --- ID'ler gizli: dürüst cevap ---
      if (q.status === 'ANONYMIZED') {
        return interaction.editReply({ embeds: [buildPrivacyNoticeEmbed(q, 'id')] });
      }

      if (q.status === 'PARTIAL') {
        return interaction.editReply({
          content: `⚠️ **Oyuncu listesi şu anda alınamıyor.**\nSunucu online görünüyor (${q.hostname || 'bilinmiyor'}) ama \`ID ${id}\` doğrulanamadı. Biraz bekleyip tekrar deneyin.`,
        });
      }

      return interaction.editReply({ embeds: [buildErrorEmbed(errorTextFor(q, q.base))] });
    } catch (err) {
      logger.error('Interaction failed: /id.', err);
      const payload = { embeds: [buildErrorEmbed('Sorgu sırasında bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};