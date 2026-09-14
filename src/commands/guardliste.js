/**
 * /guardliste - Sunucunun Guard whitelistini seviyelere göre listeler (sadece adminler).
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { listWhitelist } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { LEVEL_META } = require('../guard/constants');
const logger = require('../utils/logger');

/** Mention listesini 1024 karakterlik parçalara böl (embed limiti). */
function chunkMentions(ids) {
  const chunks = [];
  let cur = '';
  for (const id of ids) {
    const m = `<@${id}>`;
    if ((cur + '\n' + m).length > 1000 && cur) {
      chunks.push(cur);
      cur = m;
    } else {
      cur = cur ? `${cur}\n${m}` : m;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : ['*Kimse yok.*'];
}

module.exports = {
  data: new SlashCommandBuilder().setName('guardliste').setDescription('Guard whitelistini listeler (sadece adminler).'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageGuard(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca Guard yöneticileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const rows = listWhitelist(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🛡️ GUARD WHITELIST')
        .setFooter({ text: `${config.botName} | Guard` })
        .setTimestamp();

      if (!rows.length) {
        embed.setDescription('*Whitelist boş. `/guardekle` ile ekleyin.*');
      } else {
        for (const level of [4, 3, 2, 1]) {
          const ids = rows.filter((r) => Number(r.level) === level).map((r) => String(r.user_id));
          if (!ids.length) continue;
          const meta = LEVEL_META[level];
          const parts = chunkMentions(ids);
          parts.forEach((text, i) => {
            embed.addFields({ name: i === 0 ? `${meta.emoji} ${meta.label.toUpperCase()}` : `${meta.emoji} ${meta.label.toUpperCase()} (devam)`, value: text, inline: false });
          });
        }
        embed.addFields({ name: 'Toplam Guard', value: String(rows.length), inline: false });
      }

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /guardliste.', err);
      const payload = { embeds: [buildErrorEmbed('Liste alınırken bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
};
