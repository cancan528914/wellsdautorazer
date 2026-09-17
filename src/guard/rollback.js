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
    await role.delete('Javrex Bot System Guard rollback: yetkisiz rol oluşturma');
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
      reason: 'Javrex Bot System Guard rollback: yetkisiz rol silme',
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
  const notes = [];
  try {
    await newRole.edit(
      {
        name: oldRole.name,
        color: oldRole.color,
        hoist: oldRole.hoist,
        mentionable: oldRole.mentionable,
        permissions: oldRole.permissions?.bitfield ?? 0n,
      },
      'Javrex Bot System Guard rollback: yetkisiz rol düzenleme',
    );
    notes.push('ayarlar');
  } catch (err) {
    return fail(`Rol geri alınamadı: ${err.code || err.message}`);
  }
  // Pozisyon geri yükleme (hiyerarşi engellerse logla, sahte başarı yazma)
  try {
    const oldPos = oldRole.rawPosition ?? oldRole.position;
    if (Number.isFinite(oldPos)) {
      await newRole.setPosition(oldPos, 'Javrex Bot System Guard rollback: rol sırası');
      notes.push('sıra');
    }
  } catch (err) {
    markBotAction(guild.id, AuditLogEvent.RoleUpdate, newRole.id);
    return { ok: true, detail: `Rol ayarları döndürüldü; SIRA geri alınamadı (${err.code || 'hiyerarşi'}).` };
  }
  markBotAction(guild.id, AuditLogEvent.RoleUpdate, newRole.id);
  return ok(`Rol eski haline döndürüldü (${notes.join(' + ')}).`);
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
      await fresh.roles.remove(added, 'Javrex Bot System Guard rollback: yetkisiz rol verme').catch((e) => {
        throw new Error(`verilen rol geri alınamadı: ${e.code || e.message}`);
      });
      markBotAction(guild.id, AuditLogEvent.MemberRoleUpdate, fresh.id);
      notes.push(`${added.length} rol geri alındı`);
    }
    if (removed.length) {
      await fresh.roles.add(removed, 'Javrex Bot System Guard rollback: yetkisiz rol alma').catch((e) => {
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
    await channel.delete('Javrex Bot System Guard rollback: yetkisiz kanal oluşturma');
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
    const created = await guild.channels.create({ ...props, reason: 'Javrex Bot System Guard rollback: yetkisiz kanal silme' });
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
  const notes = [];
  try {
    // 1. Temel ayarlar
    if (oldCh.type === ChannelType.GuildText || oldCh.type === ChannelType.GuildAnnouncement) {
      await newCh.edit(
        { name: oldCh.name, topic: oldCh.topic ?? undefined, nsfw: oldCh.nsfw, rateLimitPerUser: oldCh.rateLimitPerUser ?? 0 },
        'Javrex Bot System Guard rollback: yetkisiz kanal düzenleme',
      );
    } else if (oldCh.type === ChannelType.GuildVoice) {
      await newCh.edit(
        { name: oldCh.name, bitrate: oldCh.bitrate, userLimit: oldCh.userLimit },
        'Javrex Bot System Guard rollback: yetkisiz kanal düzenleme',
      );
    } else {
      await newCh.edit({ name: oldCh.name }, 'Javrex Bot System Guard rollback');
    }
    notes.push('ayarlar');
  } catch (err) {
    return fail(`Kanal geri alınamadı: ${err.code || err.message}`);
  }
  // 2. Kategori + sıra (eski snapshot event'ten gelir)
  try {
    if (oldCh.parentId !== undefined && oldCh.parentId !== newCh.parentId) {
      await newCh.setParent(oldCh.parentId, 'Javrex Bot System Guard rollback: kategori');
      notes.push('kategori');
    }
    const oldPos = oldCh.rawPosition ?? oldCh.position;
    if (Number.isFinite(oldPos)) {
      await newCh.setPosition(oldPos, 'Javrex Bot System Guard rollback: kanal sırası');
      notes.push('sıra');
    }
  } catch (err) {
    logger.warn?.(`Kanal konum rollback kısmi: ${err.code || err.message}`);
    notes.push('konum-kısmi');
  }
  // 3. Permission overwrite'ları: sadece FARKLILAŞANLAR geri yazılır
  try {
    const oldOw = oldCh.permissionOverwrites?.cache;
    const curOw = newCh.permissionOverwrites?.cache;
    if (oldOw && curOw) {
      let fixed = 0;
      for (const [id, o] of oldOw) {
        const cur = curOw.get(id);
        const same =
          cur &&
          String(cur.allow?.bitfield ?? cur.allow) === String(o.allow?.bitfield ?? o.allow) &&
          String(cur.deny?.bitfield ?? cur.deny) === String(o.deny?.bitfield ?? o.deny);
        if (!same) {
          await newCh.permissionOverwrites.edit(id, {
            allow: o.allow?.bitfield ?? o.allow ?? 0n,
            deny: o.deny?.bitfield ?? o.deny ?? 0n,
          });
          fixed++;
        }
      }
      if (fixed) notes.push(`${fixed} izin`);
    }
  } catch (err) {
    notes.push('izin-kısmi');
    logger.warn?.(`Overwrite rollback kısmi: ${err.code || err.message}`);
  }
  markBotAction(guild.id, AuditLogEvent.ChannelUpdate, newCh.id);
  return ok(`Kanal eski haline döndürüldü (${notes.join(' + ') || 'ad'}).`);
}

async function rollbackBan(guild, userId) {
  try {
    await guild.members.unban(String(userId), 'Javrex Bot System Guard rollback: yetkisiz ban');
    markBotAction(guild.id, AuditLogEvent.MemberBanRemove, String(userId));
    return ok('Hedef kullanıcının banı kaldırıldı.');
  } catch (err) {
    if (err?.code === 10026) return fail('Hedef zaten banlı değil.');
    return fail(`Ban kaldırılamadı: ${err.code || err.message}`);
  }
}

/**
 * Yetkisiz UNBAN rollback'i: hedef gerçekten önceden banlıysa banı tekrar uygular.
 * Önceden ban kaydı YOKSA kimseyi banlamaz (yanlış hedef koruması).
 */
async function rollbackUnban(guild, userId) {
  try {
    let hadPriorBan = false;
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 10 }).catch(() => null);
      for (const e of logs?.entries?.values?.() || []) {
        if (e?.target && String(e.target.id) === String(userId)) {
          hadPriorBan = true;
          break;
        }
      }
    } catch {
      /* audit okunamazsa temkinli davran */
    }
    if (!hadPriorBan) {
      return fail('Önceden ban kaydı bulunamadı — yanlış banlama engellendi (manuel inceleme).');
    }
    await guild.members.ban(String(userId), { reason: 'Javrex Bot System Guard rollback: yetkisiz unban', deleteMessageSeconds: 0 });
    markBotAction(guild.id, AuditLogEvent.MemberBanAdd, String(userId));
    return ok('Kaldırılan ban tekrar uygulandı.');
  } catch (err) {
    return fail(`Ban tekrar uygulanamadı: ${err.code || err.message}`);
  }
}

/**
 * Timeout rollback: uygulanmışsa kaldırır, kaldırılmışsa eski süreyi geri yazar.
 * prev: { applied: boolean, untilMs: number|null }
 */
async function rollbackTimeout(guild, member, prev) {
  try {
    const target = (await guild.members.fetch(member.id).catch(() => null)) || member;
    if (prev?.applied) {
      await target.timeout(null, 'Javrex Bot System Guard rollback: yetkisiz susturma');
      markBotAction(guild.id, AuditLogEvent.MemberUpdate, target.id);
      return ok('Yetkisiz susturma kaldırıldı.');
    }
    if (prev?.untilMs && prev.untilMs > Date.now()) {
      await target.timeout(prev.untilMs - Date.now(), 'Javrex Bot System Guard rollback: susturma geri yüklendi');
      markBotAction(guild.id, AuditLogEvent.MemberUpdate, target.id);
      return ok('Kaldırılan susturma geri yüklendi.');
    }
    return fail('Geri yüklenecek susturma bilgisi yok (manuel inceleme).');
  } catch (err) {
    return fail(`Susturma geri alınamadı: ${err.code || err.message}`);
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
        await w.delete('Javrex Bot System Guard rollback: yetkisiz webhook');
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
    // Güvenle geri alınabilir skaler ayarlar (tek API çağrısı)
    const payload = {};
    if (oldGuild.name != null && oldGuild.name !== guild.name) payload.name = oldGuild.name;
    if (oldGuild.verificationLevel != null) payload.verificationLevel = oldGuild.verificationLevel;
    if (oldGuild.defaultMessageNotifications != null) payload.defaultMessageNotifications = oldGuild.defaultMessageNotifications;
    if (oldGuild.explicitContentFilter != null) payload.explicitContentFilter = oldGuild.explicitContentFilter;
    if (oldGuild.afkTimeout != null) payload.afkTimeout = oldGuild.afkTimeout;
    const keys = Object.keys(payload);
    if (!keys.length) {
      return fail('Geri alınacak değişiklik bulunamadı (manuel inceleme).');
    }
    await guild.edit(payload, 'Javrex Bot System Guard rollback: yetkisiz sunucu değişikliği');
    markBotAction(guild.id, AuditLogEvent.GuildUpdate, guild.id);
    return ok(`Sunucu ayarları geri alındı (${keys.join(', ')}). İkon/AFK kanalı gibi karmaşık alanlar manuel incelenmeli.`);
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
  rollbackUnban,
  rollbackTimeout,
  rollbackWebhook,
  rollbackGuild,
};
