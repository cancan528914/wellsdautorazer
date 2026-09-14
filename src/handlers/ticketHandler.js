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
  claimTicket,
  closeTicket,
  deleteTicket,
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
} = require('../utils/ticketEmbeds');
const { fetchChannelMessages, buildTranscriptFile } = require('../utils/transcript');

const EPH = (extra = {}) => ({ flags: MessageFlags.Ephemeral, ...extra });

// Yetkili Çağır spam koruması (bellek içi; restartta sıfırlanır — güvenli varsayılan)
const callCooldown = new Map();

// ---------- Yardımcılar ----------

async function resolveStaffRole(guild) {
  const id = config.ticket.staffRoleId;
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

async function sendLog(guild, event, data, files) {
  try {
    if (!config.ticket.logEnabled) return;
    const id = config.ticket.logChannelId;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch?.isTextBased()) {
      logger.warn(`Ticket log kanalı bulunamadı veya metin kanalı değil: ${id}`);
      return;
    }

    // Tek-mesaj logu: ticket başına bir log mesajı tutulur, her işlemde düzenlenir.
    const payload = { embeds: [buildLogEmbed(event, data)], ...(files?.length ? { files } : {}) };
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
    if (config.ticket.staffRoleId && !staffRole) {
      logger.warn(`TICKET_STAFF_ROLE_ID bulunamadı: ${config.ticket.staffRoleId} (ticket yine de açılacak)`);
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

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: interaction.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];
    if (staffRole) {
      overwrites.push({
        id: staffRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    let channel;
    try {
      channel = await guild.channels.create({
        name: sanitizeChannelName(interaction.user.username, ticketId),
        type: ChannelType.GuildText,
        ...(parent ? { parent: parent.id } : {}),
        topic: `Ticket #${ticketId} • ${category.label} • Sahip: ${interaction.user.tag}`.slice(0, 1024),
        permissionOverwrites: overwrites,
      });
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
        components: buildTicketButtons('open'),
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

    logger.success(`Ticket #${ticketId} açıldı: #${channel.name} (${interaction.user.tag}, ${category.label})`);
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
      case 'ticket_call':
        return handleCallStaff(interaction);
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

  await interaction.deferReply({ ...EPH() });
  claimTicket(ticket.id, interaction.user.id);

  const embed = buildOpenTicketEmbed({
    guild: interaction.guild,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    createdUnix: Math.floor(ticket.created_at / 1000),
    status: 'claimed',
    claimedBy: interaction.user.id,
  });
  await refreshPanel(interaction, ticket, embed, buildTicketButtons('open'));
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

  // Sahibin yazma yetkisini kaldır (okumaya devam edebilir)
  try {
    await interaction.channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false });
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
  await refreshPanel(interaction, ticket, embed, buildTicketButtons('closed'));
  await confirmMsg?.delete().catch(() => {});

  logger.success(`Ticket #${ticket.id} kapatıldı (${interaction.user.tag})`);
  const closedFiles = await collectTranscript(ticket, interaction.channel, interaction.guild?.name, 'Kapalı');
  await sendLog(interaction.guild, 'closed', {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
    ...(closedFiles.length ? { extra: '📄 Transkript dosyası eklendi.' } : {}),
  }, closedFiles);
  await interaction.editReply({ content: '🔒 Ticket kapatıldı.' }).catch(() => {});
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

  const info = {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
    logMessageId: ticket.log_message_id || null, // satır silinmeden önce yakala
    ...(deletedFiles.length ? { extra: '📄 Transkript dosyası eklendi.' } : {}),
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
  await sendLog(interaction.guild, 'deleted', info, deletedFiles);
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

// ---------- Yetkili çağırma ----------

async function handleCallStaff(interaction) {
  const ticket = await getTicketOrReply(interaction);
  if (!ticket) return true;
  if (ticket.status === 'closed') {
    await interaction.reply({ content: '⚫ Bu ticket kapalı.', ...EPH() }).catch(() => {});
    return true;
  }
  const staffRoleId = config.ticket.staffRoleId;
  if (!staffRoleId) {
    await interaction.reply({ embeds: [buildErrorEmbed('Yetkili rolü ayarlanmamış (TICKET_STAFF_ROLE_ID). Yöneticinize bildirin.')], ...EPH() }).catch(() => {});
    return true;
  }

  const key = `${interaction.guildId}:${ticket.channel_id}`;
  const now = Date.now();
  const last = callCooldown.get(key) || 0;
  const waitMs = config.ticket.callCooldownMs - (now - last);
  if (waitMs > 0) {
    const secs = Math.ceil(waitMs / 1000);
    await interaction.reply({ content: `🔔 Yetkililer zaten çağrıldı — **${secs} sn** sonra tekrar deneyin.`, ...EPH() }).catch(() => {});
    return true;
  }
  callCooldown.set(key, now);

  await interaction.reply({ content: '🔔 Yetkili ekip çağrıldı, birazdan burada olacaklar.', ...EPH() }).catch(() => {});
  await interaction.channel
    .send({ content: `🔔 <@&${staffRoleId}> — <@${interaction.user.id}> destek ekibini çağırıyor!` })
    .catch((err) => logger.warn(`Ticket #${ticket.id} çağrı mesajı gönderilemedi: ${err.code || err.message}`));
  await sendLog(interaction.guild, 'called', {
    ticketId: ticket.id,
    userId: ticket.user_id,
    categoryLabel: ticket.category_label,
    channelId: ticket.channel_id,
    actorId: interaction.user.id,
  });
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

module.exports = {
  handleTicketButton,
  createTicketFromSelect,
  handleAddUserSelect,
  sendLog,
  _callCooldown: callCooldown, // testler için
};
