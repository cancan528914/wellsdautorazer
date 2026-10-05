/**
 * Discord event → Guard aksiyon eşleşmesi + yeni log mimarisi.
 * Her fonksiyon kendi hatasını yutar (Guard asla crash etmez, diğer sistemleri engellemez).
 *
 * MİMARİ:
 *  - Koruma (ceza/rollback) → handleGuardEvent (bozulmadı, aynı)
 *  - Loglama           → logEvent/logService (yeni, kanal bazlı)
 * Her event İKİSİNİ de yapabilir: yetkisizse ceza + log, yetkiliyse sadece log.
 */
const { AuditLogEvent, ChannelType } = require('discord.js');
const logger = require('../utils/logger');
const { handleGuardEvent } = require('./manager');
const { findExecutor } = require('./audit');
const { logEvent, sendLog } = require('./logService');
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
const { isInternalOp, markInternalOp } = require('./internalOps');

// ===== GUARD DEBUG (production kanalına ASLA spam atmaz; sadece terminale yazar) =====
// Açmak için .env: GUARD_DEBUG=true
const DEBUG_GUARD = String(process.env.GUARD_DEBUG || '').toLowerCase() === 'true';

// ===== EVENT DEDUPLICATION =====
// Discord aynı olayı nadiren iki kez yollar. Aynı guild+event+fark imzası
// kısa pencerede tekrar gelirse eleriz.
//
// ⚠️ TTL NEDEN 15sn? Audit Log eşleştirmesi (findExecutor) 2-3 saniye
// sürebilir. TTL bunun altında kalırsa ikinci event dedup'u geçer ve
// DUPLICATE log yazar. 15sn: gerçek bir kullanıcı aynı değişikliği 15sn içinde
// iki kez yaparsa elenir (bu doğru davranıştır), audit gecikmesi sorun çıkarmaz.
const DEDUP_TTL_MS = 15000;
const DEDUP_MAX = 1000;
const seenEvents = new Map();

/**
 * Atomik dedup: kontrol + kayıt TEK ADIMDA yapılır.
 *
 * ⚠️ Neden atomik? İki aynı event PARALEL gelirse (await noktasında iki
 * handler birbirini beklerken) ikisi de "ilk görüyorum" der ve ikisi de
 * loglar. Kontrol ile kayıt arasında await olmadığı için bu yarış imkânsız.
 *
 * @returns {boolean} true ise BU olay daha önce işlendi → atla
 */
function isDuplicateEvent(guildId, eventType, signature) {
  try {
    const now = Date.now();
    const key = `${guildId}:${eventType}:${signature}`;
    const exp = seenEvents.get(key);
    // Kayıt hemen yazılır (await YOK → yarış durumu yok)
    seenEvents.set(key, now + DEDUP_TTL_MS);

    if (seenEvents.size > DEDUP_MAX) {
      const sorted = [...seenEvents.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of sorted.slice(0, seenEvents.size - DEDUP_MAX)) seenEvents.delete(k);
    }
    if (seenEvents.size % 50 === 0) {
      for (const [k, e] of seenEvents) if (e <= now) seenEvents.delete(k);
    }
    return !!(exp && exp > now);
  } catch {
    return false;
  }
}

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

/**
 * Kanal bir guard log kanalı mı? (12 log kanalından biri veya guard-log)
 * Yeni mimari: guard_log_channels tablosu tek doğruluk kaynağı.
 */
function isLogChannel(guild, channelId) {
  try {
    if (!guild || !channelId) return false;
    const { getGuardLogChannels, getGuardLogChannel } = require('../database/database');
    const recorded = getGuardLogChannel(guild.id, 'guard');
    if (recorded && String(recorded) === String(channelId)) return true;
    const map = getGuardLogChannels(guild.id);
    for (const id of Object.values(map)) {
      if (String(id) === String(channelId)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Log kanalı izinleri bozulduysa onarır — **DRIFT KONTROLLÜ**.
 *
 * ⚠️ ESKİ DÖNGÜ BURADAYDI:
 *   Eski sürüm her channelUpdate'te permissionOverwrites.set() çağırıyordu →
 *   bu channelUpdate üretiyordu → tekrar onarım → sonsuz döngü.
 *
 * YENİ: Sadece izinler GERÇEKTEN bozuksa dokunur, ve yazmadan önce
 * internalOps ile işaretler (oluşacak event elenir).
 */
async function fixLogChannelPerms(guild, channel) {
  try {
    const me = guild.members?.me;
    if (!me) return;
    // Drift kontrolü: izinler doğruysa HİÇBİR ŞEY yapma (döngü kaynağı buydu)
    const { overwritesNeedFix } = require('./logChannels');
    if (!overwritesNeedFix(channel, guild, me.id)) return;

    // Yazmadan önce işaretle → oluşacak channelUpdate elenir (döngü kesilir)
    markInternalOp(guild.id, 'perm', channel.id);
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
    if (DEBUG_GUARD) console.log(`[GUARD DEBUG] ROLE CREATE: ${role.name} (${role.id})`);
    // Botun kendi oluşturduğu rolü el (guard rollback'leri kendi rolünü siler/oluşturur)
    if (isInternalOp(role.guild.id, 'create', role.id)) return;
    await handleGuardEvent({
      client,
      guild: role.guild,
      action: 'ROLE_CREATE',
      targetId: role.id,
      targetDesc: `Rol: ${role.name || role.id}`,
      doRollback: () => rollbackRoleCreate(role.guild, role),
    });
    await logEvent({
      guild: role.guild,
      logType: 'role',
      auditType: AuditLogEvent.RoleCreate,
      targetId: role.id,
      title: 'ROL OLUŞTURULDU',
      target: { kind: 'role', id: role.id, label: '🎭 Oluşturulan Rol' },
      action: `Rol oluşturuldu: **${role.name}**`,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onRoleCreate failed.', err);
  }
}

async function onRoleDelete(client, role) {
  try {
    if (!role?.guild) return;
    if (DEBUG_GUARD) console.log(`[GUARD DEBUG] ROLE DELETE: ${role.name} (${role.id})`);
    // Botun kendi sildiği/oluşturduğu rolü el
    if (isInternalOp(role.guild.id, 'delete', role.id)) return;
    if (isInternalOp(role.guild.id, 'create', role.id)) return;
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
    await logEvent({
      guild: role.guild,
      logType: 'role',
      auditType: AuditLogEvent.RoleDelete,
      targetId: role.id,
      title: 'ROL SİLİNDİ',
      target: { kind: 'role', id: role.id, label: '🎭 Silinen Rol' },
      action: `Rol silindi: **${role.name}**`,
      note: isSensitiveTarget(role.guild, [role.id]) ? '⚠️ Botun kritik rolüydü.' : undefined,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onRoleDelete failed.', err);
  }
}

/** İki rol arasındaki farkları okunur satırlara çevirir. */
function diffRole(oldRole, newRole) {
  const lines = [];
  try {
    if (oldRole.name !== newRole.name) lines.push(`**Ad:** \`${oldRole.name}\` → \`${newRole.name}\``);
    if (oldRole.color !== newRole.color) {
      const hx = (c) => `#${(c ?? 0).toString(16).padStart(6, '0')}`;
      lines.push(`**Renk:** ${hx(oldRole.color)} → ${hx(newRole.color)}`);
    }
    if (oldRole.permissions?.bitfield !== newRole.permissions?.bitfield) {
      lines.push('**İzinler:** değiştirildi');
    }
    if (oldRole.hoist !== newRole.hoist) lines.push(`**Tut:** \`${oldRole.hoist}\` → \`${newRole.hoist}\``);
    if (oldRole.mentionable !== newRole.mentionable) lines.push(`**Etiketlenebilir:** \`${oldRole.mentionable}\` → \`${newRole.mentionable}\``);
    const op = oldRole.rawPosition ?? oldRole.position;
    const np = newRole.rawPosition ?? newRole.position;
    if (op !== np) lines.push(`**Pozisyon:** \`${op}\` → \`${np}\``);
  } catch {
    /* diff hatası kritik değil */
  }
  return lines.length ? lines.join('\n') : null;
}

async function onRoleUpdate(client, oldRole, newRole) {
  try {
    if (!newRole?.guild) return;
    if (DEBUG_GUARD) console.log(`[GUARD DEBUG] ROLE UPDATE: ${newRole.name} (${newRole.id})`);
    // Botun kendi yaptığı izin/pozisyon değişikliğini el (rollback zinciri korunur)
    if (isInternalOp(newRole.guild.id, 'perm', newRole.id)) return;
    // Anlamlı değişiklik yoksa çık (partial güncelleme spam yapmaz)
    const rdiff = diffRole(oldRole, newRole);
    if (!rdiff) return;
    if (isDuplicateEvent(newRole.guild.id, 'role:update', hashChannelChange(newRole.id, rdiff))) return;
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
    await logEvent({
      guild: newRole.guild,
      logType: 'role',
      auditType: AuditLogEvent.RoleUpdate,
      targetId: newRole.id,
      title: 'ROL GÜNCELLENDİ',
      target: { kind: 'role', id: newRole.id, label: '🎭 Güncellenen Rol' },
      action: 'Rol güncellendi.',
      note: rdiff,
    }).catch(() => {});
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
    // BİLEREK KAPSAM DIŞI: ses susturma (mute/unmute), ses taşıma ve sesten
    // atma işlemleri rol/timeout değiştirmez → buradan sessizce çıkılır.
    // Guard voiceStateUpdate dinlemez ve voice audit tiplerini sorgulamaz.
    // Susturma (timeout) koruması aynen korunur.
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
    if (rolesChanged) {
    await handleGuardEvent({
      client,
      guild: newMember.guild,
      action: 'MEMBER_ROLE_UPDATE',
      targetId: newMember.id,
      targetDesc: `Üye: ${newMember.user?.tag || newMember.id}`,
      sensitive: isSensitiveTarget(newMember.guild, changedIds),
      doRollback: (ctx) => rollbackMemberRoles(newMember.guild, newMember, ctx?.entry),
    });

      // ÜYE LOG: rol değişimi (üye-log) + kimlik değişimi (nickname/avatar)
      const added = [...after].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !after.has(id));
      const roleNameOf = (id) => {
        try {
          return newMember.guild.roles.cache.get(id)?.name || id;
        } catch {
          return id;
        }
      };
      const parts = [];
      if (added.length) parts.push(`**Eklenen:** ${added.map((id) => `<@&${id}> \`${roleNameOf(id)}\``).join(', ')}`);
      if (removed.length) parts.push(`**Alınan:** ${removed.map((id) => `<@&${id}> \`${roleNameOf(id)}\``).join(', ')}`);

      // ROL-LOG: Üyeye rol verilmesi/alınması ROL kanalına gider (gereksinim #9).
      // Eklenen ve alınan AYRI log'lanır → "ROL VERİLDİ" / "ROL ALINDI" net olur.
      if (added.length) {
        await logEvent({
          guild: newMember.guild,
          logType: 'role',
          auditType: AuditLogEvent.MemberRoleUpdate,
          targetId: newMember.id,
          title: 'ÜYEYE ROL VERİLDİ',
          target: { kind: 'user', id: newMember.id, label: '🎯 Üye' },
          action: added.map((id) => `<@&${id}> \`${roleNameOf(id)}\``).join(', '),
        }).catch(() => {});
      }
      if (removed.length) {
        await logEvent({
          guild: newMember.guild,
          logType: 'role',
          auditType: AuditLogEvent.MemberRoleUpdate,
          targetId: newMember.id,
          title: 'ÜYEDEN ROL ALINDI',
          target: { kind: 'user', id: newMember.id, label: '🎯 Üye' },
          action: removed.map((id) => `<@&${id}> \`${roleNameOf(id)}\``).join(', '),
        }).catch(() => {});
      }
    }

    // Nickname / avatar değişimi → üye-log (rol değişiminden bağımsız çalışır)
    await logMemberIdentityChange(oldMember, newMember).catch(() => {});
  } catch (err) {
    logger.error('Guard onGuildMemberUpdate failed.', err);
  }
}

/**
 * Nickname / avatar değişimini üye-log'a yazar.
 * Audit Log bu işlemleri MEMBER_UPDATE altında toplar (zaman penceresi dar).
 * Değişiklik yoksa hiçbir şey gönderilmez (event spam'i yok).
 */
async function logMemberIdentityChange(oldMember, newMember) {
  try {
    if (!oldMember?.guild || !newMember?.user) return;
    const lines = [];
    const oldNick = oldMember.nickname ?? null;
    const newNick = newMember.nickname ?? null;
    if (oldNick !== newNick) {
      lines.push(`**Takma ad:** \`${oldNick || 'yok'}\` → \`${newNick || 'yok'}\``);
    }
    let oldAvatar = null;
    let newAvatar = null;
    try {
      oldAvatar = oldMember.user.displayAvatarURL?.({ extension: 'png', size: 64 }) || null;
      newAvatar = newMember.user.displayAvatarURL?.({ extension: 'png', size: 64 }) || null;
    } catch {
      /* avatar URL alınamadı, atlanır */
    }
    if (oldAvatar && newAvatar && oldAvatar !== newAvatar) {
      lines.push('**Avatar:** değiştirildi');
    }
    if (!lines.length) return; // değişiklik yok → log yok (spam yok)

    await logEvent({
      guild: newMember.guild,
      logType: 'member',
      auditType: AuditLogEvent.MemberUpdate,
      targetId: newMember.id,
      title: 'ÜYE PROFİLİ GÜNCELLENDİ',
      target: { kind: 'user', id: newMember.id, label: '🎯 Üye' },
      action: lines.join('\n'),
    });
  } catch (err) {
    logger.warn(`Üye profil logu atlandı: ${err.code || err.message}`);
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
    await logEvent({
      guild: channel.guild,
      logType: 'channel',
      auditType: AuditLogEvent.ChannelCreate,
      targetId: channel.id,
      title: 'KANAL OLUŞTURULDU',
      target: { kind: 'channel', id: channel.id, label: '📁 Oluşturulan Kanal' },
      action: `Kanal oluşturuldu: **${channelLabel(channel)}**`,
    }).catch(() => {});
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
    await logEvent({
      guild: channel.guild,
      logType: 'channel',
      auditType: AuditLogEvent.ChannelDelete,
      targetId: channel.id,
      title: 'KANAL SİLİNDİ',
      target: { kind: 'channel', id: channel.id, label: '📁 Silinen Kanal' },
      action: `Kanal silindi: **${channelLabel(channel)}**`,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onChannelDelete failed.', err);
  }
}

async function onChannelUpdate(client, oldChannel, newChannel) {
  try {
    if (!newChannel?.guild || !GUILD_CHANNEL_TYPES.has(newChannel.type)) return;

    // ===== KATMAN 1: BOTUN KENDİ İŞLEMİ (döngü kırıcı) =====
    // Bot bu kanalın izinlerini/parent'ını kendisi değiştirdiyse → eventi ELİMLE.
    // Bu olmadan: log yaz → izin güncelle → channelUpdate → log → ... ♾️
    if (isInternalOp(newChannel.guild.id, 'perm', newChannel.id)) return;
    if (isInternalOp(newChannel.guild.id, 'create', newChannel.id)) return;

    // Log kanalı izinleri bozulduysa onar — drift kontrollü + internalOp işaretli
    if (isLogChannel(newChannel.guild, newChannel.id)) {
      await fixLogChannelPerms(newChannel.guild, newChannel);
    }

    // ===== KATMAN 2: ANLAMLI DEĞİŞİKLİK YOKSA ÇIKI =====
    const diff = diffChannel(oldChannel, newChannel);
    if (!diff) return; // hiçbir şey değişmemiş → log yok (spam yok)
    if (DEBUG_GUARD) {
      console.log(`[GUARD DEBUG] CHANNEL UPDATE: ${channelLabel(newChannel)} | değişiklikler:\n${diff}`);
    }

    // ===== KATMAN 3: DEDUP (aynı event iki kez gelirse) =====
    const changeSig = hashChannelChange(newChannel.id, diff);
    if (isDuplicateEvent(newChannel.guild.id, 'channel:update', changeSig)) return;
    // Tracker-first: botun kendi rollback adımları audit'e gitmeden elenir.
    // (Overwrite rollback'leri de channelUpdate event'i üretir.)
    try {
      const { isBotAction } = require('./tracker');
      if (
        isBotAction(newChannel.guild.id, AuditLogEvent.ChannelUpdate, newChannel.id) ||
        isBotAction(newChannel.guild.id, AuditLogEvent.ChannelOverwriteCreate, newChannel.id) ||
        isBotAction(newChannel.guild.id, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id) ||
        isBotAction(newChannel.guild.id, AuditLogEvent.ChannelOverwriteDelete, newChannel.id)
      ) {
        return;
      }
    } catch {
      /* tracker hatası akışı engellemez */
    }
    // Önce düz kanal düzenlemesi dene (tek lookup + kısa retry).
    // Overwrite değişimleri tek turda, retriesiz yoklanır (en fazla 3 ek çağrı).
    // NOT: overwrite değişimi de CHANNEL_UPDATE olarak işlenir; rollbackChannelUpdate
    // izinleri de geri yazdığı için koruma kaybı yoktur (etiket hassasiyeti gider).
    const matched = await findExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id, { attempts: 2 });
    if (matched) {
      await handleGuardEvent({
        client,
        guild: newChannel.guild,
        action: 'CHANNEL_UPDATE',
        targetId: newChannel.id,
        targetDesc: channelLabel(newChannel),
        resolved: { executor: matched.executor, entry: matched.entry },
        doRollback: () => rollbackChannelUpdate(newChannel.guild, oldChannel, newChannel),
      });
      return;
    }
    const owTypes = [AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete];
    let owMatched = null;
    for (const auditType of owTypes) {
      const found = await findExecutor(newChannel.guild, auditType, newChannel.id, { attempts: 1 });
      if (found) {
        owMatched = found;
        break;
      }
    }
    // Hiçbir audit eşleşmedi → manager throttle'lı unresolved işler; yine de tek çağrı yap
    await handleGuardEvent({
      client,
      guild: newChannel.guild,
      action: 'CHANNEL_UPDATE',
      targetId: newChannel.id,
      targetDesc: channelLabel(newChannel),
      ...(owMatched ? { resolved: { executor: owMatched.executor, entry: owMatched.entry } } : {}),
      doRollback: () => rollbackChannelUpdate(newChannel.guild, oldChannel, newChannel),
    });

    // Kanal güncelleme logu (ad/topic/pozisyon/izin farkları)
    await logEvent({
      guild: newChannel.guild,
      logType: 'channel',
      auditType: matched ? AuditLogEvent.ChannelUpdate : AuditLogEvent.ChannelOverwriteUpdate,
      targetId: newChannel.id,
      title: 'KANAL GÜNCELLENDİ',
      target: { kind: 'channel', id: newChannel.id, label: '📁 Güncellenen Kanal' },
      action: 'Kanal güncellendi.',
      note: diff,
      resolvedActor: matched?.executor,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onChannelUpdate failed.', err);
  }
}

/**
 * İki kanal arasındaki GERÇEK farkları okunur satırlara çevirir.
 * @returns {string|null} değişiklik yoksa null (→ event yoksayılır)
 */
function diffChannel(oldCh, newCh) {
  if (!oldCh || !newCh) return null;
  const lines = [];
  try {
    if (oldCh.name !== newCh.name) lines.push(`**Ad:** \`${oldCh.name}\` → \`${newCh.name}\``);
    if ((oldCh.topic ?? null) !== (newCh.topic ?? null)) {
      lines.push(`**Konu (topic):** \`${String(oldCh.topic ?? '—').slice(0, 60)}\` → \`${String(newCh.topic ?? '—').slice(0, 60)}\``);
    }
    if ((oldCh.parentId ?? null) !== (newCh.parentId ?? null)) {
      lines.push(`**Kategori:** \`${oldCh.parentId ?? '—'}\` → \`${newCh.parentId ?? '—'}\``);
    }
    const op = oldCh.rawPosition ?? oldCh.position;
    const np = newCh.rawPosition ?? newCh.position;
    if (op !== np) lines.push(`**Pozisyon:** \`${op}\` → \`${np}\``);
    if (oldCh.nsfw !== newCh.nsfw) lines.push(`**NSFW:** \`${oldCh.nsfw}\` → \`${newCh.nsfw}\``);
    // Metin kanalları
    if ((oldCh.rateLimitPerUser ?? 0) !== (newCh.rateLimitPerUser ?? 0)) {
      lines.push(`**Yavaş mod:** \`${oldCh.rateLimitPerUser ?? 0}\` → \`${newCh.rateLimitPerUser ?? 0}\` sn`);
    }
    // Ses kanalları
    if ((oldCh.bitrate ?? null) !== (newCh.bitrate ?? null)) lines.push(`**Bit hızı:** \`${oldCh.bitrate}\` → \`${newCh.bitrate}\``);
    if ((oldCh.userLimit ?? null) !== (newCh.userLimit ?? null)) {
      lines.push(`**Kullanıcı limiti:** \`${oldCh.userLimit ?? 'sınırsız'}\` → \`${newCh.userLimit ?? 'sınırsız'}\``);
    }
    // Kanal türü (metin <-> ses dönüşümü)
    if (oldCh.type !== newCh.type) lines.push(`**Tür:** \`${oldCh.type}\` → \`${newCh.type}\``);
    // Permission overwrite — İÇERİK bazlı karşılaştırma (sayı değil, gerçek izinler)
    try {
      const before = new Set(oldCh.permissionOverwrites?.cache?.values?.() || []);
      const after = new Set(newCh.permissionOverwrites?.cache?.values?.() || []);
      let changed = before.size !== after.size;
      if (!changed) {
        for (const ov of after) {
          const oldOv = oldCh.permissionOverwrites.cache.get(ov.id);
          if (!oldOv || !ov.allow.equals(oldOv.allow) || !ov.deny.equals(oldOv.deny)) {
            changed = true;
            break;
          }
        }
      }
      if (changed) lines.push(`**Kanal izinleri:** değiştirildi (${before.size} → ${after.size} overwrite)`);
    } catch {
      /* overwrite cache/equals yoksa atlanır */
    }
  } catch {
    /* diff hatası kritik değil */
  }
  return lines.length ? lines.join('\n') : null;
}

/** Kanal/rol değişikliği için kısa imza (dedup anahtarı). */
function hashChannelChange(targetId, diff) {
  return hashChange(targetId, diff);
}

/**
 * Değişiklik imzası (dedup anahtarı).
 *
 * ⚠️ DİKKAT — yanlış eleme YAPILMAZ:
 *   Değerler (isim, topic, sayılar) ÖNEMLİDİR ve korunur. Sadece
 *   değişken olmayan kısımlar (emoji, gereksiz boşluk) sadeleştirilir.
 *   Böylece: aynı olay iki kez gelirse aynı imza → elenir;
 *           farklı gerçek değişiklikler farklı imza → KORUNUR.
 */
function hashChange(targetId, diff) {
  try {
    // Yalnızca zaman damgası gibi değişken kısımları sadeleştir.
    // Değerler (t1/t2, eski-ad/yeni-ad) KORUNUR — elenmemeli.
    const norm = String(diff)
      .replace(/\s+/g, ' ')
      .trim();
    let h = 0;
    const s = `${targetId}|${norm}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  } catch {
    return `${targetId}:${Date.now()}`;
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
    await logEvent({
      guild,
      logType: 'ban_kick',
      auditType: AuditLogEvent.MemberBanAdd,
      targetId: user.id,
      title: 'ÜYE BANLANDI',
      target: { kind: 'user', id: user.id, label: '🔨 Banlanan Üye' },
      action: `**${user.username || user.id}** sunucudan banlandı.`,
    }).catch(() => {});
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
    await logEvent({
      guild,
      logType: 'ban_kick',
      auditType: AuditLogEvent.MemberBanRemove,
      targetId: user.id,
      title: 'BAN KALDIRILDI',
      target: { kind: 'user', id: user.id, label: '🔓 Banı Kaldırılan' },
      action: `**${user.username || user.id}** kullanıcısının banı kaldırıldı.`,
    }).catch(() => {});
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
    if (!found) {
      // Normal ayrılma → üye-log (kicked değil, ayrıldı)
      await logEvent({
        guild,
        logType: 'member',
        auditType: null,
        targetId: null,
        title: 'ÜYE SUNUCUDAN AYRILDI',
        target: { kind: 'user', id: member.user.id, label: '🚪 Ayrılan Üye' },
        action: `**${member.user.username || member.user.id}** sunucudan ayrıldı (kicked değil).`,
        senderId: member.user.id,
        note: 'Audit Log\'da kick kaydı yok — doğal ayrılma olarak loglandı.',
      }).catch(() => {});
      return;
    }
    await handleGuardEvent({
      client,
      guild,
      action: 'MEMBER_KICK',
      targetId: member.user.id,
      targetDesc: `Üye: ${member.user.tag || member.user.id}`,
      doRollback: null, // kick geri alınamaz
      resolved: found,
    });
    await logEvent({
      guild,
      logType: 'ban_kick',
      auditType: AuditLogEvent.MemberKick,
      targetId: member.user.id,
      title: 'ÜYE KICKLENDİ',
      target: { kind: 'user', id: member.user.id, label: '🥾 Kicklenen Üye' },
      action: `**${member.user.username || member.user.id}** sunucudan kicklendi.`,
      resolvedActor: found?.executor,
      resolvedReason: found?.entry?.reason,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onGuildMemberRemove failed.', err);
  }
}

/** Üye sunucuya girdiğinde: bot mu? → bot-log, değilse → üye-log. */
async function onGuildMemberAdd(client, member) {
  try {
    const guild = member?.guild;
    if (!guild || !member?.user) return;
    const isBot = !!member.user.bot;
    await logEvent({
      guild,
      logType: isBot ? 'bot' : 'member',
      auditType: null,
      targetId: null,
      title: isBot ? 'BOT SUNUCUYA EKLENDİ' : 'ÜYE SUNUCUYA KATILDI',
      target: { kind: 'user', id: member.user.id, label: isBot ? '🤖 Eklenen Bot' : '👤 Katılan Üye' },
      action: isBot
        ? `**${member.user.username}** sunucuya eklendi.`
        : `**${member.user.username}** sunucuya katıldı.`,
      senderId: member.user.id,
      senderIsBot: isBot,
      actorKind: isBot ? 'bot' : 'user',
      verified: false, // join audit'e girmez → doğrulanamadı olarak gösterilir (dürüstlük)
      note: 'Katılım olayı Audit Log\'a düşmez.',
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onGuildMemberAdd failed.', err);
  }
}

/** Üye sunucudan ayrılırken bot mu? → bot-log. */
async function onGuildMemberRemoveBot(client, member) {
  try {
    const guild = member?.guild;
    if (!guild || !member?.user?.bot) return;
    await logEvent({
      guild,
      logType: 'bot',
      auditType: null,
      targetId: null,
      title: 'BOT SUNUCUDAN ÇIKARILDI',
      target: { kind: 'user', id: member.user.id, label: '🤖 Çıkarılan Bot' },
      action: `**${member.user.username}** sunucudan çıkarıldı veya bot hesabı silindi.`,
      senderId: member.user.id,
      senderIsBot: true,
      actorKind: 'bot',
      verified: false,
      note: 'Bot çıkarılma olayı Audit Log\'a düşmez.',
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onGuildMemberRemoveBot failed.', err);
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

    const webhookAction =
      best.type === AuditLogEvent.WebhookCreate
        ? 'WEBHOOK OLUŞTURULDU'
        : best.type === AuditLogEvent.WebhookDelete
          ? 'WEBHOOK SİLİNDİ'
          : 'WEBHOOK GÜNCELLENDİ';
    await logEvent({
      guild: channel.guild,
      logType: 'webhook',
      auditType: best.type,
      targetId: best.entry.target?.id || channel.id,
      title: webhookAction,
      target: { kind: 'channel', id: channel.id, label: '🪝 Kanal' },
      action: `Webhook işlemi: \`#${channel.name || channel.id}\``,
      resolvedActor: best.entry.executor,
      resolvedReason: best.entry.reason,
    }).catch(() => {});
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
    await logEvent({
      guild: newGuild,
      logType: 'guild',
      auditType: AuditLogEvent.GuildUpdate,
      targetId: newGuild.id,
      title: 'SUNUCU AYARLARI DEĞİŞTİ',
      target: { kind: 'channel', id: newGuild.id, label: '🏛️ Sunucu' },
      action: 'Sunucu ayarları güncellendi.',
      note: diffGuild(oldGuild, newGuild),
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onGuildUpdate failed.', err);
  }
}

/** İki guild arasındaki farkları okunur satırlara çevirir. */
function diffGuild(oldG, newG) {
  const lines = [];
  try {
    if (oldG?.name !== newG?.name) lines.push(`**Sunucu adı:** \`${oldG?.name}\` → \`${newG?.name}\``);
    try {
      const oi = oldG?.iconURL?.() || null;
      const ni = newG?.iconURL?.() || null;
      if (oi !== ni) lines.push('**Sunucu ikonu:** değiştirildi');
    } catch {
      /* ikon URL yoksa atlanır */
    }
    if (oldG?.verificationLevel !== newG?.verificationLevel) lines.push('**Doğrulama seviyesi:** değiştirildi');
    if (oldG?.explicitContentFilter !== newG?.explicitContentFilter) lines.push('**İçerik filtresi:** değiştirildi');
    if ((oldG?.ownerId ?? null) !== (newG?.ownerId ?? null)) {
      lines.push('⚠️ **Sunucu sahibi değişti**');
    }
    if ((oldG?.preferredLocale ?? null) !== (newG?.preferredLocale ?? null)) lines.push('**Sunucu dili:** değiştirildi');
  } catch {
    /* diff hatası kritik değil */
  }
  return lines.length ? lines.join('\n') : null;
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
    await logEvent({
      guild: emoji.guild,
      logType: 'emoji_sticker',
      auditType: AuditLogEvent.EmojiCreate,
      targetId: emoji.id,
      title: 'EMOJI OLUŞTURULDU',
      target: { id: emoji.id, label: '😀 Emoji' },
      action: `Emoji oluşturuldu: **${emoji.name || emoji.id}**`,
    }).catch(() => {});
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
    await logEvent({
      guild: newEmoji.guild,
      logType: 'emoji_sticker',
      auditType: AuditLogEvent.EmojiUpdate,
      targetId: newEmoji.id,
      title: 'EMOJI GÜNCELLENDİ',
      target: { id: newEmoji.id, label: '😀 Emoji' },
      action: `Emoji güncellendi: \`${oldEmoji?.name ?? '—'}\` → \`${newEmoji.name || newEmoji.id}\``,
    }).catch(() => {});
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
    await logEvent({
      guild: emoji.guild,
      logType: 'emoji_sticker',
      auditType: AuditLogEvent.EmojiDelete,
      targetId: emoji.id,
      title: 'EMOJI SİLİNDİ',
      target: { id: emoji.id, label: '😀 Emoji' },
      action: `Emoji silindi: **${emoji.name || emoji.id}**`,
    }).catch(() => {});
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
    await logEvent({
      guild,
      logType: 'emoji_sticker',
      auditType: AuditLogEvent.StickerCreate,
      targetId: sticker.id,
      title: 'STICKER OLUŞTURULDU',
      target: { id: sticker.id, label: '😀 Sticker' },
      action: `Sticker oluşturuldu: **${sticker.name || sticker.id}**`,
    }).catch(() => {});
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
    await logEvent({
      guild,
      logType: 'emoji_sticker',
      auditType: AuditLogEvent.StickerUpdate,
      targetId: newSticker.id,
      title: 'STICKER GÜNCELLENDİ',
      target: { id: newSticker.id, label: '😀 Sticker' },
      action: `Sticker güncellendi: \`${oldSticker?.name ?? '—'}\` → \`${newSticker.name || newSticker.id}\``,
    }).catch(() => {});
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
    await logEvent({
      guild,
      logType: 'emoji_sticker',
      auditType: AuditLogEvent.StickerDelete,
      targetId: sticker.id,
      title: 'STICKER SİLİNDİ',
      target: { id: sticker.id, label: '😀 Sticker' },
      action: `Sticker silindi: **${sticker.name || sticker.id}**`,
    }).catch(() => {});
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

// ===================== YENİ: MESAJ / SES / DAVET LOGLARI =====================
// Bu eventler önce hiç dinlenmiyordu. Artık kanala özel log düşerler.
// Not: Bunlar SADECE log üretir; koruma (ceza/rollback) içermez — mesaj/ses
// işlemleri için koruma kapsamı dışıdır (mevcut tasarım korundu).

/** Mesaj silme → mesaj-log (grup-safe: toplu silme spam yapmaz). */
async function onMessageDelete(client, message) {
  try {
    if (!message?.guild) return;
    // Botların mesajlarını loglama (kendi bot trafiği log kirliliği yapar)
    if (message.author?.bot) return;
    // Embed'li/sistem mesajları atla (Discord otomatik mesajları)
    if (!message.content && message.embeds?.length && !message.attachments?.size) return;

    await logEvent({
      guild: message.guild,
      logType: 'message',
      auditType: AuditLogEvent.MessageDelete,
      targetId: message.author?.id || null,
      title: 'MESAJ SİLİNDİ',
      target: { kind: 'channel', id: message.channelId, label: '📁 Kanal' },
      action: `\`${message.author?.username || 'bilinmiyor'}\` mesajı sildi.`,
      note: `**Kanal:** <#${message.channelId}>\n**İçerik:** ${truncate(message.content || '（yok）')}`,
      senderId: null,
      verified: false, // messageDelete audit'e girmez
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onMessageDelete failed.', err);
  }
}

/** Toplu mesaj silme → mesaj-log (özet, tek embed). */
async function onMessageDeleteBulk(client, messages) {
  try {
    const arr = Array.isArray(messages) ? messages : [...(messages?.values?.() || [])];
    const guild = arr[0]?.guild;
    if (!guild || !arr.length) return;
    await sendLog({
      guild,
      logType: 'message',
      title: 'TOPLU MESAJ SİLİNDİ',
      verified: false,
      target: { kind: 'channel', id: arr[0].channelId, label: '📁 Kanal' },
      action: `**${arr.length}** mesaj toplu silindi.`,
      note: `**Kanal:** <#${arr[0].channelId}>`,
      actorKind: 'unknown',
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onMessageDeleteBulk failed.', err);
  }
}

/** Mesaj düzenleme → mesaj-log (içerik değişikliği gösterilir). */
async function onMessageUpdate(client, oldMessage, newMessage) {
  try {
    if (!newMessage?.guild) return;
    if (newMessage.author?.bot) return;
    // Sadece içerik gerçekten değiştiyse logla (partial güncellemeleri spam yapar)
    if (oldMessage?.content === newMessage.content) return;

    await logEvent({
      guild: newMessage.guild,
      logType: 'message',
      auditType: AuditLogEvent.MessageUpdate,
      targetId: newMessage.author?.id || null,
      title: 'MESAJ DÜZENLENDİ',
      target: { kind: 'channel', id: newMessage.channelId, label: '📁 Kanal' },
      action: `\`${newMessage.author?.username || 'bilinmiyor'}\` mesajı düzenledi.`,
      note: `**Kanal:** <#${newMessage.channelId}>\n**Eski:** ${truncate(oldMessage?.content || '（yok）')}\n**Yeni:** ${truncate(newMessage.content || '（yok）')}`,
      verified: false,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onMessageUpdate failed.', err);
  }
}

function truncate(text, n = 400) {
  const t = String(text || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * Ses hareketleri → ses-log.
 * Giriş/çıkış/taşıma/mute/deafen/disconnect.
 * Not: Bu SADECE log — mevcut tasarımda voice koruma kapsamı DIŞIDIR
 * (guard/events.js'te bilinçli kapsam dışı notu var, korundu).
 */
async function onVoiceStateUpdate(client, oldState, newState) {
  try {
    const guild = newState?.guild || oldState?.guild;
    if (!guild) return;
    const user = newState?.member?.user || oldState?.member?.user;
    if (!user || user.bot) return; // botların ses hareketi loglanmaz (kendi trafiği)

    const oldC = oldState?.channelId || null;
    const newC = newState?.channelId || null;
    const oldMute = !!oldState?.selfMute;
    const newMute = !!newState?.selfMute;
    const oldDeaf = !!oldState?.selfDeaf;
    const newDeaf = !!newState?.selfDeaf;
    const serverMute = !!newState?.serverMute;
    const serverDeaf = !!newState?.serverDeaf;

    const bits = [];
    let title = null;
    if (oldC !== newC) {
      if (!oldC && newC) {
        title = 'SES KANALINA GİRİŞ';
        bits.push(`**Girdi:** <#${newC}>`);
      } else if (oldC && !newC) {
        title = 'SES KANALINDAN ÇIKIŞ';
        bits.push(`**Çıktı:** <#${oldC}>`);
      } else {
        title = 'SES KANALI DEĞİŞTİ';
        bits.push(`**Taşındı:** <#${oldC}> → <#${newC}>`);
      }
    }
    if (oldMute !== newMute) {
      title = title || (newMute ? 'KİŞİSEL MUTE' : 'MUTE KALDIRILDI');
      bits.push(`**Mute:** ${newMute ? 'açık' : 'kapalı'}`);
    }
    if (oldDeaf !== newDeaf) {
      title = title || (newDeaf ? 'KİŞİSEL DEAFEN' : 'DEAFEN KALDIRILDI');
      bits.push(`**Deafen:** ${newDeaf ? 'açık' : 'kapalı'}`);
    }
    if (serverMute && !oldState?.serverMute) {
      title = 'SUNUCU MUTE';
      bits.push('**Sunucu mute** uygulandı');
    }
    if (serverDeaf && !oldState?.serverDeaf) {
      title = 'SUNUCU DEAFEN';
      bits.push('**Sunucu deafen** uygulandı');
    }
    if (!bits.length) return; // anlamlı hareket yok → log yok (spam yok)

    await logEvent({
      guild,
      logType: 'voice',
      auditType: null,
      targetId: null,
      title,
      target: { kind: 'user', id: user.id, label: '🔊 Üye' },
      action: `\`${user.username}\` ses hareketi yaptı.`,
      note: bits.join('\n'),
      senderId: user.id,
      verified: false,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onVoiceStateUpdate failed.', err);
  }
}

/** Davet oluşturma → davet-log (critical: asla gruplanmaz). */
async function onInviteCreate(client, invite) {
  try {
    const guild = invite?.guild;
    if (!guild) return;
    await logEvent({
      guild,
      logType: 'invite',
      auditType: AuditLogEvent.InviteCreate,
      targetId: invite.code,
      title: 'DAVET OLUŞTURULDU',
      target: { id: invite.code, label: '📨 Davet Kodu' },
      action: `Davet oluşturuldu: \`${invite.code}\``,
      note: `**Kanal:** <#${invite.channelId}>\n**Süre:** ${invite.maxAge ? `${Math.round(invite.maxAge / 60)} dk` : 'sınırsız'}\n**Kullanım:** ${invite.maxUses || 'sınırsız'}`,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onInviteCreate failed.', err);
  }
}

/** Davet silme → davet-log. */
async function onInviteDelete(client, invite) {
  try {
    const guild = invite?.guild;
    if (!guild) return;
    await logEvent({
      guild,
      logType: 'invite',
      auditType: AuditLogEvent.InviteDelete,
      targetId: invite.code,
      title: 'DAVET SİLİNDİ',
      target: { id: invite.code, label: '📨 Davet Kodu' },
      action: `Davet silindi: \`${invite.code}\``,
      note: `**Kanal:** <#${invite.channelId}>`,
    }).catch(() => {});
  } catch (err) {
    logger.error('Guard onInviteDelete failed.', err);
  }
}

module.exports = {
  onRoleCreate,
  onRoleDelete,
  onRoleUpdate,
  onGuildMemberUpdate,
  onGuildMemberAdd,
  onGuildMemberRemoveBot,
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
  onMessageDelete,
  onMessageDeleteBulk,
  onMessageUpdate,
  onVoiceStateUpdate,
  onInviteCreate,
  onInviteDelete,
  // test/diyagnostik
  diffRole,
  diffChannel,
  diffGuild,
  hashChange,
  isDuplicateEvent,
  isLogChannel,
};
