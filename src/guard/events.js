/**
 * Discord event → Guard aksiyon eşleşmesi.
 * Her fonksiyon kendi hatasını yutar (Guard asla crash etmez, diğer sistemleri engellemez).
 */
const { AuditLogEvent, ChannelType } = require('discord.js');
const logger = require('../utils/logger');
const { handleGuardEvent } = require('./manager');
const { findExecutor } = require('./audit');
const {
  rollbackRoleCreate,
  rollbackRoleDelete,
  rollbackRoleUpdate,
  rollbackMemberRoles,
  rollbackChannelCreate,
  rollbackChannelDelete,
  rollbackChannelUpdate,
  rollbackBan,
  rollbackUnban,
  rollbackTimeout,
  rollbackWebhook,
  rollbackGuild,
} = require('./rollback');
const { getGuardSettings } = require('../database/database');

/** Botun kritik rollerinden biri mi hedefte? (guard-yönetici rolleri + botun en üst rolü) */
function isSensitiveTarget(guild, roleIds) {
  try {
    const ids = new Set((roleIds || []).map(String));
    if (!ids.size || !guild) return false;
    const cfg = require('../config');
    for (const id of cfg.guardManagerRoleIds || []) {
      if (ids.has(String(id))) return true;
    }
    const top = guild.members?.me?.roles?.highest;
    if (top && ids.has(String(top.id))) return true;
    return false;
  } catch {
    return false;
  }
}

/** Kanal guard log kanalı mı? (silinirse auto-heal, bozulursa izin onarımı) */
function isLogChannel(guild, channelId) {
  try {
    if (!guild || !channelId) return false;
    const settings = getGuardSettings(guild.id);
    return !!settings?.log_channel_id && String(settings.log_channel_id) === String(channelId);
  } catch {
    return false;
  }
}

async function fixLogChannelPerms(guild, channel) {
  try {
    const me = guild.members?.me;
    if (!me) return;
    await channel.permissionOverwrites
      .set([
        { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
        { id: me.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks'] },
      ])
      .catch(() => null);
    logger.warn(`Guard log kanalı izinleri onarıldı: #${channel.name || channel.id}`);
  } catch {
    /* best effort */
  }
}

const GUILD_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function channelLabel(ch) {
  if (!ch) return '—';
  if (ch.type === ChannelType.GuildCategory) return `📁 ${ch.name || ch.id}`;
  return `#${ch.name || ch.id}`;
}

async function onRoleCreate(client, role) {
  try {
    if (!role?.guild) return;
    await handleGuardEvent({
      client,
      guild: role.guild,
      action: 'ROLE_CREATE',
      targetId: role.id,
      targetDesc: `Rol: ${role.name || role.id}`,
      doRollback: () => rollbackRoleCreate(role.guild, role),
    });
  } catch (err) {
    logger.error('Guard onRoleCreate failed.', err);
  }
}

async function onRoleDelete(client, role) {
  try {
    if (!role?.guild) return;
    const snap = {
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissionsBitfield: role.permissions?.bitfield,
      position: role.rawPosition ?? role.position,
    };
    await handleGuardEvent({
      client,
      guild: role.guild,
      action: 'ROLE_DELETE',
      targetId: role.id,
      targetDesc: `Rol: ${role.name || role.id}`,
      sensitive: isSensitiveTarget(role.guild, [role.id]),
      doRollback: () => rollbackRoleDelete(role.guild, snap),
    });
  } catch (err) {
    logger.error('Guard onRoleDelete failed.', err);
  }
}

async function onRoleUpdate(client, oldRole, newRole) {
  try {
    if (!newRole?.guild) return;
    const snap = {
      name: oldRole.name,
      color: oldRole.color,
      hoist: oldRole.hoist,
      mentionable: oldRole.mentionable,
      permissionsBitfield: oldRole.permissions?.bitfield,
    };
    await handleGuardEvent({
      client,
      guild: newRole.guild,
      action: 'ROLE_UPDATE',
      targetId: newRole.id,
      targetDesc: `Rol: ${newRole.name || newRole.id}`,
      sensitive: isSensitiveTarget(newRole.guild, [newRole.id]),
      doRollback: () => rollbackRoleUpdate(newRole.guild, snap, newRole),
    });
  } catch (err) {
    logger.error('Guard onRoleUpdate failed.', err);
  }
}

function roleIds(cache) {
  try {
    return new Set([...(cache?.keys?.() || [])].map(String));
  } catch {
    return new Set();
  }
}

async function onGuildMemberUpdate(client, oldMember, newMember) {
  try {
    if (!newMember?.guild) return;
    const before = roleIds(oldMember?.roles?.cache);
    const after = roleIds(newMember?.roles?.cache);
    const rolesChanged = !(before.size === after.size && [...before].every((id) => after.has(id)));
    // Timeout değişimi (MemberUpdate audit'i; rollerden bağımsız da tetiklenebilir)
    const oldTs = oldMember?.communicationDisabledUntilTimestamp || 0;
    const newTs = newMember?.communicationDisabledUntilTimestamp || 0;
    const now = Date.now();
    const timeoutApplied = newTs > now && oldTs !== newTs;
    const timeoutLifted = !newTs && oldTs > now;
    if (!rolesChanged && !timeoutApplied && !timeoutLifted) return;
    if (timeoutApplied || timeoutLifted) {
      await handleGuardEvent({
        client,
        guild: newMember.guild,
        action: 'MEMBER_TIMEOUT',
        targetId: newMember.id,
        targetDesc: `Üye: ${newMember.user?.tag || newMember.id} (${timeoutApplied ? 'susturma' : 'susturma kaldırma'})`,
        doRollback: () => rollbackTimeout(newMember.guild, newMember, { applied: timeoutApplied, untilMs: timeoutApplied ? newTs : oldTs }),
      });
      if (!rolesChanged) return;
    }
    if (!rolesChanged) return;
    const changedIds = [...after].filter((id) => !before.has(id)).concat([...before].filter((id) => !after.has(id)));
    await handleGuardEvent({
      client,
      guild: newMember.guild,
      action: 'MEMBER_ROLE_UPDATE',
      targetId: newMember.id,
      targetDesc: `Üye: ${newMember.user?.tag || newMember.id}`,
      sensitive: isSensitiveTarget(newMember.guild, changedIds),
      doRollback: (ctx) => rollbackMemberRoles(newMember.guild, newMember, ctx?.entry),
    });
  } catch (err) {
    logger.error('Guard onGuildMemberUpdate failed.', err);
  }
}

async function onChannelCreate(client, channel) {
  try {
    if (!channel?.guild || !GUILD_CHANNEL_TYPES.has(channel.type)) return;
    await handleGuardEvent({
      client,
      guild: channel.guild,
      action: 'CHANNEL_CREATE',
      targetId: channel.id,
      targetDesc: channelLabel(channel),
      doRollback: () => rollbackChannelCreate(channel.guild, channel),
    });
  } catch (err) {
    logger.error('Guard onChannelCreate failed.', err);
  }
}

async function onChannelDelete(client, channel) {
  try {
    if (!channel?.guild || !GUILD_CHANNEL_TYPES.has(channel.type)) return;
    const snap = {
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      topic: channel.topic,
      nsfw: channel.nsfw,
      rateLimitPerUser: channel.rateLimitPerUser,
      bitrate: channel.bitrate,
      userLimit: channel.userLimit,
      position: channel.rawPosition ?? channel.position,
      permissionOverwrites: channel.permissionOverwrites,
    };
    await handleGuardEvent({
      client,
      guild: channel.guild,
      action: 'CHANNEL_DELETE',
      targetId: channel.id,
      targetDesc: channelLabel(channel),
      doRollback: () => rollbackChannelDelete(channel.guild, snap),
    });
  } catch (err) {
    logger.error('Guard onChannelDelete failed.', err);
  }
}

async function onChannelUpdate(client, oldChannel, newChannel) {
  try {
    if (!newChannel?.guild || !GUILD_CHANNEL_TYPES.has(newChannel.type)) return;
    // Log kanalı bozulduysa izinleri onar (normal Guard akışı aynen devam eder)
    if (isLogChannel(newChannel.guild, newChannel.id)) {
      await fixLogChannelPerms(newChannel.guild, newChannel);
    }
    // Önce düz kanal düzenlemesi dene; overwrite değişimleri ayrı audit tipindedir
    const probes = [
      AuditLogEvent.ChannelUpdate,
      AuditLogEvent.ChannelOverwriteCreate,
      AuditLogEvent.ChannelOverwriteUpdate,
      AuditLogEvent.ChannelOverwriteDelete,
    ];
    const actionByAudit = {
      [AuditLogEvent.ChannelUpdate]: 'CHANNEL_UPDATE',
      [AuditLogEvent.ChannelOverwriteCreate]: 'CHANNEL_OVERWRITE_CREATE',
      [AuditLogEvent.ChannelOverwriteUpdate]: 'CHANNEL_OVERWRITE_UPDATE',
      [AuditLogEvent.ChannelOverwriteDelete]: 'CHANNEL_OVERWRITE_DELETE',
    };
    let matched = null;
    for (const auditType of probes) {
      const found = await findExecutor(newChannel.guild, auditType, newChannel.id, { attempts: 2 });
      if (found) {
        matched = { auditType, ...found };
        break;
      }
    }
    if (!matched) {
      // Hiçbir audit eşleşmedi → manager zaten unresolved loglar; yine de tek çağrı yap
      await handleGuardEvent({
        client,
        guild: newChannel.guild,
        action: 'CHANNEL_UPDATE',
        targetId: newChannel.id,
        targetDesc: channelLabel(newChannel),
        doRollback: () => rollbackChannelUpdate(newChannel.guild, oldChannel, newChannel),
      });
      return;
    }
    // Eşleşen audit tipine göre aksiyon; rollback yalnızca düz update için
    const action = actionByAudit[matched.auditType] || 'CHANNEL_UPDATE';
    await handleGuardEvent({
      client,
      guild: newChannel.guild,
      action,
      targetId: newChannel.id,
      targetDesc: channelLabel(newChannel),
      resolved: { executor: matched.executor, entry: matched.entry },
      doRollback:
        action === 'CHANNEL_UPDATE' ? () => rollbackChannelUpdate(newChannel.guild, oldChannel, newChannel) : null,
    });
  } catch (err) {
    logger.error('Guard onChannelUpdate failed.', err);
  }
}

async function onGuildBanAdd(client, ban) {
  try {
    const guild = ban?.guild;
    const user = ban?.user;
    if (!guild || !user) return;
    await handleGuardEvent({
      client,
      guild,
      action: 'MEMBER_BAN_ADD',
      targetId: user.id,
      targetDesc: `Üye: ${user.tag || user.id}`,
      doRollback: () => rollbackBan(guild, user.id),
    });
  } catch (err) {
    logger.error('Guard onGuildBanAdd failed.', err);
  }
}

async function onGuildBanRemove(client, ban) {
  try {
    const guild = ban?.guild;
    const user = ban?.user;
    if (!guild || !user) return;
    await handleGuardEvent({
      client,
      guild,
      action: 'MEMBER_BAN_REMOVE',
      targetId: user.id,
      targetDesc: `Üye: ${user.tag || user.id}`,
      doRollback: () => rollbackUnban(guild, user.id),
    });
  } catch (err) {
    logger.error('Guard onGuildBanRemove failed.', err);
  }
}

async function onGuildMemberRemove(client, member) {
  try {
    const guild = member?.guild;
    if (!guild || !member?.user) return;
    // Kick mi normal ayrılma mı? Kısa audit yoklaması (quit logunu geciktirmemek için 2 deneme)
    const found = await findExecutor(guild, AuditLogEvent.MemberKick, member.user.id, { attempts: 2 }).catch(() => null);
    if (!found) return; // normal ayrılma — quit sistemi kendi logunu basar
    await handleGuardEvent({
      client,
      guild,
      action: 'MEMBER_KICK',
      targetId: member.user.id,
      targetDesc: `Üye: ${member.user.tag || member.user.id}`,
      doRollback: null, // kick geri alınamaz
      resolved: found,
    });
  } catch (err) {
    logger.error('Guard onGuildMemberRemove failed.', err);
  }
}

async function onWebhookUpdate(client, channel) {
  try {
    if (!channel?.guild) return;
    const types = [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate];
    let best = null;
    for (const t of types) {
      try {
        const logs = await channel.guild.fetchAuditLogs({ type: t, limit: 3 }).catch(() => null);
        for (const e of logs?.entries?.values?.() || []) {
          if (Date.now() - e.createdTimestamp < 20000 && (!best || e.createdTimestamp > best.entry.createdTimestamp)) {
            best = { type: t, entry: e };
          }
        }
      } catch {
        /* tek tip hatası diğerlerini engellemez */
      }
    }
    if (!best?.entry?.executor) return;
    const action =
      best.type === AuditLogEvent.WebhookCreate
        ? 'WEBHOOK_CREATE'
        : best.type === AuditLogEvent.WebhookDelete
          ? 'WEBHOOK_DELETE'
          : 'WEBHOOK_UPDATE';
    await handleGuardEvent({
      client,
      guild: channel.guild,
      action,
      targetId: best.entry.target?.id || channel.id,
      targetDesc: `#${channel.name || channel.id} (webhook)`,
      doRollback: () => rollbackWebhook(channel.guild, channel),
    });
  } catch (err) {
    logger.error('Guard onWebhookUpdate failed.', err);
  }
}

async function onGuildUpdate(client, oldGuild, newGuild) {
  try {
    if (!newGuild) return;
    await handleGuardEvent({
      client,
      guild: newGuild,
      action: 'GUILD_UPDATE',
      targetId: newGuild.id,
      targetDesc: `Sunucu: ${newGuild.name || newGuild.id}`,
      doRollback: () => rollbackGuild(newGuild, oldGuild || {}),
    });
  } catch (err) {
    logger.error('Guard onGuildUpdate failed.', err);
  }
}

// ---------- Emoji / Sticker / Thread (GUILD kategorisi: yalnızca URL Guard muaf) ----------
// Rollback mümkün değildir (görsel/veri geri yüklenemez) → tespit + ceza + açık log.

async function onEmojiCreate(client, emoji) {
  try {
    if (!emoji?.guild) return;
    await handleGuardEvent({
      client,
      guild: emoji.guild,
      action: 'EMOJI_CREATE',
      targetId: emoji.id,
      targetDesc: `Emoji: ${emoji.name || emoji.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Emoji geri yüklenemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onEmojiCreate failed.', err);
  }
}

async function onEmojiUpdate(client, oldEmoji, newEmoji) {
  try {
    if (!newEmoji?.guild) return;
    await handleGuardEvent({
      client,
      guild: newEmoji.guild,
      action: 'EMOJI_UPDATE',
      targetId: newEmoji.id,
      targetDesc: `Emoji: ${newEmoji.name || newEmoji.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Emoji eski haline döndürülemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onEmojiUpdate failed.', err);
  }
}

async function onEmojiDelete(client, emoji) {
  try {
    if (!emoji?.guild) return;
    await handleGuardEvent({
      client,
      guild: emoji.guild,
      action: 'EMOJI_DELETE',
      targetId: emoji.id,
      targetDesc: `Emoji: ${emoji.name || emoji.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Silinen emoji geri yüklenemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onEmojiDelete failed.', err);
  }
}

function stickerGuild(client, sticker) {
  try {
    const gid = sticker?.guildId || sticker?.guild?.id;
    return (gid && client?.guilds?.cache?.get(gid)) || null;
  } catch {
    return null;
  }
}

async function onStickerCreate(client, sticker) {
  try {
    const guild = stickerGuild(client, sticker);
    if (!guild || !sticker?.id) return;
    await handleGuardEvent({
      client,
      guild,
      action: 'STICKER_CREATE',
      targetId: sticker.id,
      targetDesc: `Sticker: ${sticker.name || sticker.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Sticker geri yüklenemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onStickerCreate failed.', err);
  }
}

async function onStickerUpdate(client, oldSticker, newSticker) {
  try {
    const guild = stickerGuild(client, newSticker);
    if (!guild || !newSticker?.id) return;
    await handleGuardEvent({
      client,
      guild,
      action: 'STICKER_UPDATE',
      targetId: newSticker.id,
      targetDesc: `Sticker: ${newSticker.name || newSticker.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Sticker eski haline döndürülemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onStickerUpdate failed.', err);
  }
}

async function onStickerDelete(client, sticker) {
  try {
    const guild = stickerGuild(client, sticker);
    if (!guild || !sticker?.id) return;
    await handleGuardEvent({
      client,
      guild,
      action: 'STICKER_DELETE',
      targetId: sticker.id,
      targetDesc: `Sticker: ${sticker.name || sticker.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Silinen sticker geri yüklenemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onStickerDelete failed.', err);
  }
}

async function onThreadCreate(client, thread) {
  try {
    if (!thread?.guild) return;
    await handleGuardEvent({
      client,
      guild: thread.guild,
      action: 'THREAD_CREATE',
      targetId: thread.id,
      targetDesc: `Konu: ${thread.name || thread.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Thread silinmesi riskli olabilir (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onThreadCreate failed.', err);
  }
}

async function onThreadDelete(client, thread) {
  try {
    if (!thread?.guild) return;
    await handleGuardEvent({
      client,
      guild: thread.guild,
      action: 'THREAD_DELETE',
      targetId: thread.id,
      targetDesc: `Konu: ${thread.name || thread.id}`,
      doRollback: () => Promise.resolve({ ok: false, detail: 'Silinen thread geri yüklenemez (manuel inceleme).' }),
    });
  } catch (err) {
    logger.error('Guard onThreadDelete failed.', err);
  }
}

module.exports = {
  onRoleCreate,
  onRoleDelete,
  onRoleUpdate,
  onGuildMemberUpdate,
  onChannelCreate,
  onChannelDelete,
  onChannelUpdate,
  onGuildBanAdd,
  onGuildBanRemove,
  onGuildMemberRemove,
  onWebhookUpdate,
  onGuildUpdate,
  onEmojiCreate,
  onEmojiUpdate,
  onEmojiDelete,
  onStickerCreate,
  onStickerUpdate,
  onStickerDelete,
  onThreadCreate,
  onThreadDelete,
};
