/**
 * Transcript Service - Ticket mesajlarını çeker, snapshot alır, DB'ye yazar.
 * Kapatma anında tam transcript oluşturur; web viewer snapshot'tan okur.
 */
const { ChannelType, MessageType, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const {
  createTranscript,
  getTranscriptByTicketId,
  getDb,
} = require('../database/database');

const MAX_MESSAGES_PER_FETCH = 100;
const MAX_TOTAL_MESSAGES = 10000;
const ATTACHMENT_ARCHIVE_MAX_SIZE = 25 * 1024 * 1024; // 25MB
const ALLOWED_ARCHIVE_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/'];

/**
 * Kanal mesajlarını sayfalama ile toplar (eskiden yeniye, kronolojik).
 * @returns {Promise<Array>} Message nesneleri (Discord.js Message)
 */
async function fetchAllChannelMessages(channel) {
  const allMessages = [];
  let before = undefined;
  let consecutiveEmpty = 0;

  while (allMessages.length < MAX_TOTAL_MESSAGES) {
    const remaining = MAX_TOTAL_MESSAGES - allMessages.length;
    const limit = Math.min(MAX_MESSAGES_PER_FETCH, remaining);

    try {
      const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
      const arr = [...(batch?.values?.() || [])];

      if (!arr.length) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
        continue;
      }
      consecutiveEmpty = 0;

      allMessages.push(...arr);
      if (arr.length < limit) break;

      before = arr[arr.length - 1].id;
    } catch (err) {
      if (err?.code === 50034 || err?.status === 429) {
        logger.warn(`Transcript fetch rate limited, waiting...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      logger.warn(`Transcript mesaj fetch hatası: ${err.code || err.message}`);
      break;
    }
  }

  return allMessages
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .slice(0, MAX_TOTAL_MESSAGES);
}

/**
 * Kullanıcı snapshot'ı oluşturur (rol renkleri, isimler, avatar).
 */
function buildUserSnapshot(member, guild) {
  if (!member) return null;

  const user = member.user;
  let highestRole = null;
  let roleColor = null;
  let roleName = null;
  const rolesSnapshot = [];

  if (member.roles && member.roles.cache) {
    const roles = [...member.roles.cache.values()]
      .filter(r => r.id !== guild.id) // @everyone hariç
      .sort((a, b) => b.position - a.position);

    if (roles.length > 0) {
      highestRole = roles[0];
      roleColor = highestRole.hexColor === '#000000' ? null : highestRole.hexColor;
      roleName = highestRole.name;
    }

    for (const r of roles.slice(0, 20)) {
      rolesSnapshot.push({
        id: r.id,
        name: r.name,
        color: r.hexColor,
        position: r.position,
      });
    }
  }

  return {
    userId: user.id,
    username: user.username,
    displayName: member.displayName || user.username,
    discriminator: user.discriminator || '0',
    avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256 }),
    bot: user.bot,
    roles: rolesSnapshot,
    roleColor,
    roleName,
  };
}

/**
 * Attachment metadata'sını çıkarır ve arşivlenebilir mi kontrol eder.
 */
function processAttachment(att, transcriptId, messageId) {
  const isImage = att.contentType?.startsWith('image/') ?? false;
  const isVideo = att.contentType?.startsWith('video/') ?? false;
  const isAudio = att.contentType?.startsWith('audio/') ?? false;
  const isText = att.contentType?.startsWith('text/') ?? false;
  const shouldArchive = (isImage || isVideo || isAudio || isText) && (att.size ?? 0) <= ATTACHMENT_ARCHIVE_MAX_SIZE;

  return {
    transcriptId,
    messageId,
    attachmentId: att.id,
    filename: att.name || 'unknown',
    contentType: att.contentType || null,
    size: att.size || 0,
    url: att.url,
    proxyUrl: att.proxyURL || null,
    width: att.width || null,
    height: att.height || null,
    durationSecs: null,
    archived: 0,
    archivedPath: null,
    archivedAt: null,
    _shouldArchive: shouldArchive,
    _isImage: isImage,
    _isVideo: isVideo,
  };
}

/**
 * Embed verisini serialize edilebilir formata çevirir.
 */
function processEmbed(embed) {
  return {
    title: embed.title || null,
    description: embed.description || null,
    url: embed.url || null,
    color: embed.color || null,
    timestamp: embed.timestamp ? new Date(embed.timestamp).getTime() : null,
    footer: embed.footer ? { text: embed.footer.text, iconUrl: embed.footer.iconURL } : null,
    image: embed.image ? { url: embed.image.url, width: embed.image.width, height: embed.image.height } : null,
    thumbnail: embed.thumbnail ? { url: embed.thumbnail.url, width: embed.thumbnail.width, height: embed.thumbnail.height } : null,
    author: embed.author ? { name: embed.author.name, url: embed.author.url, iconUrl: embed.author.iconURL } : null,
    fields: (embed.fields || []).map(f => ({ name: f.name, value: f.value, inline: f.inline })),
    type: embed.type || 'rich',
  };
}

/**
 * Reaction özetini çıkarır.
 */
function processReactions(message) {
  const summary = {};
  try {
    for (const [key, reaction] of message.reactions.cache) {
      summary[key] = reaction.count;
    }
  } catch {}
  return summary;
}

/**
 * Reply/referenced mesaj preview'ı oluşturur.
 */
async function buildReplyPreview(message) {
  if (!message.reference?.messageId) return null;
  try {
    const refMsg = await message.fetchReference().catch(() => null);
    if (!refMsg) return null;
    const author = refMsg.author?.tag || 'Unknown';
    const content = String(refMsg.content || '').slice(0, 100);
    return { author, content: content + (content.length >= 100 ? '…' : ''), messageId: refMsg.id };
  } catch {
    return null;
  }
}

/**
 * Mesajı transcript formatına dönüştürür.
 */
async function processMessage(message, guild, userSnapshots) {
  const member = message.member || (guild ? await guild.members.fetch(message.author.id).catch(() => null) : null);
  const userSnap = userSnapshots.get(message.author.id) || (member ? buildUserSnapshot(member, guild) : {
    userId: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName || message.author.username,
    discriminator: message.author.discriminator || '0',
    avatarUrl: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
    bot: message.author.bot,
    roles: [],
    roleColor: null,
    roleName: null,
  });

  if (member && !userSnapshots.has(message.author.id)) {
    userSnapshots.set(message.author.id, userSnap);
  }

  const attachments = [...(message.attachments?.values?.() || [])].map(a => processAttachment(a, null, message.id));
  const embeds = (message.embeds || []).map(processEmbed);
  const reactions = processReactions(message);
  const replyPreview = await buildReplyPreview(message);

  const stickerItems = [...(message.stickers?.values?.() || [])].map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    formatType: s.formatType,
    url: s.url,
  }));

  return {
    messageId: message.id,
    userId: message.author.id,
    username: userSnap.username,
    displayName: userSnap.displayName,
    discriminator: userSnap.discriminator,
    avatarUrl: userSnap.avatarUrl,
    bot: userSnap.bot ? 1 : 0,
    content: message.content || '',
    cleanedContent: message.cleanContent || '',
    editedAt: message.editedTimestamp || null,
    createdAt: message.createdTimestamp,
    type: message.type || 0,
    replyToId: message.reference?.messageId || null,
    replyPreview: replyPreview ? JSON.stringify(replyPreview) : null,
    attachments: JSON.stringify(attachments),
    embeds: JSON.stringify(embeds),
    reactions: JSON.stringify(reactions),
    stickerItems: JSON.stringify(stickerItems),
    roleColor: userSnap.roleColor ? parseInt(userSnap.roleColor.replace('#', ''), 16) : null,
    roleName: userSnap.roleName || null,
    _attachments: attachments,
  };
}

/**
 * Transcript oluşturur ve DB'ye yazar.
 * @returns {Promise<{transcriptId: string, token: string, webUrl: string}>}
 */
async function generateTranscript(ticket, channel, guild, closedBy) {
  const transcriptExists = getTranscriptByTicketId(ticket.id);
  if (transcriptExists) {
    logger.info(`Ticket #${ticket.id} transcript zaten var: ${transcriptExists.transcript_id}`);
    const webBase2 = (config.web?.baseUrl || process.env.WEB_URL || `http://localhost:${config.web?.port || 3000}`).replace(/\/$/, '');
    return { transcriptId: transcriptExists.transcript_id, token: transcriptExists.token, webUrl: `${webBase2}/transcript/${transcriptExists.transcript_id}?token=${transcriptExists.token}` };
  }

  logger.info(`Ticket #${ticket.id} transcript oluşturuluyor...`);

  const messages = await fetchAllChannelMessages(channel);
  logger.info(`Ticket #${ticket.id}: ${messages.length} mesaj çekildi`);

  const userSnapshots = new Map();
  const processedMessages = [];
  let attachmentCount = 0;
  let imageCount = 0;
  let videoCount = 0;
  let fileCount = 0;

  // Mesajları işle
  for (const msg of messages) {
    try {
      const processed = await processMessage(msg, guild, userSnapshots);
      processedMessages.push(processed);

      for (const att of processed._attachments) {
        attachmentCount++;
        if (att._isImage) imageCount++;
        else if (att._isVideo) videoCount++;
        else fileCount++;
      }
    } catch (err) {
      logger.warn(`Mesaj işlenemedi (${msg.id}): ${err.message}`);
    }
  }

  // Kullanıcı istatistikleri
  const userStats = new Map();
  for (const pm of processedMessages) {
    const u = userStats.get(pm.userId) || { count: 0, first: pm.createdAt, last: pm.createdAt };
    u.count++;
    u.first = Math.min(u.first, pm.createdAt);
    u.last = Math.max(u.last, pm.createdAt);
    userStats.set(pm.userId, u);
  }

  // Web URL oluştur (createTranscript içinde ID üretilir, sonra güncellenir)
  const webBase = (config.web?.baseUrl || process.env.WEB_URL || `http://localhost:${config.web?.port || 3000}`).replace(/\/$/, '');

  // Transcript kaydı oluştur
  const { transcriptId, token } = createTranscript({
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    ticketId: ticket.id,
    ticketOwnerId: ticket.user_id,
    claimedById: ticket.claimed_by,
    closedById: closedBy,
    messageCount: processedMessages.length,
    userCount: userStats.size,
    attachmentCount,
    imageCount,
    videoCount,
    fileCount,
    webUrl: null,
  });
  const webUrl = `${webBase}/transcript/${transcriptId}?token=${token}`;
  try { getDb().prepare('UPDATE transcripts SET web_url = ? WHERE transcript_id = ?').run(webUrl, transcriptId); } catch {}

  const db = getDb();

  // Mesajları toplu ekle
  const insertMsg = db.prepare(
    `INSERT INTO transcript_messages (
      transcript_id, message_id, user_id, username, display_name, discriminator, avatar_url, bot,
      content, cleaned_content, edited_at, created_at, type, reply_to_id, reply_preview,
      attachments, embeds, reactions, sticker_items, role_color, role_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertUser = db.prepare(
    `INSERT INTO transcript_users (transcript_id, user_id, username, display_name, discriminator, avatar_url, bot, roles, message_count, first_message_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transcript_id, user_id) DO UPDATE SET
       message_count = excluded.message_count,
       last_message_at = excluded.last_message_at`
  );

  const insertAttach = db.prepare(
    `INSERT INTO transcript_attachments (
      transcript_id, message_id, attachment_id, filename, content_type, size, url, proxy_url,
      width, height, duration_secs, archived, archived_path, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const pm of processedMessages) {
      insertMsg.run(
        transcriptId,
        pm.messageId,
        pm.userId,
        pm.username,
        pm.displayName,
        pm.discriminator,
        pm.avatarUrl,
        pm.bot,
        pm.content,
        pm.cleanedContent,
        pm.editedAt,
        pm.createdAt,
        pm.type,
        pm.replyToId,
        pm.replyPreview,
        pm.attachments,
        pm.embeds,
        pm.reactions,
        pm.stickerItems,
        pm.roleColor,
        pm.roleName,
      );

      for (const att of pm._attachments) {
        insertAttach.run(
          transcriptId,
          pm.messageId,
          att.attachmentId,
          att.filename,
          att.contentType,
          att.size,
          att.url,
          att.proxyUrl,
          att.width,
          att.height,
          att.durationSecs,
          att._shouldArchive ? 1 : 0,
          null,
          null,
        );
      }
    }

    for (const [userId, snap] of userSnapshots.entries()) {
      const stats = userStats.get(userId);
      insertUser.run(
        transcriptId,
        userId,
        snap.username,
        snap.displayName,
        snap.discriminator,
        snap.avatarUrl,
        snap.bot ? 1 : 0,
        JSON.stringify(snap.roles),
        stats?.count || 0,
        stats?.first || null,
        stats?.last || null,
      );
    }
  });

  tx();
  logger.success(`Ticket #${ticket.id} transcript kaydedildi: ${transcriptId} (${processedMessages.length} mesaj, ${userStats.size} kullanıcı)`);

  return { transcriptId, token, webUrl: `${webBase}/transcript/${transcriptId}?token=${token}` };
}

/**
 * Transcript'i siler (cleanup için).
 */
async function deleteTranscriptByTicket(ticketId) {
  try {
    const t = getTranscriptByTicketId(ticketId);
    if (t) {
      getDb().prepare('DELETE FROM transcripts WHERE transcript_id = ?').run(t.transcript_id);
      logger.info(`Ticket #${ticketId} transcript silindi: ${t.transcript_id}`);
    }
  } catch (err) {
    logger.error(`Transcript silme hatası: ${err.message}`);
  }
}

module.exports = {
  fetchAllChannelMessages,
  buildUserSnapshot,
  processAttachment,
  processEmbed,
  processReactions,
  buildReplyPreview,
  processMessage,
  generateTranscript,
  deleteTranscriptByTicket,
};