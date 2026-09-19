/**
 * Ticket sistemi embed + component tasarımları (tek merkez).
 * Referans: premium, minimal, okunabilir. Emoji dengeli.
 */
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const config = require('../config');
const { getSetting } = require('../database/database');

const T = () => config.ticket;

// ---------- Yardımcılar ----------

function brandColor() {
  return T().color || 0x5865f2;
}

function baseEmbed(color) {
  return new EmbedBuilder()
    .setColor(color ?? brandColor())
    .setFooter({ text: `${config.botName} | Ticket Sistemi` })
    .setTimestamp();
}

/** Aktif panel görseli: /ticketpng ile kaydedilen (DB) öncelikli, yoksa config varsayılanı. */
function getPanelImage() {
  try {
    return getSetting('ticket_panel_image') || T().panelImage || null;
  } catch {
    return T().panelImage || null;
  }
}

function getCategoryByKey(key) {
  return (T().categories || []).find((c) => c.key === key) || null;
}

/** Discord kanal adı kuralları: küçük harf, boşluk/Türkçe karakter yok. */
function sanitizeChannelName(username, ticketId) {
  const TR = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u' };
  const clean =
    String(username || 'user')
      .toLowerCase()
      .replace(/[çğışöü]/g, (ch) => TR[ch]) // NFD'de çözülmeyen Türkçe harfler
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'user';
  return `ticket-${clean}-${String(ticketId).padStart(4, '0')}`.slice(0, 90);
}

const trunc = (s, n) => String(s || '').slice(0, n);

// ---------- 1. Ticket açma paneli (referans görsel 1) ----------

function buildTicketPanelEmbed(guild) {
  const about = T().panelAbout;
  const info = T().panelInfo;
  const embed = baseEmbed()
    .setTitle('🎫 Ticket Sistemi')
    .setDescription(`✨ **Ticket Sistemi Hakkında:**\n${about}\n\n🔗 **Sunucu Bilgisi:**\n${info}`);
  const img = getPanelImage();
  if (img) embed.setImage(img);
  return embed;
}

function buildCategoryMenu() {
  const options = (T().categories || []).slice(0, 24).map((c) => ({
    label: trunc(c.label, 100),
    description: trunc(c.description || '', 100),
    value: `ticketcat:${c.key}`.slice(0, 100),
    emoji: c.emoji || '🎫',
  }));
  // Discord select en fazla 25 seçenek alır; son slot sıfırlamaya ayrılır.
  options.push({
    label: 'Seçimi Sıfırla',
    description: 'Menü seçimini sıfırlamak için seçiniz.',
    value: 'ticket_reset',
    emoji: '🔄',
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket_category')
      .setPlaceholder('🎫 Ticket Açmak İçin Kategori Seçiniz.')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.slice(0, 25)),
  );
}

// ---------- 2. Açık ticket paneli (referans görsel 2) ----------

/** status: 'open' (sahipsiz) | 'claimed' | 'closed' */
function ticketStatusText(status, claimedBy) {
  if (status === 'closed') return '⚫ Kapalı';
  if (claimedBy) return `🟡 İlgileniliyor — <@${claimedBy}>`;
  return '🔴 Yetkili Bekleniyor';
}

function buildOpenTicketEmbed({ guild, userId, categoryLabel, createdUnix, status = 'open', claimedBy = null }) {
  const embed = baseEmbed()
    .setTitle(trunc(categoryLabel || 'Destek Talebi', 256))
    .setDescription(
      `<@${userId}> <t:${createdUnix}:R> tarihinde destek talebi oluşturdu.\n\nOluşturulan destek talebinin bilgileri aşağıda belirtilmiştir;`,
    )
    .addFields(
      { name: 'Oluşturan Kullanıcı:', value: `<@${userId}>`, inline: false },
      { name: 'Kategori:', value: trunc(categoryLabel || '—', 1024), inline: false },
      { name: 'Durum', value: ticketStatusText(status, claimedBy), inline: false },
    );
  if (claimedBy && status !== 'closed') {
    embed.addFields({ name: 'Sahip:', value: `<@${claimedBy}>`, inline: false });
  }
  if (guild?.name) embed.setFooter({ text: `${guild.name} | Ticket Sistemi` });
  return embed.setTimestamp();
}

/**
 * Yönetim butonları. Kapalı ticket'ta sadece Sil aktif kalır.
 * Başvuru (basvuru) ticketlarında 3. satırda Kabul Et / Reddet bulunur.
 * customId'ler statiktir → restart-safe (kanal ID üzerinden DB'den çözülür).
 */
function buildTicketButtons(status = 'open', categoryKey = null, decided = null) {
  const closed = status === 'closed';
  const decidedLocked = !!decided; // karar verildiyse kabul/ret kilitlenir
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Sahiplen')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🧑‍💼')
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Kapat')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔒')
      .setDisabled(closed),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_adduser')
      .setLabel('Kullanıcı Ekle')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👤')
      .setDisabled(closed),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Sil').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  const rows = [row1, row2];
  if (categoryKey === 'basvuru' && !closed) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_accept')
          .setLabel('Kabul Et')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅')
          .setDisabled(decidedLocked),
        new ButtonBuilder()
          .setCustomId('ticket_reject')
          .setLabel('Reddet')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌')
          .setDisabled(decidedLocked),
      ),
    );
  }
  return rows;
}

// ---------- 3. Onay diyalogları ----------

function buildConfirmEmbed(kind) {
  const text =
    kind === 'delete'
      ? 'Bu ticket **kalıcı olarak silinecek**. Devam etmek istiyor musunuz?'
      : 'Bu ticketı **kapatmak** istediğinize emin misiniz?';
  return baseEmbed(config.colors?.error || 0xe74c3c)
    .setTitle(kind === 'delete' ? '🗑️ Ticket Silme Onayı' : '🔒 Ticket Kapatma Onayı')
    .setDescription(text);
}

function buildConfirmRow(kind) {
  const yesId = kind === 'delete' ? 'ticket_delete_yes' : 'ticket_close_yes';
  const noId = kind === 'delete' ? 'ticket_delete_no' : 'ticket_close_no';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(yesId)
      .setLabel(kind === 'delete' ? 'Sil' : 'Onayla')
      .setStyle(kind === 'delete' ? ButtonStyle.Danger : ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder().setCustomId(noId).setLabel('Vazgeç').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
  );
}

/**
 * Kategoriye özel form mesajı (örn. başvuru soruları). Sorusu olmayan
 * kategori için null döner (mesaj gönderilmez).
 */
function buildCategoryFormEmbed(category) {
  const questions = (category?.formQuestions || []).map((q) => String(q || '').trim()).filter(Boolean);
  if (!questions.length) return null;
  const lines = questions.slice(0, 20).map((q, i) => `**${i + 1}. ${trunc(q, 200)}**`);
  let description = `${trunc(category.formIntro || 'Lütfen aşağıdaki soruları yanıtlayın.', 500)}\n\n${lines.join('\n')}`;
  if (description.length > 4000) description = description.slice(0, 4000);
  return baseEmbed()
    .setTitle(trunc(category.formTitle || `📝 ${category.label || 'Başvuru'} Formu`, 256))
    .setDescription(description);
}

function buildAddUserRow() {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('ticket_adduser_select')
      .setPlaceholder('👤 Ticket’a eklenecek kullanıcıyı seçin.')
      .setMinValues(1)
      .setMaxValues(1),
  );
}

// ---------- 4. Log embedleri ----------

const LOG_STYLE = {
  created: { emoji: '🎫', label: 'Oluşturuldu', color: 0x2ecc71 },
  closed: { emoji: '🔒', label: 'Kapatıldı', color: 0xe67e22 },
  deleted: { emoji: '🗑️', label: 'Silindi', color: 0xe74c3c },
  claimed: { emoji: '🧑‍💼', label: 'Sahiplenildi', color: 0x3498db },
  accepted: { emoji: '✅', label: 'Başvuru Kabul Edildi', color: 0x2ecc71 },
  rejected: { emoji: '❌', label: 'Başvuru Reddedildi', color: 0xe74c3c },
  user_added: { emoji: '👤', label: 'Kullanıcı Eklendi', color: 0x9b59b6 },
  called: { emoji: '🔔', label: 'Yetkili Çağrıldı', color: 0xf1c40f },
};

/** "14.09.2026 14:30:20" formatında TR tarih. */
function fmtTrDate(ts) {
  try {
    const d = new Date(Number(ts) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return '—';
  }
}

const TOP_MEDALS = ['🥇', '🥈', '🥉'];

/**
 * /ticketop embedi. rows: [{ user_id, claimed_count }] (sıralı, max 10).
 * Sunucuda olmayan kullanıcılar mention+ID olarak düşer (fetch yok, crash yok).
 */
function buildTopEmbed(rows) {
  const list = (rows || []).filter((r) => r && r.user_id).slice(0, 10);
  const embed = baseEmbed()
    .setTitle('🏆 Ticket Top 10')
    .setDescription('En çok ticket sahiplenen yetkililer');
  if (!list.length) {
    embed.setDescription('Henüz hiç ticket sahiplenme verisi bulunmuyor.');
    return embed;
  }
  const lines = list.map((r, i) => {
    const rank = i < 3 ? TOP_MEDALS[i] : `${i + 1}.`;
    const count = Math.max(0, Number(r.claimed_count) || 0);
    return `${rank} <@${r.user_id}>\n**${count} Ticket**\nID: \`${r.user_id}\``;
  });
  embed.setDescription(lines.join('\n'));
  return embed;
}

/**
 * Tek tip premium log görünümü: `EMOJİ Ticket #id — Olay` başlığı + temiz açıklama bloğu.
 * Tüm veri korunur (mention + ID). Kapanışta sahiplenen/kapatan/tarih ayrımı durur.
 */
function buildLogEmbed(event, { ticketId, userId, categoryLabel, channelId, actorId, extra, claimedBy, closedBy, closedAt } = {}) {
  const style = LOG_STYLE[event] || { emoji: '🎫', label: 'Olay', color: brandColor() };
  const head = ticketId ? `Ticket #${ticketId}` : 'Ticket';
  const embed = baseEmbed(style.color).setTitle(`${style.emoji} ${head} — ${style.label}`);
  const L = [];
  const chanLine = channelId ? `📺 **Kanal:** <#${channelId}>` : null;

  if (event === 'closed') {
    if (userId) L.push(`👤 **Açan:** <@${userId}>`);
    if (claimedBy) L.push(`👤 **Sahibi:** <@${claimedBy}>\n🆔 \`ID: ${claimedBy}\``);
    else L.push('👤 **Sahibi:** ❌ Sahiplenilmedi');
    if (closedBy) L.push(`🔒 **Kapatan:** <@${closedBy}>`);
    L.push(`🕐 **Kapanma:** ${fmtTrDate(closedAt || Date.now())}`);
    if (chanLine) L.push(chanLine);
  } else {
    if (userId) L.push(`👤 **Sahip:** <@${userId}>`);
    if (categoryLabel) L.push(`📁 **Kategori:** ${trunc(categoryLabel, 100)}`);
    if (event === 'claimed' && actorId) L.push(`🧑‍💼 **Sahiplenen:** <@${actorId}>`);
    else if (event === 'deleted' && actorId) L.push(`🗑️ **Silen:** <@${actorId}>`);
    else if (event === 'called' && actorId) L.push(`🔔 **Çağıran:** <@${actorId}>`);
    else if (actorId && event !== 'created') L.push(`👤 **İşlem:** <@${actorId}>`);
    else if (actorId) L.push(`👤 **Açan:** <@${actorId}>`);
    if (chanLine) L.push(chanLine);
  }
  if (extra) L.push(`📎 ${trunc(extra, 500)}`);
  embed.setDescription(L.length ? L.join('\n') : '—');
  return embed;
}

/**
 * /setup sonuç paneli.
 * result: { logChannelId, created, adopted, envUpdated, checks: [{label, ok, detail}] }
 */
function buildSetupResultEmbed(result) {
  const state = result.created ? '🆕 Yeni oluşturuldu' : result.adopted ? '♻️ Mevcut kanal devralındı' : '✅ Zaten kurulu';
  const embed = baseEmbed()
    .setTitle('🛠️ Ticket Log Kurulumu')
    .setDescription(
      `📋 **Log Kanalı:** <#${result.logChannelId}> (${state})\n` +
        (result.envUpdated
          ? '⚙️ `.env` güncellendi ve ayar anında aktif — **yeniden başlatma gerekmez**.'
          : '⚠️ `.env` yazılamadı — kanal ID’sini `TICKET_LOG_CHANNEL_ID` alanına elle yazın.'),
    );
  for (const c of result.checks || []) {
    embed.addFields({ name: `${c.ok ? '✅' : '⚠️'} ${c.label}`, value: trunc(c.detail || '—', 1024), inline: false });
  }
  return embed;
}

function buildTranscriptRow(url) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('📖 Transcript Aç')
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
}

module.exports = {
  getPanelImage,
  getCategoryByKey,
  sanitizeChannelName,
  ticketStatusText,
  buildTicketPanelEmbed,
  buildCategoryMenu,
  buildOpenTicketEmbed,
  buildTicketButtons,
  buildConfirmEmbed,
  buildConfirmRow,
  buildCategoryFormEmbed,
  buildAddUserRow,
  buildLogEmbed,
  buildSetupResultEmbed,
  buildTopEmbed,
  buildTranscriptRow,
  fmtTrDate,
};
