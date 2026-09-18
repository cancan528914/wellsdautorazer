/**
 * /id — FiveM sunucusundaki AKTİF oyuncuyu SERVER ID ile sorgular.
 * NOT: buradaki "id" FiveM server ID'dir, Discord user ID DEĞİLDİR (spec §31).
 * Başarılı sonuç + bulunamadı herkese açık embed; hatalar ephemeral.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildPlayerEmbed, buildPlayerNotFoundEmbed, errorTextFor } = require('../utils/fivemEmbeds');
const { service } = require('../services/fivem');
const { validatePlayerId } = require('../services/fivem/parser');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('id')
    .setDescription('FiveM sunucusundaki aktif oyuncuyu server ID ile sorgular.')
    .addIntegerOption((o) =>
      o.setName('id').setDescription('FiveM server ID (örn. 42)').setRequired(true).setMinValue(1).setMaxValue(100000),
    ),
  // FiveM sorguları herkese açık (global kapıdan muaf — /komutlar ile aynı model)
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
      const { found, query, player } = await service.findPlayerById(id);
      if (query.status === 'LIVE' && found && player) {
        return interaction.editReply({
          embeds: [
            buildPlayerEmbed({
              player,
              hostname: query.hostname,
              onlineCount: query.onlineCount,
              maxClients: query.maxClients,
              latencyMs: query.latencyMs,
              base: query.base,
            }),
          ],
        });
      }
      if (query.status === 'LIVE') {
        // Aktif değil — public sonuç embed'i (spec §17)
        return interaction.editReply({
          embeds: [
            buildPlayerNotFoundEmbed({
              id,
              hostname: query.hostname,
              onlineCount: query.onlineCount,
              maxClients: query.maxClients,
              latencyMs: query.latencyMs,
            }),
          ],
        });
      }
      if (query.status === 'PARTIAL') {
        return interaction.editReply({
          content: `⚠️ **Oyuncu listesi şu anda alınamıyor.**\nSunucu online görünüyor (${query.hostname || 'bilinmiyor'}) ama \`ID ${id}\` doğrulanamadı. Biraz bekleyip tekrar deneyin.`,
        });
      }
      return interaction.editReply({ embeds: [buildErrorEmbed(errorTextFor(query, query.base))] });
    } catch (err) {
      logger.error('Interaction failed: /id.', err);
      const payload = { embeds: [buildErrorEmbed('Sorgu sırasında bir hata oluştu.')] };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  },
};
