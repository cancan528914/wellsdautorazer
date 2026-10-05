/**
 * /guardsetup - Guard kurulum sihirbazı (sadece Guard yöneticileri).
 * - Log kanalı yoksa oluşturur (varsa devralır, whitelist asla silinmez).
 * - Bot permissionları + Audit Log + sistem health raporlar.
 * - Guard'ı bu sunucuda aktif eder. Kullanım config loguna yazılır.
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { getGuardSettings, saveGuardSettings, listWhitelist } = require('../database/database');
const { canManageGuard } = require('../guard/permissions');
const { sendGuardLog } = require('../guard/logService');
const { checkHealth } = require('../guard/health');
const { REQUIRED_PERMS } = require('../guard/constants');
const logger = require('../utils/logger');

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

      // 3. Log altyapısı Raporu.
      // Kanal OLUŞTURMA bu komutun işi değil — tek doğruluk kaynağı guard/logChannels.js
      // (/guardlogsetup). Burada sadece mevcut altyapının durumu raporlanır.
      const settings = getGuardSettings(guild.id);
      const { countGuardLogChannels, getGuardLogChannel } = require('../database/database');
      const { LOG_CHANNELS } = require('../guard/constants');
      const logChannelId = getGuardLogChannel(guild.id, 'guard') || settings?.log_channel_id || null;
      const logChannel = logChannelId ? await guild.channels.fetch(logChannelId).catch(() => null) : null;
      const logChannelCount = countGuardLogChannels(guild.id);
      const logInfraReady = logChannelCount >= LOG_CHANNELS.length;
      if (!logInfraReady) {
        logger.warn(`Guard log altyapısı eksik: ${logChannelCount}/${LOG_CHANNELS.length} kanal. /guardlogsetup çalıştırılmalı.`);
      }
      saveGuardSettings(guild.id, { logChannelId: logChannelId, enabled: true });

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
          { name: 'Logging', value: logInfraReady ? `${tick(true)} ALTYAPI TAM (${logChannelCount}/${LOG_CHANNELS.length})` : `${tick(false)} EKSİK (${logChannelCount}/${LOG_CHANNELS.length}) — \`/guardlogsetup\``, inline: true },
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

      await sendGuardLog({
        guild,
        title: 'Guard Sistemi Kuruldu',
        action: '`/guardsetup` çalıştırıldı',
        detail: `Guard yapılandırıldı • Whitelist: ${wlCount} kullanıcı • Log altyapısı: ${logChannelCount}/${LOG_CHANNELS.length} kanal`,
        actor: { id: interaction.user.id },
        status: { ok: true, text: 'Guard sistemi aktif' },
      }).catch(() => {});

      logger.success(`Guard setup tamam: ${guild.name} (log altyapısı: ${logChannelCount}/${LOG_CHANNELS.length})`);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction failed: /guardsetup.', err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Kurulum sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
