/**
 * Rollback: yetkisiz işlemi mümkün olduğunca geri alır.
 * Her fonksiyon { ok, detail } döner; hiçbiri throw etmez.
 * Botun kendi düzeltme işlemleri tracker'a işaretlenir (tekrar Guard'a düşmez).
 */
const { AuditLogEvent, ChannelType } = require('discord.js');
const logger = require('../utils/logger');
const { markBotAction } = require('./tracker');
const { WEBHOOK_RECENT_MS } = require('./constants');

const ok = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

async function rollbackRoleCreate(guild, role) {
  try {
    markBotAction(guild.id, AuditLogEvent.RoleDelete, role.id);
    await role.delete('WELLSD GUARD rollback: yetkisiz rol oluşturma');
    return ok('Oluşturulan rol silindi.');
  } catch (err) {
    return fail(`Rol silinemedi: ${err.code || err.message}`);
  }
}

async function rollbackRoleDelete(guild, snapshot) {
  try {
    const created = await guild.roles.create({
      name: String(snapshot.name || 'geri-yuklenen-rol').slice(0, 100),
      color: snapshot.color || 0,
      hoist: !!snapshot.hoist,
      mentionable: !!snapshot.mentionable,
      permissions: snapshot.permissionsBitfield ?? 0n,
      reason: 'WELLSD GUARD rollback: yetkisiz rol silme',
    });
    markBotAction(guild.id, AuditLogEvent.RoleCreate, created.id);
    try {
      if (Number.isFinite(snapshot.position)) await created.setPosition(snapshot.position);
    } catch {
      /* pozisyon kritik değil */
    }
    return ok('Silinen rol yeniden oluşturuldu.');
  } catch (err) {
    return fail(`Rol yeniden oluşturulamadı: ${err.code || err.message}`);
  }
}

async function rollbackRoleUpdate(guild, oldRole, newRole) {
  try {
    await newRole.edit(
      {
        name: oldRole.name,
        color: oldRole.color,
        hoist: oldRole.hoist,
        mentionable: oldRole.mentionable,
        permissions: oldRole.permissions?.bitfield ?? 0n,
      },
      'WELLSD GUARD rollback: yetkisiz rol düzenleme',
    );
    markBotAction(guild.id, AuditLogEvent.RoleUpdate, newRole.id);
    return ok('Rol eski ayarlarına döndürüldü.');
  } catch (err) {
    return fail(`Rol geri alınamadı: ${err.code || err.message}`);
  }
}

/** Audit entry changes: $add/$remove dizileri. */
async function rollbackMemberRoles(guild, member, entry) {
  try {
    const added = [];
    const removed = [];
    for (const ch of entry?.changes || []) {
      if (ch.key === '$add' && Array.isArray(ch.new)) added.push(...ch.new.map((r) => r.id));
      if (ch.key === '$remove' && Array.isArray(ch.new)) removed.push(...ch.new.map((r) => r.id));
    }
    const fresh = (await guild.members.fetch(member.id).catch(() => null)) || member;
    const notes = [];
    if (added.length) {
      await fresh.roles.remove(added, 'WELLSD GUARD rollback: yetkisiz rol verme').catch((e) => {
        throw new Error(`verilen rol geri alınamadı: ${e.code || e.message}`);
      });
      markBotAction(guild.id, AuditLogEvent.MemberRoleUpdate, fresh.id);
      notes.push(`${added.length} rol geri alındı`);
    }
    if (removed.length) {
      await fresh.roles.add(removed, 'WELLSD GUARD rollback: yetkisiz rol alma').catch((e) => {
        throw new Error(`alınan rol geri verilemedi: ${e.code || e.message}`);
      });
      markBotAction(guild.id, AuditLogEvent.MemberRoleUpdate, fresh.id);
      notes.push(`${removed.length} rol geri verildi`);
    }
    if (!notes.length) return fail('Rollback edilecek rol değişimi bulunamadı.');
    return ok(notes.join(', ') + '.');
  } catch (err) {
    return fail(err.message || String(err));
  }
}

async function rollbackChannelCreate(guild, channel) {
  try {
    markBotAction(guild.id, AuditLogEvent.ChannelDelete, channel.id);
    await channel.delete('WELLSD GUARD rollback: yetkisiz kanal oluşturma');
    return ok('Oluşturulan kanal silindi.');
  } catch (err) {
    return fail(`Kanal silinemedi: ${err.code || err.message}`);
  }
}

function channelRecreateProps(snapshot) {
  const base = { name: String(snapshot.name || 'geri-yuklenen-kanal').slice(0, 100) };
  if (snapshot.parentId) base.parent = snapshot.parentId;
  if (snapshot.permissionOverwrites?.cache) {
    base.permissionOverwrites = [...snapshot.permissionOverwrites.cache.values()].map((o) => ({
      id: o.id,
      allow: o.allow?.bitfield ?? 0n,
      deny: o.deny?.bitfield ?? 0n,
    }));
  }
  if (snapshot.type === ChannelType.GuildText || snapshot.type === ChannelType.GuildAnnouncement) {
    return { ...base, type: snapshot.type, topic: snapshot.topic || undefined, nsfw: !!snapshot.nsfw, rateLimitPerUser: snapshot.rateLimitPerUser || 0 };
  }
  if (snapshot.type === ChannelType.GuildVoice) {
    return { ...base, type: snapshot.type, bitrate: snapshot.bitrate, userLimit: snapshot.userLimit };
  }
  if (snapshot.type === ChannelType.GuildCategory) {
    return { ...base, type: snapshot.type };
  }
  return null; // thread/forum vb. desteklenmiyor
}

async function rollbackChannelDelete(guild, snapshot) {
  try {
    const props = channelRecreateProps(snapshot);
    if (!props) return fail('Bu kanal türü otomatik kurulamıyor (manuel inceleme).');
    const created = await guild.channels.create({ ...props, reason: 'WELLSD GUARD rollback: yetkisiz kanal silme' });
    markBotAction(guild.id, AuditLogEvent.ChannelCreate, created.id);
    try {
      if (Number.isFinite(snapshot.position)) await created.setPosition(snapshot.position);
    } catch {
      /* pozisyon kritik değil */
    }
    return ok('Silinen kanal yeniden oluşturuldu.');
  } catch (err) {
    return fail(`Kanal yeniden oluşturulamadı: ${err.code || err.message}`);
  }
}

async function rollbackChannelUpdate(guild, oldCh, newCh) {
  try {
    if (oldCh.type === ChannelType.GuildText || oldCh.type === ChannelType.GuildAnnouncement) {
      await newCh.edit(
        { name: oldCh.name, topic: oldCh.topic ?? undefined, nsfw: oldCh.nsfw, rateLimitPerUser: oldCh.rateLimitPerUser ?? 0 },
        'WELLSD GUARD rollback: yetkisiz kanal düzenleme',
      );
    } else if (oldCh.type === ChannelType.GuildVoice) {
      await newCh.edit(
        { name: oldCh.name, bitrate: oldCh.bitrate, userLimit: oldCh.userLimit },
        'WELLSD GUARD rollback: yetkisiz kanal düzenleme',
      );
    } else {
      await newCh.edit({ name: oldCh.name }, 'WELLSD GUARD rollback');
    }
    markBotAction(guild.id, AuditLogEvent.ChannelUpdate, newCh.id);
    return ok('Kanal eski ayarlarına döndürüldü.');
  } catch (err) {
    return fail(`Kanal geri alınamadı: ${err.code || err.message}`);
  }
}

async function rollbackBan(guild, userId) {
  try {
    await guild.members.unban(String(userId), 'WELLSD GUARD rollback: yetkisiz ban');
    markBotAction(guild.id, AuditLogEvent.MemberBanRemove, String(userId));
    return ok('Hedef kullanıcının banı kaldırıldı.');
  } catch (err) {
    if (err?.code === 10026) return fail('Hedef zaten banlı değil.');
    return fail(`Ban kaldırılamadı: ${err.code || err.message}`);
  }
}

async function rollbackWebhook(guild, channel) {
  try {
    const hooks = await channel.fetchWebhooks();
    const cutoff = Date.now() - WEBHOOK_RECENT_MS;
    const fresh = [...hooks.values()].filter((w) => (w.createdTimestamp || 0) > cutoff);
    if (!fresh.length) return fail('Yeni webhook bulunamadı (manuel inceleme gerekli).');
    let n = 0;
    for (const w of fresh) {
      try {
        markBotAction(guild.id, AuditLogEvent.WebhookDelete, w.id);
        await w.delete('WELLSD GUARD rollback: yetkisiz webhook');
        n++;
      } catch {
        /* tekil hata diğerlerini engellemez */
      }
    }
    return n ? ok(`${n} webhook silindi.`) : fail('Webhook silinemedi (yetki?).');
  } catch (err) {
    return fail(`Webhook işlemi başarısız: ${err.code || err.message}`);
  }
}

async function rollbackGuild(guild, oldGuild) {
  try {
    if (oldGuild.name && oldGuild.name !== guild.name) {
      await guild.edit({ name: oldGuild.name }, 'WELLSD GUARD rollback: yetkisiz sunucu değişikliği');
      markBotAction(guild.id, AuditLogEvent.GuildUpdate, guild.id);
      return ok('Sunucu adı eski haline döndürüldü (diğer ayarlar manuel incelenmeli).');
    }
    return fail('Geri alınacak değişiklik bulunamadı (manuel inceleme).');
  } catch (err) {
    return fail(`Sunucu geri alınamadı: ${err.code || err.message}`);
  }
}

module.exports = {
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
};
