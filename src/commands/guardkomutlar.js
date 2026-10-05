/**
 * /guardkomutlar - Guard komutlarının profesyonel yardım listesi.
 * Her komutun ne işe yaradığını açıklar; guard yönetimiyle sınırlıdır.
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageGuard } = require('../guard/permissions');
const { sendGuardLog } = require('../guard/logService');
const { LOG_CHANNELS } = require('../guard/constants');
const { countGuardLogChannels } = require('../../src/database/database');
const logger = require('../utils/logger');

const DIV = '━━━━━━━━━━━━━━━━━━';

// Komut kataloğu — isim/açıklama tek yerde tutulur (iki yerde tekrar yok).
const COMMAND_CATALOG = [
  { cmd: '/guardlogsetup', group: 'Kurulum', desc: '12 log kanalını oluşturur/onar (idempotent, tekrar çalıştırmak güvenli).' },
  { cmd: '/guardsetup', group: 'Kurulum', desc: 'Guard sistemini açar, log altyapısını ve bot izinlerini raporlar.' },
  { cmd: '/guardekle', group: 'Whitelist', desc: 'Bir kullanıcıyı Guard whitelistine ekler (seviye 1-4).' },
  { cmd: '/guardçıkar', group: 'Whitelist', desc: 'Bir kullanıcıyı Guard whitelistinden çıkarır.' },
  { cmd: '/guardliste', group: 'Whitelist', desc: 'Whitelist panosunu ve toplam kullanıcı sayısını gösterir.' },
  { cmd: '/guardkomutlar', group: 'Yardım', desc: 'Bu menüyü gösterir.' },
];

module.exports = {
  openToGuardManagers: true,
  data: new SlashCommandBuilder()
    .setName('guardkomutlar')
    .setDescription('Guard komutlarının tam listesini ve açıklamasını gösterir.'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageGuard(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca Guard yöneticileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    try {
      const groups = [...new Set(COMMAND_CATALOG.map((c) => c.group))];
      const embed = new EmbedBuilder()
        .setColor(config.colors?.guardPanel ?? 0x9b59b6)
        .setTitle('🛡️ Guard Komutları')
        .setDescription(
          `${DIV}\n**Javrex Guard Yönetim Menüsü**\n${DIV}\n` +
            `Aşağıdaki komutlar yalnızca **Guard yöneticileri** tarafından kullanılabilir.\n` +
            `Admins, eski guard rolleri veya whitelist seviyesi tek başına erişim sağlamaz.`,
        )
        .setTimestamp()
        .setFooter({ text: `${config.botName} Guard • Yardım` });

      for (const g of groups) {
        const cmds = COMMAND_CATALOG.filter((c) => c.group === g);
        embed.addFields({
          name: g,
          value: cmds.map((c) => `**${c.cmd}**\n${c.desc}`).join('\n\n').slice(0, 1024),
          inline: false,
        });
      }

      // Altyapı durumu (log kanalları)
      const logCount = countGuardLogChannels(interaction.guildId);
      embed.addFields({
        name: '📁 Log Altyapısı',
        value:
          logCount >= LOG_CHANNELS.length
            ? `✅ ${logCount}/${LOG_CHANNELS.length} kanal hazır`
            : `⚠️ ${logCount}/${LOG_CHANNELS.length} kanal kayıtlı — \`/guardlogsetup\` çalıştırın`,
        inline: false,
      });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

      // Görüntüleme kaydı (ihlal değil, sistem hareketi)
      await sendGuardLog({
        guild: interaction.guild,
        title: 'Komut Menüsü Görüntülendi',
        action: '/guardkomutlar',
        actor: { id: interaction.user.id },
      }).catch(() => {});
      return undefined;
    } catch (err) {
      logger.error('Interaction failed: /guardkomutlar.', err);
      const payload = { embeds: [buildErrorEmbed('Menü gösterilemedi.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  },

  COMMAND_CATALOG,
};