/**
 * /guardliste - Şık Guard paneli + görüntüleme kaydı (sadece Guard yöneticileri).
 * Çok kayıtta description sayfalama (embed limitleri içinde, tek cevapta max 10 embed).
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { listWhitelist } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { sendListViewLog } = require('../guard/logger');
const { LEVEL_META } = require('../guard/constants');
const logger = require('../utils/logger');

const LEVEL_STYLE = {
  4: { color: 0x9b59b6, header: '🟣 URL GUARD' },
  3: { color: 0xe74c3c, header: '🔴 BAN & KICK GUARD' },
  2: { color: 0x3498db, header: '🔵 KANAL GUARD' },
  1: { color: 0x2ecc71, header: '🟢 ROL GUARD' },
};
const DIV = '━━━━━━━━━━━━━━━━━━';
const MAX_EMBEDS = 10;

function entryBlock(userId) {
  return `<@${userId}>\nID: \`${userId}\``;
}

/** Satırları description-limitli sayfalara böl. */
function paginate(lines) {
  const pages = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > 3900 && cur) {
      pages.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) pages.push(cur);
  return pages;
}

function buildPages(rows) {
  const lines = [`${DIV}`, '🛡️  GUARD SYSTEM', `${DIV}`, ''];
  for (const level of [4, 3, 2, 1]) {
    const ids = rows.filter((r) => Number(r.level) === level).map((r) => String(r.user_id));
    if (!ids.length) continue;
    lines.push(LEVEL_STYLE[level].header, '');
    for (const id of ids) lines.push(entryBlock(id), '');
  }
  lines.push(`${DIV}`, '', `👥 TOPLAM GUARD: ${rows.length}`, '🟢 SİSTEM: AKTİF');
  const pages = paginate(lines);
  return pages.slice(0, MAX_EMBEDS).map((text, i) => {
    const embed = new EmbedBuilder()
      .setColor(config.colors?.guardPanel ?? 0x9b59b6)
      .setDescription(text)
      .setFooter({ text: `${config.botName} | Guard System • Aztecas${pages.length > 1 ? ` • ${i + 1}/${Math.min(pages.length, MAX_EMBEDS)}` : ''}` })
      .setTimestamp();
    if (i === 0) embed.setTitle('🛡️ Guard Paneli');
    return embed;
  });
}

module.exports = {
  data: new SlashCommandBuilder().setName('guardliste').setDescription('Guard panelini gösterir (sadece Guard yöneticileri).'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageGuard(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca Guard yöneticileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const rows = listWhitelist(interaction.guildId);
      if (!rows.length) {
        const empty = new EmbedBuilder()
          .setColor(config.colors?.guardPanel ?? 0x9b59b6)
          .setTitle('🛡️ Guard Paneli')
          .setDescription(`${DIV}\n🛡️  GUARD SYSTEM\n${DIV}\n\n*Whitelist boş. \`/guardekle\` ile ekleyin.*`)
          .setFooter({ text: `${config.botName} | Guard System • Aztecas` })
          .setTimestamp();
        await interaction.reply({ embeds: [empty], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: buildPages(rows), flags: MessageFlags.Ephemeral });
      }
      // Görüntüleme kaydı (ihlâl değil — best effort, komutu etkilemez)
      await sendListViewLog(interaction.guild, { viewer: interaction.user, count: rows.length }).catch(() => {});
      return undefined;
    } catch (err) {
      logger.error('Interaction failed: /guardliste.', err);
      const payload = { embeds: [buildErrorEmbed('Liste alınırken bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },
  // testler için
  _paginate: paginate,
  _buildPages: buildPages,
};
