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
  rollbackWebhook,
  rollbackGuild,
} = require('./rollback');

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
    if (before.size === after.size && [...before].every((id) => after.has(id))) return; // rol değişimi yok
    await handleGuardEvent({
      client,
      guild: newMember.guild,
      action: 'MEMBER_ROLE_UPDATE',
      targetId: newMember.id,
      targetDesc: `Üye: ${newMember.user?.tag || newMember.id}`,
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
      doRollback: null, // unban geri alınmaz (manuel inceleme)
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
};
