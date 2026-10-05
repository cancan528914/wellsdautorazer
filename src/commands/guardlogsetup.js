/**
 * /guardlogsetup - Guard log altyapısını idempotent olarak kurar.
 *
 * Davranış:
 *  - GUARD LOGS kategorisini bulur veya oluşturur (yoksa)
 *  - Altındaki 12 log kanalını bulur veya oluşturur (eksik olanları)
 *  - Tekrar çalıştırılırsa HİÇBİR yeni kanal oluşturmaz
 *  - Silinmiş kanalları yeniden oluşturur
 *  - Tüm kanallara @everyone deny + bot/guard-yönetici izinlerini uygular
 *
 * Yetki: SADECE guard yöneticileri (rol veya istisna kullanıcı).
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageGuard } = require('../guard/permissions');
const { ensureAllLogChannels, invalidateLogChannel } = require('../guard/logChannels');
const { sendGuardLog } = require('../guard/logService');
const { LOG_CHANNELS } = require('../guard/constants');
const { getGuardLogChannels } = require('../../src/database/database');
const logger = require('../utils/logger');

module.exports = {
  // Guard-yönetici rolü/kişisi global kapıdan muaf; yetki canManageGuard denetler.
  openToGuardManagers: true,
  data: new SlashCommandBuilder()
    .setName('guardlogsetup')
    .setDescription('Guard log kanallarını oluşturur / onarır (sadece Guard yöneticileri).')
    .addBooleanOption((opt) =>
      opt.setName('izinsiz').setDescription('Kanalları normal üyelere görünmez yapar (varsayılan: evet)').setRequired(false),
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageGuard(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca Guard yöneticileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      const me = guild.members.me;

      // Bot gerekli yetkilere sahip mi?
      const need = PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;
      if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.editReply({
          embeds: [buildErrorEmbed('Log kanallarını oluşturamıyorum — bota **Kanalları Yönet** yetkisi verin.')],
        });
      }

      // İdempotent kurulum (kanal oluşturma/izin onarımının TEK yeri)
      const result = await ensureAllLogChannels(guild);

      // Kurulum sonrası önbelleği temizle (yeni kanallar hemen kullanılsın)
      invalidateLogChannel(guild.id);

      if (result.error === 'bot-permission') {
        return interaction.editReply({
          embeds: [buildErrorEmbed('Log altyapısı kurulamadı — bota **Kanalları Yönet** yetkisi verin.')],
        });
      }

      // Kalıcı kayıt: guard_settings (uyumluluk) + guard-log özel kayıt
      const dbSaveGuard = require('../../src/database/database');
      const guardLogId = dbSaveGuard.getGuardLogChannel(guild.id, 'guard');
      if (guardLogId) {
        dbSaveGuard.saveGuardSettings(guild.id, { logChannelId: guardLogId, enabled: true });
      }

      // Setup işlemini guard-log'a da yaz (sistem hareketi kaydı)
      await sendGuardLog({
        guild,
        title: 'Log Altyapısı Kuruldu',
        action: `/guardlogsetup çalıştırıldı`,
        detail:
          `Oluşturulan: ${result.created.length || 0} • Mevcut: ${result.existing.length || 0} • Hatalı: ${result.failed.length || 0}` +
          (result.created.length ? `\n\n**Yeni oluşturulan:**\n${result.created.map((c) => `• \`#${c}\``).join('\n')}` : '') +
          (result.failed.length ? `\n\n**Hatalı:**\n${result.failed.map((f) => `• \`#${f.name}\` — ${f.error}`).join('\n')}` : ''),
        status: { ok: result.failed.length === 0, text: result.failed.length === 0 ? 'Tüm kanallar hazır' : `${result.failed.length} kanal oluşturulamadı` },
        actor: { id: interaction.user.id },
      }).catch(() => {});

      // Rapor embed'i
      const embed = buildSetupReport(guild, result);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction failed: /guardlogsetup.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Log altyapısı kurulurken bir hata oluştu.')] }).catch(() => {});
    }
  },
};

/** Kurulum raporu embed'i — her kanalın durumunu gösterir. */
function buildSetupReport(guild, result) {
  const dbSaveGuard = require('../../src/database/database');
  const recorded = getGuardLogChannels(guild.id);
  const isFirst = result.created.length > 0;

  const embed = new EmbedBuilder()
    .setColor(result.failed.length ? 0xe67e22 : 0x2ecc71)
    .setTitle('🛡️ GUARD LOG SETUP')
    .setDescription(
      isFirst
        ? `Log altyapısı **oluşturuldu**. Toplam **${LOG_CHANNELS.length}** kanal hazır.`
        : `Log altyapısı **zaten kurulu**. Eksik kanal yok — ${result.existing.length} kanal doğrulandı.` +
          (result.created.length ? `\n\nBu çalıştırmada **${result.created.length}** kanal oluşturuldu: ${result.created.join(', ')}` : ''),
    )
    .setTimestamp()
    .setFooter({ text: `${config.botName} Guard • Kurulum Raporu` });

  // Kanal listesi (durum renkli)
  const lines = LOG_CHANNELS.map((c) => {
    const chId = recorded[c.key];
    const failed = result.failed.find((f) => f.key === c.key);
    const mark = failed ? '🔴' : chId ? '🟢' : '⚪';
    const note = failed ? ' (hata)' : chId ? ` <#${chId}>` : '';
    return `${mark} ${c.emoji} \`#${c.name}\`${note}`;
  });
  embed.addFields({ name: '📁 Kanallar', value: lines.join('\n').slice(0, 1024), inline: false });

  // Özet
  embed.addFields(
    { name: '✅ Oluşturulan', value: String(result.created.length), inline: true },
    { name: '♻️ Mevcut', value: String(result.existing.length), inline: true },
    { name: '🔴 Hatalı', value: String(result.failed.length), inline: true },
  );
  embed.addFields({
    name: '🔒 Güvenlik',
    value: 'Tüm log kanallarında normal üyelerin görüntüleme/yazma izni kapatıldı.',
    inline: false,
  });

  if (result.failed.length) {
    embed.addFields({
      name: '⚠️ Hatalı Kanallar',
      value: result.failed.map((f) => `• \`#${f.name}\` — ${f.error}`).join('\n').slice(0, 1000),
      inline: false,
    });
  }

  return embed;
}