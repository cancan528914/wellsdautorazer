/**
 * /setup iş mantığı: botun ihtiyaç duyduğu log kanallarını kurar.
 * - Idempotent: kayıtlı kanal geçerliyse dokunmaz, aynı isimde kanal varsa devralır.
 * - Kanal oluşturunca .env'i günceller (yedekli) + çalışan config'i anında yeniler (restart gerekmez).
 */
const path = require('path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { backupEnvFile, upsertEnvKey } = require('../utils/envConfig');

const SNOWFLAKE = /^\d{17,20}$/;
const LOG_CHANNEL_NAME = 'ticket-log';

function defaultEnvPath() {
  return path.resolve(process.cwd(), '.env');
}

async function runSetup(guild, { envPath } = {}) {
  const envFile = envPath || defaultEnvPath();

  // 1. Bot yetkisi (kanal açmak için şart)
  const me = guild?.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return { ok: false, reason: 'bot-permission' };
  }

  // 2. Salt-okunur durum kontrolleri (kurulum raporu için)
  const checks = [];
  const staffRole = config.ticket.staffRoleId
    ? await guild.roles.fetch(config.ticket.staffRoleId).catch(() => null)
    : null;
  checks.push({
    key: 'staff',
    label: 'Destek Rolü',
    ok: !!staffRole,
    detail: staffRole
      ? `<@&${staffRole.id}>`
      : config.ticket.staffRoleId
        ? 'Rol bulunamadı (ID hatalı olabilir)'
        : 'Ayarlı değil (TICKET_STAFF_ROLE_ID)',
  });

  let parent = null;
  if (config.ticket.categoryId) {
    const cat = await guild.channels.fetch(config.ticket.categoryId).catch(() => null);
    if (cat && cat.type === ChannelType.GuildCategory) parent = cat;
  }
  checks.push({
    key: 'category',
    label: 'Ticket Kategorisi',
    ok: !!parent,
    detail: parent
      ? `${parent.name}`
      : config.ticket.categoryId
        ? 'Kategori bulunamadı (ID hatalı olabilir)'
        : 'Ayarlı değil (TICKET_CATEGORY_ID)',
  });

  if (config.ticket.panelChannelId) {
    const pch = await guild.channels.fetch(config.ticket.panelChannelId).catch(() => null);
    checks.push({
      key: 'panel',
      label: 'Panel Kanalı',
      ok: !!pch?.isTextBased?.(),
      detail: pch ? `<#${pch.id}>` : 'Kanal bulunamadı (ID hatalı olabilir)',
    });
  } else {
    checks.push({ key: 'panel', label: 'Panel Kanalı', ok: true, detail: 'Otomatik (komutun kullanıldığı kanal)' });
  }

  // 3. Log kanalı: kayıtlı → isimden devral → oluştur
  let logChannel = null;
  let created = false;
  let adopted = false;

  if (config.ticket.logChannelId && SNOWFLAKE.test(config.ticket.logChannelId)) {
    const existing = await guild.channels.fetch(config.ticket.logChannelId).catch(() => null);
    if (existing?.isTextBased?.()) logChannel = existing;
    else logger.warn(`Kayıtlı log kanalı bulunamadı: ${config.ticket.logChannelId} (yenisi kurulacak)`);
  }

  if (!logChannel && typeof guild.channels.cache?.find === 'function') {
    const byName =
      guild.channels.cache.find((c) => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText) || null;
    if (byName) {
      logChannel = byName;
      adopted = true;
    }
  }

  if (!logChannel) {
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
    if (staffRole) {
      overwrites.push({
        id: staffRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }
    overwrites.push({
      id: guild.client?.user?.id || me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });

    try {
      logChannel = await guild.channels.create({
        name: LOG_CHANNEL_NAME,
        type: ChannelType.GuildText,
        ...(parent ? { parent: parent.id } : {}),
        topic: 'WELLSD AUTORAZER ticket kayıtları (otomatik kurulum)'.slice(0, 1024),
        permissionOverwrites: overwrites,
      });
      created = true;
    } catch (err) {
      logger.error('Setup: log kanalı oluşturulamadı.', err);
      return { ok: false, reason: 'create-failed', checks };
    }
  }

  // 4. Kalıcılaştır: .env (yedekli) + çalışan config (restartsız)
  let envUpdated = false;
  try {
    if (SNOWFLAKE.test(logChannel.id)) {
      backupEnvFile(envFile);
      upsertEnvKey(envFile, 'TICKET_LOG_CHANNEL_ID', logChannel.id);
      config.ticket.logChannelId = logChannel.id;
      process.env.TICKET_LOG_CHANNEL_ID = logChannel.id;
      envUpdated = true;
    }
  } catch (err) {
    logger.error('Setup: .env güncellenemedi (kanal kuruldu, ID elle yazılmalı).', err);
  }

  logger.success(`Setup tamam: log kanalı <#${logChannel.id}> (yeni: ${created}, devralınan: ${adopted})`);
  return { ok: true, logChannelId: logChannel.id, created, adopted, envUpdated, checks };
}

module.exports = { runSetup, LOG_CHANNEL_NAME, defaultEnvPath };
