/**
 * /guardsetup - Guard kurulum sihirbazı (sadece adminler).
 * - Log kanalı yoksa oluşturur (varsa devralır, whitelist asla silinmez).
 * - Bot permissionlarını + Audit Log erişimini raporlar.
 * - Guard'ı bu sunucuda aktif eder.
 */
const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { getGuardSettings, saveGuardSettings, listWhitelist } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { REQUIRED_PERMS } = require('../guard/constants');
const logger = require('../utils/logger');

const GUARD_LOG_NAME = 'guard-log';

module.exports = {
  data: new SlashCommandBuilder().setName('guardsetup').setDescription('Guard sistemini kurar (sadece adminler).'),

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

      // 1. Bot permission raporu
      const missing = [];
      for (const p of REQUIRED_PERMS) {
        try {
          if (!me?.permissions?.has(p.flag)) missing.push(p.label);
        } catch {
          missing.push(p.label);
        }
      }

      // 2. Audit Log erişim testi
      let auditOk = false;
      try {
        await guild.fetchAuditLogs({ limit: 1 });
        auditOk = true;
      } catch (err) {
        logger.warn(`Guard audit probe başarısız: ${err.code || err.message}`);
      }

      // 3. Log kanalı: kayıtlı → isimden devral → oluştur (whitelist'e dokunulmaz)
      let logChannel = null;
      let logState = '';
      const settings = getGuardSettings(guild.id);
      if (settings?.log_channel_id) {
        const existing = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
        if (existing?.isTextBased()) {
          logChannel = existing;
          logState = '♻️ Mevcut kanal korundu';
        }
      }
      if (!logChannel && typeof guild.channels.cache?.find === 'function') {
        const byName = guild.channels.cache.find((c) => c.name === GUARD_LOG_NAME && c.type === ChannelType.GuildText) || null;
        if (byName) {
          logChannel = byName;
          logState = '♻️ Mevcut kanal devralındı';
        }
      }
      if (!logChannel) {
        if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.editReply({
            embeds: [buildErrorEmbed('Log kanalı oluşturamıyorum — bota **Kanalları Yönet** yetkisi verin ve tekrar deneyin.')],
          });
        }
        try {
          logChannel = await guild.channels.create({
            name: GUARD_LOG_NAME,
            type: ChannelType.GuildText,
            topic: 'WELLSD AUTORAZER Guard kayıtları (otomatik kurulum)'.slice(0, 1024),
            permissionOverwrites: [
              { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
              {
                id: me.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.EmbedLinks,
                ],
              },
            ],
          });
          logState = '🆕 Yeni oluşturuldu';
        } catch (err) {
          logger.error('Guard log kanalı oluşturulamadı.', err);
          return interaction.editReply({ embeds: [buildErrorEmbed('Log kanalı oluşturulamadı — bot yetkilerini kontrol edin.')] });
        }
      }
      saveGuardSettings(guild.id, { logChannelId: logChannel.id, enabled: true });

      const wlCount = listWhitelist(guild.id).length;
      const embed = new EmbedBuilder()
        .setColor(missing.length ? 0xe67e22 : 0x2ecc71)
        .setTitle('🛡️ GUARD SETUP')
        .addFields(
          { name: 'Durum', value: '✅ Guard aktif', inline: false },
          { name: 'Log Kanalı', value: `<#${logChannel.id}> (${logState})`, inline: false },
          {
            name: 'Koruma',
            value: '✅ Rol Guard\n✅ Kanal Guard\n✅ Ban/Kick Guard\n✅ URL Guard',
            inline: true,
          },
          { name: 'Audit Log', value: auditOk ? '✅ Aktif' : '❌ Erişilemiyor (Denetim Kaydını Görüntüle yetkisi gerekli)', inline: true },
          { name: 'Whitelist', value: `${wlCount} kullanıcı (korundu)`, inline: false },
        )
        .setFooter({ text: `${config.botName} | Guard` })
        .setTimestamp();
      if (missing.length) {
        embed.addFields({ name: '⚠️ Eksik Bot Yetkileri', value: missing.map((m) => `• ${m}`).join('\n').slice(0, 1000), inline: false });
      }

      logger.success(`Guard setup tamam: ${guild.name} (log: #${logChannel.name || logChannel.id})`);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction failed: /guardsetup.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Kurulum sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
