/**
 * Ticket yaşam döngüsü: oluşturma / sahiplenme / kapatma / silme / kullanıcı ekleme / yetkili çağırma.
 * Tüm buton customId'leri statiktir → restart-safe (ticket, kanal ID üzerinden DB'den çözülür).
 */
const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { canManageTickets } = require('../utils/permissions');
const { buildErrorEmbed } = require('../utils/embeds');
const {
  createTicket,
  getTicket,
  getTicketByChannel,
  getOpenTicket,
  countOpenTickets,
  setTicketChannel,
  setTicketPanelMessage,
  setTicketLogMessage,
  getApprovedIc,
  claimTicket,
  closeTicket,
  setTicketDecision,
  deleteTicket,
  getAllTickets,
  incrementClaimStat,
} = require('../database/database');
const {
  getCategoryByKey,
  sanitizeChannelName,
  buildOpenTicketEmbed,
  buildTicketButtons,
  buildConfirmEmbed,
  buildConfirmRow,
  buildCategoryFormEmbed,
  buildAddUserRow,
  buildLogEmbed,
  buildTranscriptRow,
} = require('../utils/ticketEmbeds');
const { checkRoleAction, reasonText } = require('./roleHandler');
const { fetchChannelMessages, buildTranscriptFile } = require('../utils/transcript');
let transcriptService = null;
try { transcriptService = require('../services/transcriptService'); } catch { transcriptService = null; }

const EPH = (extra = {}) => ({ flags: MessageFlags.Ephemeral, ...extra });

// Sabit staff ticket rolü — her ticket kanalında FULL erişim
const STAFF_TICKET_ROLE_ID = config.STAFF_TICKET_ROLE_ID || '1522773972393922730';
let _guardTracker = null;
try { _guardTracker = require('../guard/tracker'); } catch { _guardTracker = null; }

function markTicketGuard(guildId, channelId) {
  try { _guardTracker?.markBotAction?.(guildId, 'CHANNEL_OVERWRITE_CREATE', channelId, 'ticket-staff-perm'); } catch {}
  try { _guardTracker?.markBotAction?.(guildId, 'CHANNEL_OVERWRITE_UPDATE', channelId, 'ticket-staff-perm'); } catch {}
  try { _guardTracker?.markBotAction?.(guildId, 'CHANNEL_CREATE', channelId, 'ticket-create'); } catch {}
}

// ---------- Yardımcılar ----------

async function resolveStaffRole(guild) {
  const id = config.ticket.staffRoleId || STAFF_TICKET_ROLE_ID;
  if (!id) return null;
  try {
    return (await guild.roles.fetch(id).catch(() => null)) || null;
  } catch {
    return null;
  }
}

async function resolveStaffTicketRole(guild) {
  const id = STAFF_TICKET_ROLE_ID;
  if (!id) return null;
  try {
    return (await guild.roles.fetch(id).catch(() => null)) || null;
  } catch {
    return null;
  }
}

async function resolveCategory(guild) {
  const id = config.ticket.categoryId;
  if (!id) return null;
  try {
    const ch = await guild.channels.fetch(id).catch(() => null);
    return ch && ch.type === ChannelType.GuildCategory ? ch : null;
  } catch {
    return null;
  }
}

async function sendLog(guild, event, data, files, transcriptUrl) {
  try {
    if (!config.ticket.logEnabled) return;
    const id = config.ticket.logChannelId;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`Ticket log kanalı bulunamadı veya metin kanalı değil: ${id}`);
      return;
    }

    const components = transcriptUrl ? (() => { const r = buildTranscriptRow(transcriptUrl); return r ? [r] : []; })() : [];
    const payload = { embeds: [buildLogEmbed(event, data)], ...(files?.length ? { files } : {}), ...(components.length ? { components } : {}) };
    const ticketId = data?.ticketId;
    const knownId = data?.logMessageId || (ticketId ? getTicket(ticketId)?.log_message_id : null);
    if (knownId) {
      try {
        const msg = await ch.messages.fetch(knownId).catch(() => null);
        if (msg) {
          await msg.edit(payload);
          return;
        }
      } catch {
        /* düşerse alta inip yenisi gönderilir */
      }
      logger.warn(`Ticket #${ticketId} log mesajı bulunamadı, yenisi gönderiliyor.`);
    }
    const sent = await ch.send(payload);
    if (ticketId && sent?.id) {
      try {
        setTicketLogMessage(ticketId, sent.id);
      } catch {
        /* log ID saklanamadı — sonraki işlem yeni mesaj gönderir */
      }
    }
  } catch (err) {
    logger.warn(`Ticket log gönderilemedi: ${err.code || err.message}`);
  }
}

/** Ticket kanalının transkript dosyasını üretir; başarısızsa null döner (log dosyasız gider). */
async function collectTranscript(ticket, channel, guildName, statusText) {
  try {
    const messages = await fetchChannelMessages(channel);
    const file = buildTranscriptFile(ticket, messages, { guildName, statusText });
    return file ? [file.attachment] : [];
  } catch (err) {
    logger.warn(`Ticket #${ticket?.id} transkripti alınamadı: ${err.code || err.message}`);
    return [];
  }
}

/** Etkileşimin geldiği kanalın ticket kaydını bulur; yoksa ephemeral bilgi verip null döner. */
async function getTicketOrReply(interaction) {
  const channelId = interaction.channelId;
  const ticket = channelId ? getTicketByChannel(channelId) : null;
  if (!ticket) {
    await interaction
      .reply({ embeds: [buildErrorEmbed('Bu kanal bir ticket olarak kayıtlı değil.')], ...EPH() })
      .catch(() => {});
    return null;
  }
  return ticket;
}

async function requireStaff(interaction) {
  if (canManageTickets(interaction.member)) return true;
  await interaction
    .reply({ embeds: [buildErrorEmbed('Bu işlem için ticket yetkilisi olmalısınız.')], ...EPH() })
    .catch(() => {});
  return false;
}

function isOwnerOrStaff(ticket, interaction) {
  return ticket.user_id === interaction.user.id || canManageTickets(interaction.member);
}

// ---------- Ticket oluşturma (select menüden) ----------

async function createTicketFromSelect(interaction, categoryKey) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ embeds: [buildErrorEmbed('Ticket yalnızca sunucu içinde açılabilir.')], ...EPH() });
  }

  const category = getCategoryByKey(categoryKey);
  if (!category) {
    return interaction.reply({ embeds: [buildErrorEmbed('Geçersiz kategori. Lütfen tekrar deneyin.')], ...EPH() });
  }

  await interaction.deferReply({ ...EPH() });

  try {
    // Duplicate engeli: kullanıcı başına açık ticket limiti
    const openCount = countOpenTickets(guild.id, interaction.user.id);
    if (openCount >= Math.max(1, config.ticket.maxOpenPerUser)) {
      const existing = getOpenTicket(guild.id, interaction.user.id);
      return interaction.editReply({
        embeds: [
          buildErrorEmbed(
            existing
              ? `Zaten açık bir ticket’ınız var: <#${existing.channel_id}>\nÖnce onu kapatın veya kullanın.`
              : 'Zaten açık bir ticket’ınız var. Önce onu kapatın veya kullanın.',
          ),
        ],
      });
    }

    // Bot yetkisi ön kontrolü
    const me = guild.members.me;
    if (me && !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply({
        embeds: [buildErrorEmbed('Ticket kanalı oluşturamıyorum — bota **Kanalları Yönet** yetkisi verin.')],
      });
    }

    const staffRole = await resolveStaffRole(guild);
    if ((config.ticket.staffRoleId || STAFF_TICKET_ROLE_ID) && !staffRole) {
      logger.warn(`TICKET_STAFF_ROLE_ID bulunamadı: ${config.ticket.staffRoleId || STAFF_TICKET_ROLE_ID} (ticket yine de açılacak)`);
      // Spec 14: loga yaz
      try {
        const logChId = config.ticket.logChannelId || config.guard?.logChannelId;
        if (logChId) {
          const lc = await guild.channels.fetch(logChId).catch(() => null);
          if (lc?.isTextBased()) await lc.send(`⚠️ **TICKET STAFF ROLE NOT FOUND**\nRole ID: \`${STAFF_TICKET_ROLE_ID}\`\nTicket #? oluşturulurken rol bulunamadı.`).catch(() => {});
        }
      } catch {}
    }
    const parent = await resolveCategory(guild);
    if (config.ticket.categoryId && !parent) {
      logger.warn(`TICKET_CATEGORY_ID geçersiz: ${config.ticket.categoryId} (ticket kategorisiz açılacak)`);
    }

    // ID'yi önceden rezerve et → düzgün kanal adı için gerekli
    const pending = `pending-${guild.id}-${interaction.user.id}-${Date.now()}`;
    const ticketId = createTicket({
      guildId: guild.id,
      userId: interaction.user.id,
      channelId: pending,
      panelMessageId: null,
      categoryKey: category.key,
      categoryLabel: category.label,
    });

    // --- Permission overwrites: deduplicated Map (son yazan kazanır, staff FULL) ---
    const overwritesMap = new Map();
    const addOverwrite = (id, data) => { if (id) overwritesMap.set(String(id), { id: String(id), ...data }); };
    addOverwrite(guild.roles.everyone.id, { deny: [PermissionFlagsBits.ViewChannel] });
    addOverwrite(interaction.user.id, {
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    });
    addOverwrite(interaction.client.user.id, {
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    });

    // SABIT STAFF TICKET ROLE — her ticketta FULL erişim (spec 3)
    const staffTicketRole = await resolveStaffTicketRole(guild);
    if (!staffTicketRole) {
      logger.error(`⚠️ TICKET STAFF ROLE NOT FOUND — Role ID: ${STAFF_TICKET_ROLE_ID} (guild ${guild.id})`);
      try {
        const logChId = config.ticket.logChannelId;
        if (logChId) {
          const lc = await guild.channels.fetch(logChId).catch(() => null);
          if (lc?.isTextBased()) await lc.send(`⚠️ **TICKET STAFF ROLE NOT FOUND**\nRole ID: \`${STAFF_TICKET_ROLE_ID}\`\nTicket açılışında staff erişimi verilemedi.`).catch(() => {});
        }
      } catch {}
    } else {
      // Bot hiyerarşi ve ManageChannels kontrolü (spec 15)
      const me = guild.members.me;
      if (me && staffTicketRole.position >= me.roles.highest.position) {
        logger.warn(`Staff ticket rolü botun rolünden yüksek/eşit (${staffTicketRole.position} >= ${me.roles.highest.position}) — permission verilemeyebilir.`);
      }
      if (me && !me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        logger.warn(`Botun ManageChannels/ManageRoles yetkisi yok — staff overwrite uygulanamayabilir.`);
      }
      addOverwrite(staffTicketRole.id, {
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages],
      });
    }
    // Legacy staffRole (farklıysa ayrıca ekle, aynıysa zaten eklendi)
    if (staffRole && String(staffRole.id) !== String(STAFF_TICKET_ROLE_ID)) {
      addOverwrite(staffRole.id, {
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
      });
    }

    // Görüntüleyici rol (salt-okunur) — staff ile aynıysa SKIP (staff FULL kazanır, downgrade yok)
    const viewerRoleId = config.ticket.viewerRoleId;
    if (viewerRoleId && String(viewerRoleId) !== String(STAFF_TICKET_ROLE_ID)) {
      try {
        const viewerRole = await guild.roles.fetch(viewerRoleId).catch(() => null);
        if (viewerRole) {
          addOverwrite(viewerRole.id, { allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
        } else {
          logger.warn(`TICKET_VIEWER_ROLE_ID bulunamadı: ${viewerRoleId} (görüntüleme izni verilmedi)`);
        }
      } catch (err) {
        logger.warn(`Görüntüleyici rol çözülemedi: ${err.code || err.message}`);
      }
    } else if (viewerRoleId && String(viewerRoleId) === String(STAFF_TICKET_ROLE_ID)) {
      logger.debug('Viewer rol staff ile aynı — viewer overwrite skip (staff FULL korunuyor).');
    }

    const overwrites = [...overwritesMap.values()];

    let channel;
    try {
      // Guard internal tracking — botun ticket oluşturması saldırı sayılmasın (spec 19)
      markTicketGuard(guild.id, `pending-${ticketId}`);
      channel = await guild.channels.create({
        name: sanitizeChannelName(interaction.user.username, ticketId),
        type: ChannelType.GuildText,
        ...(parent ? { parent: parent.id } : {}),
        topic: `Ticket #${ticketId} • ${category.label} • Sahip: ${interaction.user.tag}`.slice(0, 1024),
        permissionOverwrites: overwrites,
      });
      markTicketGuard(guild.id, channel.id);
    } catch (err) {
      deleteTicket(ticketId); // yetim satır bırakma
      logger.error(`Ticket kanalı oluşturulamadı (ticket #${ticketId}).`, err);
      const msg =
        err?.code === 50013 || err?.status === 403
          ? 'Ticket kanalı oluşturamadım — bota **Kanalları Yönet** yetkisi verin ve kategori izinlerini kontrol edin.'
          : 'Ticket kanalı oluşturulurken bir hata oluştu. Lütfen tekrar deneyin.';
      return interaction.editReply({ embeds: [buildErrorEmbed(msg)] });
    }

    setTicketChannel(ticketId, channel.id);

    // Kanal oluşturulduktan sonra İKİNCİ DOĞRULAMA (spec 4): gerçek permission state kontrolü + retry
    await ensureStaffTicketAccess(channel, { verify: true, retry: 1 });
    // Görüntüleyici rolünü kesinlikle uygula (güvenlik ağı) — staff ile aynıysa skip zaten
    await ensureTicketViewerRole(channel);
    // Kategori miras kontrolü (spec 6): kategori varsa staff için View izni ver (kanal overwrite zaten var ama kategori de düzelsin)
    if (parent) {
      try {
        const catRoleOv = parent.permissionOverwrites.cache.get(STAFF_TICKET_ROLE_ID);
        const hasCatView = catRoleOv?.allow?.has?.(PermissionFlagsBits.ViewChannel);
        if (!hasCatView) {
          // Sadece kategori seviyesinde eksikse ekle, kanal overwrite'ı zaten var
          await parent.permissionOverwrites.edit(STAFF_TICKET_ROLE_ID, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }, 'Ticket kategori staff erişimi').catch(() => {});
          logger.debug(`Kategori ${parent.id} staff overwrite eklendi/güncellendi.`);
        }
      } catch (e) {
        logger.debug(`Kategori staff overwrite kontrolü atlandı: ${e.message}`);
      }
    }

    // Açık ticket paneli (+ ayarlıysa ekip rolü etiketi — bildirim garantili:
    // rol mention'a kapalıysa geçici açılır, mesaj sonrası eski haline döndürülür)
    const createdUnix = Math.floor(Date.now() / 1000);
    const pingRole = config.ticket.pingRoleId;
    let mentionableOpened = false;
    if (pingRole) {
      try {
        const role = await guild.roles.fetch(pingRole).catch(() => null);
        if (!role) {
          logger.warn(`Ping rolü bulunamadı: ${pingRole} (etiket yine de denenecek)`);
        } else if (!role.mentionable) {
          await role.setMentionable(true, 'Ticket açılış pingi');
          mentionableOpened = true;
        }
      } catch (err) {
        logger.warn(`Rol mention hazırlığı başarısız: ${err.code || err.message} (etiket yine de denenecek)`);
      }
    }
    try {
      const panelMsg = await channel.send({
        content: `<@${interaction.user.id}>${pingRole ? ` <@&${pingRole}>` : ''}`,
        allowedMentions: { users: [interaction.user.id], ...(pingRole ? { roles: [pingRole] } : {}) },
        embeds: [
          buildOpenTicketEmbed({
            guild,
            userId: interaction.user.id,
            categoryLabel: category.label,
            createdUnix,
            status: 'open',
            claimedBy: null,
          }),
        ],
        components: buildTicketButtons('open', category.key, null),
      });
      setTicketPanelMessage(ticketId, panelMsg.id);
    } catch (err) {
      await channel.delete(`Ticket #${ticketId} panel gönderimi başarısız (temizlik)`).catch(() => {});
      deleteTicket(ticketId);
      logger.error(`Ticket paneli gönderilemedi (ticket #${ticketId}).`, err);
      return interaction.editReply({ embeds: [buildErrorEmbed('Ticket paneli gönderilemedi. Lütfen tekrar deneyin.')] });
    } finally {
      // Geçici açılan mention izni HER HALDE geri kapatılır
      if (mentionableOpened && pingRole) {
        try {
          const role = await guild.roles.fetch(pingRole).catch(() => null);
          if (role) await role.setMentionable(false, 'Ticket pingi tamamlandı').catch(() => {});
        } catch {
          /* sessiz geç */
        }
      }
    }

    // Kategoriye özel form (örn. başvuru soruları) — ayrı mesaj olarak gönderilir.
    // Gönderilemezse ticket yine de açılmış sayılır (kritik değil, sadece uyar).
    try {
      const formEmbed = buildCategoryFormEmbed(category);
      if (formEmbed) await channel.send({ embeds: [formEmbed] });
    } catch (err) {
      logger.warn(`Ticket #${ticketId} form mesajı gönderilemedi: ${err.code || err.message}`);
    }

    logger.success(`Ticket #${ticketId} açıldı: #${channel.name} (${interaction.user.tag}, ${category.label}) • rol ping: ${pingRole || 'kapalı'}`);
    await sendLog(guild, 'created', {
      ticketId,
      userId: interaction.user.id,
      categoryLabel: category.label,
      channelId: channel.id,
      actorId: interaction.user.id,
    });

    return interaction.editReply({ content: `✅ Ticket oluşturuldu: <#${channel.id}>` });
  } catch (err) {
    logger.error('Interaction failed: ticket oluşturma.', err);
    return interaction.editReply({ embeds: [buildErrorEmbed('Ticket oluşturulurken bir hata oluştu.')] }).catch(() => {});
  }
}

// ---------- Buton yönlendirici ----------

async function handleTicketButton(interaction) {
  const { customId } = interaction;
  try {
    switch (customId) {
      case 'ticket_claim':
        return handleClaim(interaction);
      case 'ticket_close':
        return handleCloseRequest(interaction);
      case 'ticket_close_yes':
        return handleCloseConfirm(interaction, true);
      case 'ticket_close_no':
        return handleCloseConfirm(interaction, false);
      case 'ticket_delete':
        return handleDeleteRequest(interaction);
      case 'ticket_delete_yes':
        return handleDeleteConfirm(interaction, true);
      case 'ticket_delete_no':
        return handleDeleteConfirm(interaction, false);
      case 'ticket_adduser':
        return handleAddUserRequest(interaction);
      case 'ticket_accept':
        return handleAcceptRequest(interaction);
      case 'ticket_reject':
        return handleReject(interaction);
      case 'ticket_call':
        // Kaldırılan özellik: eski panellerde buton hâlâ görünebilir
        await interaction
          .reply({ content: 'ℹ️ Yetkili Çağır özelliği kaldırıldı. Gerekirse kanala yazarak yetkililere ulaşın.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return true;
      default:
        return false;
    }
  } catch (err) {
    if (err?.code === 10062) {
      logger.error(`Interaction EXPIRED: [buton:${customId}] — kullanıcı "Uygulama yanıt vermedi" gördü.`);
      return true;
    }
    logger.error(`Interaction failed: button ${customId}`, err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], ...EPH() });
      } else if (interaction.isRepliable()) {
        await interaction.reply({ embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], ...EPH() });
      }
    } catch {
      /* sessiz geç */
    }
    return true;
  }
}

// ---------- Sahiplen ----------

async function handleClaim(interaction) {
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Bu ticket zaten kapalı.', ...EPH() }).catch(() => {});
    return true;
  }

  // Başkasının sahiplendiği ticket tekrar sahiplenilemez
  if (ticket.claimed_by) {
    const owner = String(ticket.claimed_by);
    const me = String(interaction.user.id);
    if (owner === me) {
      await interaction.deferReply({ ...EPH() });
      await interaction.editReply({ content: 'ℹ️ Bu ticket zaten sizin tarafınızdan sahiplenilmiş.' }).catch(() => {});
      return true;
    }
    await interaction.reply({ content: `❌ Bu ticket zaten <@${owner}> tarafından sahiplenilmiş. Başka bir yetkili sahiplenemez.`, ...EPH() }).catch(() => {});
    return true;
  }

  await interaction.deferReply({ ...EPH() });
  const prevClaimedBy = ticket.claimed_by ? String(ticket.claimed_by) : null;
  claimTicket(ticket.id, interaction.user.id);
  // İstatistik SADECE gerçek yeni sahiplenmede +1 (aynı kişinin tekrarı sayılmaz).
  if (prevClaimedBy !== String(interaction.user.id)) {
    try {
      incrementClaimStat(interaction.guildId, interaction.user.id);
    } catch {
      /* istatistik claim akışını engellemez */
    }
  }

  const embed = buildOpenTicketEmbed({
    guild: interaction.guild,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    createdUnix: Math.floor(ticket.created_at / 1000),
    status: 'claimed',
    claimedBy: interaction.user.id,
  });
  await refreshPanel(interaction, ticket, embed, buildTicketButtons('open', ticket.category_key, ticket.decision));
  // Spec 12: claim staff overwrite'ı silmemeli — doğrula, eksikse düzelt (sessiz)
  try { await ensureStaffTicketAccess(interaction.channel, { verify: false, retry: 0 }); } catch {}
  // Guard: panel edit saldırgan sayılmasın
  markTicketGuard(interaction.guildId, ticket.channel_id);
  logger.success(`Ticket #${ticket.id} sahiplenildi: ${interaction.user.tag}`);
  await sendLog(interaction.guild, 'claimed', {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
  });
  await interaction.editReply({ content: `🧑‍💼 Ticket’ı sahiplendiniz.` }).catch(() => {});
  return true;
}

// ---------- Kapatma ----------

async function handleCloseRequest(interaction) {
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (!isOwnerOrStaff(ticket, interaction)) {
    await interaction.reply({ embeds: [buildErrorEmbed('Bu ticketı yalnızca sahibi veya yetkililer kapatabilir.')], ...EPH() }).catch(() => {});
    return true;
  }
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Bu ticket zaten kapalı.', ...EPH() }).catch(() => {});
    return true;
  }
  await interaction
    .reply({ embeds: [buildConfirmEmbed('close')], components: [buildConfirmRow('close')] })
    .catch(() => {});
  return true;
}

async function handleCloseConfirm(interaction, approved) {
  const confirmMsg = interaction.message;
  if (!approved) {
    await confirmMsg?.delete().catch(() => {});
    await interaction.reply({ content: '❌ Kapatma iptal edildi.', ...EPH() }).catch(() => {});
    return true;
  }

  const ticket = await getTicketOrReply(interaction);
  if (!ticket) {
    await confirmMsg?.delete().catch(() => {});
    return true;
  }
  if (!isOwnerOrStaff(ticket, interaction)) {
    await interaction.reply({ embeds: [buildErrorEmbed('Bu ticketı yalnızca sahibi veya yetkililer kapatabilir.')], ...EPH() }).catch(() => {});
    return true;
  }
  if (ticket.status === 'closed') {
    await confirmMsg?.delete().catch(() => {});
    await interaction.reply({ content: '⚫ Bu ticket zaten kapalı.', ...EPH() }).catch(() => {});
    return true;
  }

  await interaction.deferReply({ ...EPH() });
  closeTicket(ticket.id, interaction.user.id);

  // Sahibin yazma yetkisini kaldır (okumaya devam edebilir) — spec 13: staff bozma, sadece owner
  try {
    markTicketGuard(interaction.guildId, interaction.channelId);
    await interaction.channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false });
    markTicketGuard(interaction.guildId, interaction.channelId);
    // Staff erişimi kapanışta korunmalı (kapatılmış ticket transcript için staff görmeli)
    await ensureStaffTicketAccess(interaction.channel, { verify: false, retry: 0 }).catch(() => {});
  } catch (err) {
    logger.warn(`Ticket #${ticket.id} yazma kilidi verilemedi: ${err.code || err.message}`);
  }

  const embed = buildOpenTicketEmbed({
    guild: interaction.guild,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    createdUnix: Math.floor(ticket.created_at / 1000),
    status: 'closed',
    claimedBy: ticket.claimed_by,
  });
  await refreshPanel(interaction, ticket, embed, buildTicketButtons('closed', ticket.category_key, ticket.decision));
  await confirmMsg?.delete().catch(() => {});

  logger.success(`Ticket #${ticket.id} kapatıldı (${interaction.user.tag})`);
  const closedFiles = await collectTranscript(ticket, interaction.channel, interaction.guild?.name, 'Kapalı');
  const freshClosed = getTicket(ticket.id) || ticket; // güncel claimed/closed bilgileri
  let transcriptUrl = null;
  if (transcriptService) {
    try {
      const res = await transcriptService.generateTranscript(freshClosed, interaction.channel, interaction.guild, interaction.user.id);
      transcriptUrl = res.webUrl;
      logger.success(`Ticket #${ticket.id} web transcript: ${transcriptUrl}`);
    } catch (err) {
      logger.warn(`Ticket #${ticket.id} web transcript oluşturulamadı: ${err.message}`);
    }
  }
  await sendLog(interaction.guild, 'closed', {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
    claimedBy: freshClosed.claimed_by ? String(freshClosed.claimed_by) : null,
    closedBy: freshClosed.closed_by ? String(freshClosed.closed_by) : String(interaction.user.id),
    closedAt: freshClosed.closed_at || Date.now(),
    ...(closedFiles.length ? { extra: '📄 Transkript dosyası eklendi.' } : {}),
    ...(transcriptUrl ? { extra: (closedFiles.length ? '📄 Transkript dosyası eklendi. ' : '') + '📖 Web transcript hazır.' } : {}),
  }, closedFiles, transcriptUrl);
  await interaction.editReply({ content: transcriptUrl ? `🔒 Ticket kapatıldı. [📖 Transcript Aç](${transcriptUrl})` : '🔒 Ticket kapatıldı.' }).catch(() => {});
  return true;
}

// ---------- Silme (sadece yetkili) ----------

async function handleDeleteRequest(interaction) {
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  await interaction
    .reply({ embeds: [buildConfirmEmbed('delete')], components: [buildConfirmRow('delete')] })
    .catch(() => {});
  return true;
}

async function handleDeleteConfirm(interaction, approved) {
  const confirmMsg = interaction.message;
  if (!approved) {
    await confirmMsg?.delete().catch(() => {});
    await interaction.reply({ content: '❌ Silme iptal edildi.', ...EPH() }).catch(() => {});
    return true;
  }
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) {
    await confirmMsg?.delete().catch(() => {});
    return true;
  }

  await interaction.deferReply({ ...EPH() });
  const { channel } = interaction;

  // Transkript kanal silinmeden ÖNCE alınmalı
  const deletedFiles = await collectTranscript(ticket, channel, interaction.guild?.name, 'Silindi');
  let deleteTranscriptUrl = null;
  if (transcriptService) {
    try {
      const res = await transcriptService.generateTranscript(ticket, channel, interaction.guild, interaction.user.id);
      deleteTranscriptUrl = res.webUrl;
    } catch (err) {
      logger.warn(`Ticket #${ticket.id} silme transcript hatası: ${err.message}`);
    }
  }

  const info = {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
    logMessageId: ticket.log_message_id || null, // satır silinmeden önce yakala
    ...(deletedFiles.length || deleteTranscriptUrl ? { extra: `${deletedFiles.length ? '📄 Transkript dosyası eklendi.' : ''}${deleteTranscriptUrl ? ' 📖 Web transcript hazır.' : ''}`.trim() } : {}),
  };

  try {
    await channel.delete(`Ticket #${ticket.id} silindi (${interaction.user.tag})`);
  } catch (err) {
    if (err?.code === 10003) {
      logger.warn(`Ticket #${ticket.id} kanalı zaten yok, DB kaydı temizleniyor.`);
    } else {
      logger.error(`Ticket #${ticket.id} kanalı silinemedi.`, err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Kanal silinemedi — botun **Kanalları Yönet** yetkisini kontrol edin.')] }).catch(() => {});
      return true;
    }
  }

  deleteTicket(ticket.id);
  logger.success(`Ticket #${ticket.id} silindi (${interaction.user.tag})`);
  await sendLog(interaction.guild, 'deleted', info, deletedFiles, deleteTranscriptUrl);
  // Kanal silindiği için editReply başarısız olabilir — önemli değil
  await interaction.editReply({ content: '🗑️ Ticket silindi.' }).catch(() => {});
  return true;
}

// ---------- Kullanıcı ekleme (sadece yetkili) ----------

async function handleAddUserRequest(interaction) {
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Kapalı ticket’a kullanıcı eklenemez.', ...EPH() }).catch(() => {});
    return true;
  }
  await interaction.reply({ content: '👤 Ticket’a eklenecek kullanıcıyı seçin:', components: [buildAddUserRow()], ...EPH() }).catch(() => {});
  return true;
}

async function handleAddUserSelect(interaction) {
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Kapalı ticket’a kullanıcı eklenemez.', ...EPH() }).catch(() => {});
    return true;
  }

  const targetId = interaction.values?.[0];
  if (!targetId) {
    await interaction.reply({ embeds: [buildErrorEmbed('Kullanıcı seçilemedi.')], ...EPH() }).catch(() => {});
    return true;
  }

  await interaction.deferUpdate().catch(() => {});
  try {
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!member) {
      await interaction.followUp({ embeds: [buildErrorEmbed('Kullanıcı sunucuda bulunamadı.')], ...EPH() }).catch(() => {});
      return true;
    }
    if (member.user.bot) {
      await interaction.followUp({ embeds: [buildErrorEmbed('Botlar ticket’a eklenemez.')], ...EPH() }).catch(() => {});
      return true;
    }
    await interaction.channel.permissionOverwrites.edit(targetId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    logger.success(`Ticket #${ticket.id} kullanıcısı eklendi: ${member.user.tag} (${interaction.user.tag} ekledi)`);
    await sendLog(interaction.guild, 'user_added', {
      ticketId: ticket.id,
      userId: ticket.user_id,
      categoryLabel: ticket.category_label,
      channelId: ticket.channel_id,
      actorId: interaction.user.id,
      extra: `Eklenen: ${member.user.tag}`,
    });
    await interaction.channel.send({ content: `👤 <@${targetId}> ticket’a eklendi.` }).catch(() => {});
    await interaction.followUp({ content: `✅ <@${targetId}> ticket’a eklendi.`, ...EPH() }).catch(() => {});
  } catch (err) {
    logger.error(`Ticket #${ticket.id} kullanıcı ekleme başarısız.`, err);
    await interaction.followUp({ embeds: [buildErrorEmbed('Kullanıcı eklenemedi. Bot yetkilerini kontrol edin.')], ...EPH() }).catch(() => {});
  }
  return true;
}

// ---------- Başvuru kabul / ret (sadece basvuru kategorisi) ----------

function isBasvuru(ticket) {
  return String(ticket?.category_key || '') === 'basvuru';
}

function decisionText(decision, decidedBy) {
  const what = decision === 'accepted' ? 'kabul edilmiş' : 'reddedilmiş';
  return decidedBy ? `Bu başvuru zaten ${what} (<@${decidedBy}>).` : `Bu başvuru zaten ${what}.`;
}

async function handleAcceptRequest(interaction) {
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Bu ticket zaten kapalı.', ...EPH() }).catch(() => {});
    return true;
  }
  if (!isBasvuru(ticket)) {
    await interaction
      .reply({ embeds: [buildErrorEmbed('Kabul/Ret butonları yalnızca başvuru ticketlarında kullanılabilir.')], ...EPH() })
      .catch(() => {});
    return true;
  }
  if (ticket.decision) {
    await interaction.reply({ content: `ℹ️ ${decisionText(ticket.decision, ticket.decided_by)}`, ...EPH() }).catch(() => {});
    return true;
  }
  await interaction.deferReply({ ...EPH() });

  // Çift tıklama yarışı: ilk karar kazanır
  const fresh = getTicket(ticket.id) || ticket;
  if (fresh.decision) {
    await interaction.editReply({ content: `ℹ️ ${decisionText(fresh.decision, fresh.decided_by)}` }).catch(() => {});
    return true;
  }

  const guild = interaction.guild;
  const me = guild.members.me;
  const owner = await guild.members.fetch(ticket.user_id).catch(() => null);
  if (!owner) {
    await interaction.editReply({ embeds: [buildErrorEmbed('Ticket sahibi sunucuda bulunamadı — rol ve isim verilemedi.')] }).catch(() => {});
    return true;
  }

  // Otomatik değerler (girdi YOK):
  // - KOD = ticket numarası
  // - IC İSİM = üyenin onaylı IC kaydı varsa o, yoksa mevcut görünen adı
  const kod = String(ticket.id);
  let isim = owner.displayName;
  let isimKaynak = 'görünen ad';
  try {
    const approved = getApprovedIc(guild.id, owner.id);
    const txt = String(approved?.requested_text || '').trim().replace(/\s+/g, ' ');
    if (txt) {
      isim = txt.slice(0, 60);
      isimKaynak = 'onaylı IC kaydı';
    }
  } catch {
    /* kayda ulaşılamazsa görünen ad kullanılır */
  }

  // Roller (config.ticket.acceptRoleIds) — /rolver ile aynı yetki motoru
  const roleIds = (config.ticket.acceptRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id)));
  const added = [];
  const skipped = [];
  const failed = [];
  for (const roleId of roleIds) {
    const rid = String(roleId);
    let role = null;
    try {
      role = await guild.roles.fetch(rid).catch(() => null);
    } catch {
      role = null;
    }
    if (!role) {
      failed.push(`\`${rid}\` (rol bulunamadı)`);
      continue;
    }
    const check = checkRoleAction({
      executor: interaction.member,
      target: owner,
      role,
      me,
      guildId: guild.id,
      guildOwnerId: guild.ownerId,
      action: 'add',
    });
    if (!check.ok) {
      if (check.reason === 'already') skipped.push(`<@&${rid}>`);
      else failed.push(`<@&${rid}> (${reasonText(check.reason)})`);
      continue;
    }
    try {
      await owner.roles.add(rid, `Başvuru kabulü (ticket #${ticket.id}, ${interaction.user.tag})`);
      added.push(`<@&${rid}>`);
    } catch (err) {
      logger.warn(`Ticket #${ticket.id} rol verilemedi (${rid}): ${err.code || err.message}`);
      failed.push(`<@&${rid}> (Discord hatası)`);
    }
  }

  // Takma isim: "KOD - IC İSİM"
  const nick = formatNickname(kod, isim);
  let nickOk = false;
  let nickWhy = '';
  try {
    if (!me?.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
      nickWhy = 'botta **Takma Adları Yönet** yetkisi yok';
    } else if (owner.id === guild.ownerId) {
      nickWhy = 'sunucu sahibinin ismi değiştirilemez';
    } else if ((me.roles?.highest?.position ?? 0) <= (owner.roles?.highest?.position ?? 0)) {
      nickWhy = 'botun rolü yetersiz (bot rolü üyenin rolünden üstte olmalı)';
    } else {
      await owner.setNickname(nick, `Başvuru kabulü (ticket #${ticket.id}, ${interaction.user.tag})`);
      nickOk = true;
    }
  } catch (err) {
    logger.warn(`Ticket #${ticket.id} isim değiştirilemedi: ${err.code || err.message}`);
    nickWhy = 'Discord hatası';
  }

  // Karar HER HALDE kaydedilir (yetkili kararı verilmiştir); sonuçlar raporlanır
  try {
    setTicketDecision(ticket.id, 'accepted', interaction.user.id);
  } catch {
    /* kayıt hatası akışı engellemez */
  }
  const updated = getTicket(ticket.id) || { ...ticket, decision: 'accepted', decided_by: interaction.user.id };
  const embed = buildOpenTicketEmbed({
    guild,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    createdUnix: Math.floor(ticket.created_at / 1000),
    status: ticket.status === 'closed' ? 'closed' : updated.claimed_by ? 'claimed' : 'open',
    claimedBy: updated.claimed_by || null,
  });
  await refreshPanel(interaction, updated, embed, buildTicketButtons('open', ticket.category_key, 'accepted'));
  markTicketGuard(interaction.guildId, ticket.channel_id);

  logger.success(`Ticket #${ticket.id} başvuru kabul edildi (${interaction.user.tag}): roller [${added.length}] isim "${nick}"`);
  await sendLog(guild, 'accepted', {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
    extra: `Roller: ${added.length ? added.join(' ') : '—'}${skipped.length ? ` (zaten vardı: ${skipped.join(' ')})` : ''}${failed.length ? ` | Başarısız: ${failed.join(' ')}` : ''} • İsim: \`${nick}\` (${isimKaynak})${nickOk ? '' : ` (verilemedi: ${nickWhy})`}`,
  });

  const lines = [
    `✅ **Başvuru kabul edildi:** <@${ticket.user_id}>`,
    `🎭 Roller: ${added.length ? added.join(' ') : '—'}${skipped.length ? ` (zaten vardı: ${skipped.join(' ')})` : ''}`,
    `📝 İsim: \`${nick}\` (${isimKaynak})${nickOk ? '' : ` — ⚠️ verilemedi (${nickWhy})`}`,
  ];
  if (failed.length) lines.push(`⚠️ Başarısız: ${failed.join(' ')}`);
  await interaction.editReply({ content: lines.join('\n').slice(0, 2000) }).catch(() => {});
  return true;
}

/** "KOD - IC İSİM" formatını Discord 32 karakter sınırına sığdırır (isim tarafından kısaltır). */
function formatNickname(kod, isim) {
  const k = String(kod || '').trim().replace(/\s+/g, ' ');
  const n = String(isim || '').trim().replace(/\s+/g, ' ');
  let full = `${k} - ${n}`;
  if (full.length > 32) {
    const keepName = Math.max(1, 32 - k.length - 3);
    full = `${k.slice(0, 29)} - ${n.slice(0, keepName)}`.slice(0, 32);
  }
  return full;
}

async function handleReject(interaction) {
  if (!(await requireStaff(interaction))) return true;
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Bu ticket zaten kapalı.', ...EPH() }).catch(() => {});
    return true;
  }
  if (!isBasvuru(ticket)) {
    await interaction
      .reply({ embeds: [buildErrorEmbed('Kabul/Ret butonları yalnızca başvuru ticketlarında kullanılabilir.')], ...EPH() })
      .catch(() => {});
    return true;
  }
  if (ticket.decision) {
    await interaction.reply({ content: `ℹ️ ${decisionText(ticket.decision, ticket.decided_by)}`, ...EPH() }).catch(() => {});
    return true;
  }

  await interaction.deferReply({ ...EPH() });

  // Herkese açık ret mesajı (kanalda görünür)
  try {
    await interaction.channel.send({
      content: `<@${ticket.user_id}> ❌ **Başvurunuz reddedildi.**`,
      allowedMentions: { users: [ticket.user_id] },
    });
  } catch (err) {
    logger.warn(`Ticket #${ticket.id} ret mesajı gönderilemedi: ${err.code || err.message}`);
    await interaction.editReply({ embeds: [buildErrorEmbed('Ret mesajı kanala gönderilemedi. Bot yetkilerini kontrol edin.')] }).catch(() => {});
    return true;
  }

  try {
    setTicketDecision(ticket.id, 'rejected', interaction.user.id);
  } catch {
    /* kayıt hatası akışı engellemez */
  }
  const updated = getTicket(ticket.id) || { ...ticket, decision: 'rejected', decided_by: interaction.user.id };
  const embed = buildOpenTicketEmbed({
    guild: interaction.guild,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    createdUnix: Math.floor(ticket.created_at / 1000),
    status: 'open',
    claimedBy: updated.claimed_by || null,
  });
  await refreshPanel(interaction, updated, embed, buildTicketButtons('open', ticket.category_key, 'rejected'));
  markTicketGuard(interaction.guildId, ticket.channel_id);

  logger.success(`Ticket #${ticket.id} başvuru reddedildi (${interaction.user.tag})`);
  await sendLog(interaction.guild, 'rejected', {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
  });
  await interaction.editReply({ content: `❌ Başvuru reddedildi ve <@${ticket.user_id}> bilgilendirildi.` }).catch(() => {});
  return true;
}

// ---------- Panel yenileme ----------

/** Kayıtlı panel mesajını düzenler; bulunamazsa kanala taze durum mesajı gönderir. */
async function refreshPanel(interaction, ticket, embed, components) {
  const channel = interaction.channel;
  if (ticket.panel_message_id) {
    try {
      const msg = await channel.messages.fetch(ticket.panel_message_id);
      await msg.edit({ embeds: [embed], components });
      return;
    } catch (err) {
      logger.warn(`Ticket #${ticket.id} panel mesajı düzenlenemedi, taze mesaj gönderiliyor: ${err.code || err.message}`);
    }
  }
  try {
    const msg = await channel.send({ embeds: [embed], components });
    setTicketPanelMessage(ticket.id, msg.id);
  } catch (err) {
    logger.warn(`Ticket #${ticket.id} durum mesajı gönderilemedi: ${err.code || err.message}`);
  }
}

/**
 * Açık ticketlara görüntüleyici rol iznini kesin olarak uygular.
 * - Mevcut overwrite VARSA bile (deny varsa) ZORLA günceller.
 * - Rol hiyerarşisi/yetki hatalarını loglar ama diğer ticketları engellemez.
 * - Staff ile aynı ID ise SKIP (staff FULL overwrite korunur, downgrade yok).
 * Sonuç: { synced, skipped, failed }.
 */
async function syncTicketViewerRole(client) {
  const result = { synced: 0, skipped: 0, failed: 0 };
  const viewerId = config.ticket.viewerRoleId;
  if (!viewerId) return result;
  if (String(viewerId) === String(STAFF_TICKET_ROLE_ID)) {
    logger.debug('Viewer rol staff ile aynı — viewer sync skip (staff senkronu yeterli).');
    return result;
  }
  let tickets = [];
  try {
    tickets = getAllTickets().filter((t) => t.status === 'open');
  } catch (err) {
    logger.error('[DB] syncTicketViewerRole okuma hatası.', err);
    return result;
  }
  for (const t of tickets) {
    try {
      const ch = await client.channels.fetch(t.channel_id).catch(() => null);
      if (!ch?.isTextBased?.()) {
        result.skipped++;
        continue;
      }
      const role = await ch.guild?.roles?.fetch(viewerId).catch(() => null);
      if (!role) {
        logger.warn(`Ticket #${t.id}: Görüntüleyici rol (${viewerId}) sunucuda bulunamadı.`);
        result.skipped++;
        continue;
      }
      const me = ch.guild.members.me;
      if (!me?.permissionsIn(ch).has(PermissionFlagsBits.ManageRoles)) {
        logger.warn(`Ticket #${t.id}: Botun kanalda MANAGE_ROLES yetkisi yok, atlanıyor.`);
        result.failed++;
        continue;
      }
      if (role.position >= me.roles.highest.position) {
        logger.warn(`Ticket #${t.id}: Görüntüleyici rol botun en yüksek rolünden üst/aynı seviyede (${role.position} >= ${me.roles.highest.position}), atlanıyor.`);
        result.failed++;
        continue;
      }
      const existing = ch.permissionOverwrites.cache.get(viewerId);
      const hasViewAllow = existing?.allow?.has?.(PermissionFlagsBits.ViewChannel) ?? false;
      const hasViewDeny = existing?.deny?.has?.(PermissionFlagsBits.ViewChannel) ?? false;
      if (hasViewAllow && !hasViewDeny) {
        result.skipped++;
        continue;
      }
      await ch.permissionOverwrites.edit(viewerId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
      }, `Ticket görüntüleyici rolü senkronu (ticket #${t.id})`);
      result.synced++;
      logger.debug(`Ticket #${t.id}: Görüntüleyici rol izni uygulandı (role: ${viewerId})`);
    } catch (err) {
      result.failed++;
      logger.warn(`Ticket #${t.id} görüntüleme izni verilemedi: ${err.code || err.message}`);
    }
  }
  if (result.synced > 0 || result.failed > 0) {
    logger.success(`Görüntüleyici rol senkronu: ${result.synced} eklendi/güncellendi, ${result.skipped} zaten doğru, ${result.failed} hatalı.`);
  }
  return result;
}

/**
 * Tek bir ticket kanalı için görüntüleyici rolünü zorla uygular (yeni ticket açılışında çağrılabilir).
 * Staff ile aynı ID ise false döner (staff FULL korunur).
 * Hata fırlatmaz; başarı durumunu boolean döner.
 */
async function ensureTicketViewerRole(channel) {
  const viewerId = config.ticket.viewerRoleId;
  if (!viewerId) return false;
  if (String(viewerId) === String(STAFF_TICKET_ROLE_ID)) return false;
  try {
    const role = await channel.guild.roles.fetch(viewerId).catch(() => null);
    if (!role) return false;
    const me = channel.guild.members.me;
    if (!me?.permissionsIn(channel).has(PermissionFlagsBits.ManageRoles)) return false;
    if (role.position >= me.roles.highest.position) return false;
    await channel.permissionOverwrites.edit(viewerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
    }, `Ticket görüntüleyici rolü garanti (ticket açılış)`);
    return true;
  } catch {
    return false;
  }
}

// ===================== STAFF TICKET ROLE (1522773972393922730) — FULL ACCESS =====================

/**
 * Tek bir ticket kanalı için STAFF rolünü kesin olarak uygular + gerçek izin doğrulaması.
 * Spec 4,17,18: permissionOverwrites.edit sonrası permissionsFor ile doğrula, başarısızsa 1 retry.
 * Guard internal tracking ekler (spec 19). Bot perms/hiyerarşi kontrolü (spec 15).
 * @returns {Promise<boolean>} true = başarılı (View+Read+Send doğrulanmış)
 */
async function ensureStaffTicketAccess(channel, opts = {}) {
  const { verify = true, retry = 1 } = opts;
  const roleId = STAFF_TICKET_ROLE_ID;
  if (!roleId) return false;
  try {
    const guild = channel.guild;
    if (!guild) return false;
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      logger.error(`⚠️ TICKET STAFF ROLE NOT FOUND — Role ID: ${roleId} (guild ${guild.id})`);
      try {
        const logChId = config.ticket.logChannelId;
        if (logChId) {
          const lc = await guild.channels.fetch(logChId).catch(() => null);
          if (lc?.isTextBased()) await lc.send(`⚠️ **TICKET STAFF ROLE NOT FOUND**\nRole ID: \`${roleId}\`\nKanal: <#${channel.id}>`).catch(() => {});
        }
      } catch {}
      return false;
    }
    const me = guild.members.me;
    if (!me) return false;
    const needPerm = PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageChannels;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      logger.warn(`Botun ManageChannels/ManageRoles yetkisi yok — staff overwrite verilemeyebilir (kanal ${channel.id}).`);
    }
    if (role.position >= me.roles.highest.position) {
      logger.warn(`Staff ticket rolü bot rolünden yüksek/eşit (${role.position} >= ${me.roles.highest.position}) — overwrite başarısız olabilir (kanal ${channel.id}).`);
    }
    if (!me.permissionsIn(channel).has(PermissionFlagsBits.ManageRoles) && !me.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
      logger.warn(`Botun kanalda MANAGE_ROLES/MANAGE_CHANNELS yok (kanal ${channel.id}) — staff overwrite atlanıyor.`);
      // yine de dene, API izin verirse
    }
    // Guard: botun overwrite işlemi saldırı sanılmasın
    markTicketGuard(guild.id, channel.id);
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AttachFiles: true,
      EmbedLinks: true,
      ManageMessages: true,
    }, `Ticket staff role access (spec 3)`);
    markTicketGuard(guild.id, channel.id);

    if (!verify) return true;

    // Gerçek izin doğrulaması (spec 17)
    const perms = channel.permissionsFor(role);
    const hasView = perms?.has(PermissionFlagsBits.ViewChannel);
    const hasRead = perms?.has(PermissionFlagsBits.ReadMessageHistory);
    const hasSend = perms?.has(PermissionFlagsBits.SendMessages);
    if (hasView && hasRead && hasSend) {
      logger.debug(`Staff ticket erişimi doğrulandı: #${channel.name} (${channel.id})`);
      return true;
    }
    logger.warn(`Staff permission doğrulaması başarısız: #${channel.name} View:${hasView} Read:${hasRead} Send:${hasSend} (retry=${retry})`);
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 700));
      // retry: tekrar edit + verify
      markTicketGuard(guild.id, channel.id);
      await channel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        AttachFiles: true,
        EmbedLinks: true,
        ManageMessages: true,
      }, `Ticket staff role retry`);
      markTicketGuard(guild.id, channel.id);
      const perms2 = channel.permissionsFor(role);
      const ok2 = perms2?.has(PermissionFlagsBits.ViewChannel) && perms2?.has(PermissionFlagsBits.ReadMessageHistory) && perms2?.has(PermissionFlagsBits.SendMessages);
      if (ok2) {
        logger.success(`Staff ticket erişimi retry sonrası doğrulandı: #${channel.name}`);
        return true;
      }
      logger.error(`Staff ticket erişimi retry sonrası HÂLÂ başarısız: #${channel.name} — manuel kontrol gerek (role hiyerarşi / bot yetkisi / kategori deny?).`);
      return false;
    }
    return false;
  } catch (err) {
    logger.warn(`Staff ticket erişimi verilemedi (kanal ${channel?.id}): ${err.code || err.message}`);
    return false;
  }
}

/**
 * Mevcut AÇIK ticketların tamamını tarar, STAFF rol overwrite'ını kontrol edip düzeltir.
 * Spec 7,8,17,18: sadece ticket sistemine ait olduğu DB ile doğrulanan kanalları düzeltir.
 * Sonuç: { checked, fixed, already, failed }
 */
async function syncStaffTicketPermissions(client) {
  const result = { checked: 0, fixed: 0, already: 0, failed: 0 };
  const roleId = STAFF_TICKET_ROLE_ID;
  if (!roleId) {
    logger.warn('STAFF_TICKET_ROLE_ID tanımlı değil — staff sync atlandı.');
    return result;
  }
  let tickets = [];
  try {
    tickets = getAllTickets().filter((t) => t.status === 'open');
  } catch (err) {
    logger.error('[DB] syncStaffTicketPermissions okuma hatası.', err);
    return result;
  }
  if (!tickets.length) {
    logger.info('Staff ticket sync: açık ticket yok.');
    return result;
  }
  // Guild/role varlık kontrolü (spec 14)
  const sampleGuildId = tickets[0]?.guild_id;
  let guildRoleExists = false;
  try {
    const g = sampleGuildId ? await client.guilds.fetch(sampleGuildId).catch(() => null) : null;
    if (g) {
      const r = await g.roles.fetch(roleId).catch(() => null);
      guildRoleExists = !!r;
      if (!r) {
        logger.error(`⚠️ TICKET STAFF ROLE NOT FOUND — Role ID: ${roleId} (guild ${sampleGuildId}) — tüm ticketlarda staff erişimi verilemiyor!`);
        try {
          const logChId = config.ticket.logChannelId;
          if (logChId) {
            const lc = await g.channels.fetch(logChId).catch(() => null);
            if (lc?.isTextBased()) await lc.send(`⚠️ **TICKET STAFF ROLE NOT FOUND**\nRole ID: \`${roleId}\`\nGuild: ${sampleGuildId}\nAçık ${tickets.length} ticketta staff erişimi verilemiyor.`).catch(() => {});
          }
        } catch {}
      }
    }
  } catch {}
  if (!guildRoleExists) {
    // rol yoksa tüm ticketlar failed sayılır ama crash olmaz (spec 14)
    result.failed = tickets.length;
    return result;
  }

  for (const t of tickets) {
    result.checked++;
    try {
      const ch = await client.channels.fetch(t.channel_id).catch(() => null);
      if (!ch?.isTextBased?.()) {
        result.failed++;
        logger.warn(`Ticket #${t.id}: kanal bulunamadı (${t.channel_id}) — atlanıyor.`);
        continue;
      }
      // Bot perms/hiyerarşi kontrolü (spec 15)
      const me = ch.guild.members.me;
      const role = await ch.guild.roles.fetch(roleId).catch(() => null);
      if (!role) { result.failed++; continue; }
      if (me && role.position >= me.roles.highest.position) {
        logger.warn(`Ticket #${t.id}: staff rolü bot rolünden yüksek/eşit — atlanıyor.`);
        result.failed++;
        continue;
      }
      // Mevcut overwrite kontrolü + permissionsFor gerçek doğrulama (spec 17)
      const existing = ch.permissionOverwrites.cache.get(roleId);
      const hasViewAllow = existing?.allow?.has?.(PermissionFlagsBits.ViewChannel) ?? false;
      const hasReadAllow = existing?.allow?.has?.(PermissionFlagsBits.ReadMessageHistory) ?? false;
      const hasSendAllow = existing?.allow?.has?.(PermissionFlagsBits.SendMessages) ?? false;
      const hasViewDeny = existing?.deny?.has?.(PermissionFlagsBits.ViewChannel) ?? false;
      let needsFix = false;
      if (!existing || !hasViewAllow || !hasReadAllow || !hasSendAllow || hasViewDeny) needsFix = true;
      else {
        // overwrite var ama gerçek hesaplanmış izin yine de deny olabilir (kategori @everyone deny + staff allow eksik gibi)
        const perms = ch.permissionsFor(role);
        const ok = perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.ReadMessageHistory) && perms?.has(PermissionFlagsBits.SendMessages);
        if (!ok) needsFix = true;
      }
      if (!needsFix) { result.already++; continue; }
      const ok = await ensureStaffTicketAccess(ch, { verify: true, retry: 1 });
      if (ok) {
        result.fixed++;
        logger.success(`Ticket #${t.id} staff erişimi düzeltildi: #${ch.name}`);
      } else {
        result.failed++;
      }
    } catch (err) {
      result.failed++;
      logger.warn(`Ticket #${t.id} staff senkron hatası: ${err.code || err.message}`);
    }
  }
  logger.success(`Staff ticket senkronu: ${result.checked} kontrol, ${result.fixed} düzeltildi, ${result.already} zaten doğru, ${result.failed} başarısız.`);
  // Log kanalına özet (spec 20) — sadece fixed/failed varsa
  if ((result.fixed > 0 || result.failed > 0) && tickets[0]?.guild_id) {
    try {
      const g = await client.guilds.fetch(tickets[0].guild_id).catch(() => null);
      const logChId = config.ticket.logChannelId;
      if (g && logChId) {
        const lc = await g.channels.fetch(logChId).catch(() => null);
        if (lc?.isTextBased()) {
          await lc.send(`✅ **Ticket staff role access configured**\nRole: <@&${roleId}> (\`${roleId}\`)\nKontrol: ${result.checked} • Düzeltildi: ${result.fixed} • Zaten doğru: ${result.already} • Başarısız: ${result.failed}`).catch(() => {});
        }
      }
    } catch {}
  }
  return result;
}

/**
 * Tüm ticket permission repair (staff + viewer) — startup ve /ticketpermissionrepair ortak.
 * Sadece DB ile doğrulanmış ticket kanallarını düzeltir (spec 8).
 */
async function repairAllTicketPermissions(client) {
  const staffRes = await syncStaffTicketPermissions(client);
  const viewerRes = await syncTicketViewerRole(client);
  return { staff: staffRes, viewer: viewerRes };
}

module.exports = {
  handleTicketButton,
  _formatNickname: formatNickname,
  _isBasvuru: isBasvuru,
  createTicketFromSelect,
  handleAddUserSelect,
  sendLog,
  syncTicketViewerRole,
  ensureTicketViewerRole,
  ensureStaffTicketAccess,
  syncStaffTicketPermissions,
  repairAllTicketPermissions,
  STAFF_TICKET_ROLE_ID,
};
