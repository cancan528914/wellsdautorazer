/**
 * Guard log gönderici: ban / threat / unverified / allowed / config / panel-access.
 * Renkler merkezi config temasından gelir (guardBan/Warn/Allowed/Config/Panel).
 * Log kanalı yoksa OTOMATİK yeniden oluşturulur (log-kanal koruması).
 */
const { EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { getGuardSettings, saveGuardSettings } = require('../database/database');
const { LOGCHANNEL_CACHE_TTL_MS } = require('./constants');

const LOG_CHANNEL_NAME = 'guard-log';

// guildId -> { ts, id, channel } — her ihlalde 1 GET kazanır
const channelCache = new Map();

const trDate = () => new Date().toLocaleString('tr-TR', { hour12: false });

const C = () => ({
  ban: config.colors?.guardBan ?? 0xe74c3c,
  warn: config.colors?.guardWarn ?? 0xe67e22,
  allowed: config.colors?.guardAllowed ?? 0x2ecc71,
  config: config.colors?.guardConfig ?? 0x3498db,
  panel: config.colors?.guardPanel ?? 0x9b59b6,
  grey: 0x95a5a6,
});

function baseEmbed(color) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `${config.botName} | Guard` })
    .setTimestamp();
}

function userLabel(executor) {
  if (!executor) return { mention: '`bilinmiyor`', tag: 'Bilinmeyen', id: '—' };
  const id = String(executor.id || executor.user_id || '—');
  return { mention: `<@${id}>`, tag: executor.tag || 'Bilinmeyen', id };
}

/** Kayıtlı kanal yoksa/silinmişse yeniden oluşturur (ayar korunur). */
async function ensureLogChannel(guild) {
  try {
    const settings = getGuardSettings(guild.id);
    if (settings?.log_channel_id) {
      const existing = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
      if (existing?.isTextBased()) return existing;
      logger.warn(`Guard log kanalı silinmiş (${settings.log_channel_id}), yeniden oluşturuluyor.`);
    }
    const me = guild.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      logger.warn('Guard log kanalı oluşturulamadı: Kanalları Yönet yetkisi yok.');
      return null;
    }
    const created = await guild.channels.create({
      name: LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Javrex Bot System Guard kayıtları (otomatik kurtarma)'.slice(0, 1024),
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
    saveGuardSettings(guild.id, { logChannelId: created.id, enabled: settings?.enabled ?? true });
    channelCache.set(guild.id, { ts: Date.now(), id: created.id, channel: created });
    logger.success(`Guard log kanalı kurtarıldı: #${created.name}`);
    return created;
  } catch (err) {
    logger.error('Guard log kanalı kurtarılamadı.', err);
    return null;
  }
}

async function getLogChannel(guild) {
  try {
    const settings = getGuardSettings(guild.id);
    const id = settings?.log_channel_id;
    if (!id) {
      logger.warn('Guard log kanalı ayarlı değil (/guardsetup gerekli).');
      return null;
    }
    const hit = channelCache.get(guild.id);
    if (hit && hit.id === id && Date.now() - hit.ts < LOGCHANNEL_CACHE_TTL_MS) return hit.channel;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch?.isTextBased()) {
      channelCache.set(guild.id, { ts: Date.now(), id, channel: ch });
      return ch;
    }
    // Silinmiş → otomatik kurtar
    channelCache.delete(guild.id);
    return ensureLogChannel(guild);
  } catch (err) {
    logger.error('Guard log kanalı çözülemedi.', err);
    return null;
  }
}

/** §23 formatı: ban öncesi yakalanan snapshot kullanılır. */
async function sendBanLog(guild, { executor, actionLabel, guardLabel, targetDesc, punishment, rollback, sensitive = false, incident = null }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const u = userLabel(executor);
  const punished = punishment?.ok;
  const embed = baseEmbed(punished ? C().ban : C().warn)
    .setTitle(punished ? '🛡️ GUARD — USER BANNED' : '🛡️ GUARD — THREAT DETECTED')
    .addFields(
      { name: 'Executor', value: u.mention, inline: true },
      { name: 'Executor ID', value: `\`${u.id}\``, inline: true },
      { name: 'Action', value: String(actionLabel || '—').slice(0, 200), inline: false },
      { name: 'Target', value: String(targetDesc || '—').slice(0, 200), inline: false },
      { name: 'Triggered Protection', value: String(guardLabel || '—').slice(0, 100), inline: true },
      {
        name: 'Punishment',
        value: punished ? '🔨 BANNED' : `❌ Ban başarısız\nSebep: ${punishment?.detail || 'bilinmiyor'}`,
        inline: true,
      },
      {
        name: 'Rollback',
        value: !rollback
          ? 'Uygulanmadı'
          : rollback.ok
            ? `✅ SUCCESS\n${rollback.detail}`
            : `❌ Başarısız\nSebep: ${rollback.detail}`,
        inline: false,
      },
      { name: 'Time', value: trDate(), inline: false },
    );
  if (sensitive) {
    embed.addFields({ name: '🛡️ Hassas Hedef', value: 'Botun kritik rollerinden biri hedef alındı.', inline: false });
  }
  if (incident) {
    embed.addFields({ name: '🔗 Incident', value: String(incident).slice(0, 500), inline: false });
  }
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard ban logu gönderilemedi.', err);
    return false;
  }
}

/** §25: eşleşme belirsizse ceza YOK, açık log var. */
async function sendUnresolvedLog(guild, { actionLabel, targetDesc, reason }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const embed = baseEmbed(C().warn)
    .setTitle('⚠️ GUARD — UNVERIFIED ACTION')
    .setDescription('Audit Log güvenilir şekilde eşleşmedi. Ceza uygulanmadı.')
    .addFields(
      { name: 'Action', value: String(actionLabel || '—').slice(0, 200), inline: true },
      { name: 'Target', value: String(targetDesc || '—').slice(0, 200), inline: true },
      { name: 'Reason', value: String(reason || 'Audit Log executor doğrulanamadı.').slice(0, 500), inline: false },
      { name: 'Result', value: '⚠️ NO PUNISHMENT', inline: false },
      { name: 'Time', value: trDate(), inline: false },
    );
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard unresolved logu gönderilemedi.', err);
    return false;
  }
}

/** §14: URL Guard izinli işlemi — internal kayıt (ban logu DEĞİL). */
async function sendAllowedLog(guild, { executor, levelLabel, actionLabel, targetDesc }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const u = userLabel(executor);
  const embed = baseEmbed(C().allowed)
    .setTitle('🛡️ GUARDED ACTION')
    .addFields(
      { name: 'Executor', value: u.mention, inline: true },
      { name: 'Level', value: String(levelLabel || '—').slice(0, 100), inline: true },
      { name: 'Action', value: String(actionLabel || '—').slice(0, 200), inline: false },
      { name: 'Target', value: String(targetDesc || '—').slice(0, 200), inline: false },
      { name: 'Result', value: '✅ ALLOWED', inline: false },
      { name: 'Time', value: trDate(), inline: false },
    );
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard allowed logu gönderilemedi.', err);
    return false;
  }
}

/** §20: yönetim komutu kullanımı (saldırı loglarından ayrı). */
async function sendConfigLog(guild, { executor, action, target, detail, resultOk = true }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const u = userLabel(executor);
  const embed = baseEmbed(C().config)
    .setTitle('⚙️ GUARD CONFIG ACTION')
    .addFields(
      { name: 'Executor', value: u.mention, inline: true },
      { name: 'Action', value: String(action || '—').slice(0, 100), inline: true },
      { name: 'Target', value: target ? String(target).slice(0, 200) : '—', inline: false },
      { name: 'Detail', value: String(detail || '—').slice(0, 500), inline: false },
      { name: 'Result', value: resultOk ? '✅ Success' : '❌ Failed', inline: true },
      { name: 'Time', value: trDate(), inline: false },
    );
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard config logu gönderilemedi.', err);
    return false;
  }
}

/** §19: liste görüntüleme kaydı (ihlâl DEĞİL) — komut log formatına yönlenir. */
async function sendListViewLog(guild, { viewer, count }) {
  return sendCommandLog(guild, {
    user: viewer,
    command: '/guardliste',
    target: null,
    detail: `${Number(count) || 0} Guard kullanıcısı listelendi.`,
  });
}

/**
 * Guard yönetim komutu kullanımı — saldırı incident'larından BAĞIMSIZ tek log (§5, §10).
 * target: mention metni (örn. `<@id>`) veya düz metin; detail: seviye/bilgi.
 */
async function sendCommandLog(guild, { user, command, target = null, detail = null }) {
  const ch = await getLogChannel(guild);
  if (!ch) return false;
  const u = userLabel(user);
  const embed = baseEmbed(C().config)
    .setTitle('🛡️ GUARD KOMUTU KULLANILDI')
    .addFields(
      { name: '👤 Kullanan', value: `${u.mention}\nID: \`${u.id}\``, inline: false },
      { name: '⚙️ Komut', value: `\`${String(command || '—').slice(0, 50)}\``, inline: false },
    );
  if (target) embed.addFields({ name: '🎯 Hedef', value: String(target).slice(0, 200), inline: false });
  if (detail) embed.addFields({ name: '🛡️ Bilgi', value: String(detail).slice(0, 500), inline: false });
  embed.addFields({ name: '🕒 Zaman', value: trDate(), inline: false });
  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.error('Guard komut logu gönderilemedi.', err);
    return false;
  }
}

module.exports = {
  getLogChannel,
  ensureLogChannel,
  sendBanLog,
  sendUnresolvedLog,
  sendAllowedLog,
  sendConfigLog,
  sendListViewLog,
  sendCommandLog,
  _channelCache: channelCache,
};
