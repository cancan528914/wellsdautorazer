/**
 * /guardsetup - Guard kurulum sihirbazı (sadece Guard yöneticileri).
 * - Log kanalı yoksa oluşturur (varsa devralır, whitelist asla silinmez).
 * - Bot permissionları + Audit Log + sistem health raporlar.
 * - Guard'ı bu sunucuda aktif eder. Kullanım config loguna yazılır.
 */
const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { getGuardSettings, saveGuardSettings, listWhitelist } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { sendConfigLog } = require('../guard/logger');
const { checkHealth } = require('../guard/health');
const { REQUIRED_PERMS } = require('../guard/constants');
const logger = require('../utils/logger');

const GUARD_LOG_NAME = 'guard-log';
const tick = (ok) => (ok ? '🟢' : '🔴');

module.exports = {
  // Guard-yönetici rolü global kapıdan muaf tutulur (yetki canManageGuard ile denetlenir).
  openToGuardManagers: true,
  data: new SlashCommandBuilder().setName('guardsetup').setDescription('Guard sistemini kurar ve sağlığını raporlar.'),

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
          logState = 'korundu';
        }
      }
      if (!logChannel && typeof guild.channels.cache?.find === 'function') {
        const byName = guild.channels.cache.find((c) => c.name === GUARD_LOG_NAME && c.type === ChannelType.GuildText) || null;
        if (byName) {
          logChannel = byName;
          logState = 'devralındı';
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
            topic: 'Javrex Bot System Guard kayıtları (otomatik kurulum)'.slice(0, 1024),
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
          logState = 'oluşturuldu';
        } catch (err) {
          logger.error('Guard log kanalı oluşturulamadı.', err);
          return interaction.editReply({ embeds: [buildErrorEmbed('Log kanalı oluşturulamadı — bot yetkilerini kontrol edin.')] });
        }
      }
      saveGuardSettings(guild.id, { logChannelId: logChannel.id, enabled: true });

      // 4. Sistem health
      const health = await checkHealth(interaction.client, guild).catch(() => ({ ok: false, checks: [] }));
      const healthLine = (health.checks || [])
        .map((c) => `${tick(c.ok)} ${c.label}`)
        .join('\n')
        .slice(0, 1000);

      const wlCount = listWhitelist(guild.id).length;
      const embed = new EmbedBuilder()
        .setColor(config.colors?.guardConfig ?? 0x3498db)
        .setTitle('🛡️ GUARD SYSTEM SETUP')
        .addFields(
          { name: 'System', value: `${tick(!missing.length && auditOk)} ${missing.length || !auditOk ? 'EKSİKLERLE ONLINE' : 'ONLINE'}`, inline: false },
          { name: 'Audit Log', value: auditOk ? `${tick(true)} READY` : `${tick(false)} ERİŞİLEMİYOR`, inline: true },
          { name: 'Logging', value: `${tick(true)} ENABLED (<#${logChannel.id}>)`, inline: true },
          {
            name: 'Protection',
            value: `${tick(true)} ROLE\n${tick(true)} CHANNEL\n${tick(true)} BAN/KICK\n${tick(true)} URL`,
            inline: true,
          },
          { name: 'Rollback', value: `${tick(true)} ENABLED`, inline: true },
          { name: 'Whitelist', value: `${wlCount} USERS (korundu)`, inline: false },
          { name: 'Bot Permissions', value: missing.length ? `🔴 EKSİK:\n${missing.map((m) => `• ${m}`).join('\n').slice(0, 800)}` : `${tick(true)} OK`, inline: false },
          { name: '🩺 Health', value: healthLine || 'ölçülemedi', inline: false },
        )
        .setFooter({ text: `${config.botName} | Guard` })
        .setTimestamp();

      await sendConfigLog(guild, {
        executor: interaction.user,
        action: '/guardsetup',
        target: `<#${logChannel.id}>`,
        detail: `Kurulum tamamlandı (whitelist: ${wlCount})`,
        resultOk: true,
      }).catch(() => {});

      logger.success(`Guard setup tamam: ${guild.name} (log: #${logChannel.name || logChannel.id})`);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction failed: /guardsetup.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Kurulum sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
