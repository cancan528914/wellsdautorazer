/**
 * Tüm embed tasarımları tek merkezde.
 * - Discord field limiti (1024 char) aşılmaz: fazla kullanıcı "+X kişi daha" olarak özetlenir.
 * - Liste boşsa "Henüz kimse yok." gösterilir.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { getSetting } = require('../database/database');

const BOT_NAME = config.botName;
const EMPTY_TEXT = '*Henüz kimse yok.*';

/**
 * Mention listesini embed-safe string'e çevirir.
 * @param {string[]} ids Discord user ID listesi
 * @returns {string}
 */
function formatUserList(ids) {
  if (!ids || ids.length === 0) return EMPTY_TEXT;

  const lines = [];
  let hidden = 0;

  for (const id of ids) {
    const line = `<@${id}>`;
    // Bir sonraki satır 1024'ü aşacaksa geri kalanı özetle
    const preview = [...lines, line].join('\n');
    const suffix = hidden > 0 ? `\n*+${hidden} kişi daha...*` : '';
    // Mevcut + yeni satır + olası suffix 1000'i geçmesin (güven payı)
    if ((preview + suffix).length > 1000 && lines.length > 0) {
      hidden = ids.length - lines.length;
      break;
    }
    lines.push(line);
  }

  let text = lines.join('\n');
  if (hidden > 0) text += `\n*+${hidden} kişi daha...*`;
  return text;
}

function baseEmbed(color) {
  return new EmbedBuilder().setColor(color).setFooter({ text: BOT_NAME }).setTimestamp();
}

function buildIngameEmbed(joinedIds = [], leftIds = []) {
  const total = joinedIds.length + leftIds.length;
  const embed = baseEmbed(config.colors.ingame)
    .setTitle('🎮 INGAME')
    .setDescription(
      `Oyundaysan 🟢 **Katıl** butonuna bas, çıkıyorsan 🔴 **Ayrıl** butonuna bas.\n\n` +
        `👥 **Toplam:** ${total} kişi   •   ✅ **Katılan:** ${joinedIds.length}   •   ❌ **Ayrılan:** ${leftIds.length}`,
    )
    .addFields(
      { name: `✅ Katılanlar (${joinedIds.length})`, value: formatUserList(joinedIds), inline: true },
      { name: `❌ Ayrılanlar (${leftIds.length})`, value: formatUserList(leftIds), inline: true },
    );
  if (config.ingamePanelImage) embed.setImage(config.ingamePanelImage);
  return embed;
}

function buildAktiflikEmbed(joinedIds = []) {
  const embed = baseEmbed(config.colors.aktiflik)
    .setTitle('📋 AKTİFLİK')
    .setDescription(
      `**Günlük aktiflik yoklaması**\nAktif olduğunu bildirmek için 🟢 **Katıl** butonuna bas.\n\n` +
        `📊 **Toplam Katılım:** ${joinedIds.length} kişi`,
    )
    .addFields({ name: `✅ Katılanlar (${joinedIds.length})`, value: formatUserList(joinedIds), inline: false });
  if (config.aktiflikPanelImage) embed.setImage(config.aktiflikPanelImage);
  return embed;
}

function buildDmResultEmbed(success, failed, total) {
  return baseEmbed(config.colors.dm)
    .setTitle('📨 DM Gönderme Sonucu')
    .addFields(
      { name: '✅ Başarılı', value: String(success), inline: true },
      { name: '❌ Başarısız', value: String(failed), inline: true },
      { name: '📊 Toplam', value: String(total), inline: true },
    );
}

function buildClearEmbed(count, moderatorTag) {
  return baseEmbed(config.colors.clear)
    .setTitle('🧹 Mesajlar Temizlendi')
    .setDescription(`**${count}** mesaj silindi.${moderatorTag ? `\nModeratör: ${moderatorTag}` : ''}`);
}

function buildErrorEmbed(description) {
  return baseEmbed(config.colors.error).setTitle('⚠️ Hata').setDescription(description);
}

/**
 * IC isim onay paneli. status: 'pending' | 'approved' | 'rejected'
 */
function buildIcPanelEmbed({ userId, requestedText, status = 'pending', decidedBy = null, createdUnix = null }) {
  const statusText =
    status === 'approved' ? `✅ Onaylandı${decidedBy ? ` — <@${decidedBy}>` : ''}` : status === 'rejected' ? `❌ Reddedildi${decidedBy ? ` — <@${decidedBy}>` : ''}` : '🟡 Onay Bekliyor';
  const embed = baseEmbed(config.colors.clear)
    .setTitle('📝 IC İsim Talebi')
    .addFields(
      { name: 'Kullanıcı:', value: `<@${userId}>`, inline: false },
      { name: 'Talep Edilen İsim:', value: requestedText ? `\`\`\`\n${String(requestedText).slice(0, 1000)}\n\`\`\`` : '*okunamadı*', inline: false },
      { name: 'Durum:', value: statusText, inline: false },
    );
  if (createdUnix) embed.setDescription(`<t:${createdUnix}:R> oluşturuldu.`);
  return embed;
}

/** Karar sonrası decided=true ise butonlar kilitli gelir. */
function buildIcButtons(decided = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ic_approve').setLabel('Onayla').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(decided),
    new ButtonBuilder().setCustomId('ic_reject').setLabel('Reddet').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(decided),
  );
}

/** Aktif mazeret panel görseli: /mazeretpng ile kaydedilen (DB) öncelikli, yoksa config varsayılanı. */
function getMazeretImage() {
  try {
    return getSetting('mazeret_panel_image') || config.mazeretPanelImage || null;
  } catch {
    return config.mazeretPanelImage || null;
  }
}

/** Panel görseli doğrulama (ticketpng + mazeretpng ortak). */
const PANEL_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const PANEL_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

function validateImageAttachment(att, maxBytes = PANEL_IMAGE_MAX_BYTES) {
  const ext = String(att?.name || '').split('.').pop().toLowerCase();
  if (!att || !String(att.contentType || '').startsWith('image/') || !PANEL_IMAGE_EXTS.includes(ext)) {
    return { ok: false, reason: 'format' };
  }
  if ((att.size || 0) > maxBytes) return { ok: false, reason: 'size' };
  return { ok: true };
}

/** /mazeret paneli (komutun kullanıldığı kanala gönderilir). */
function buildMazeretPanelEmbed() {
  const embed = baseEmbed(config.colors.mazeret)
    .setTitle('📋 Mazeret Bildirimi')
    .setDescription(
      'Gelemeyeceğiniz / aktif olamayacağınız zamanları buradan bildirin.\n' +
        'Aşağıdaki butona basıp mazeretinizi yazın — bildiriminiz mazeret kanalına düşer.',
    );
  const img = getMazeretImage();
  if (img) embed.setImage(img);
  return embed;
}

function buildMazeretOpenRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mazeret_open').setLabel('Mazeret Bildir').setStyle(ButtonStyle.Primary).setEmoji('📝'),
  );
}

/** Kullanıcının mazeret bildirimi (panel kanalına gönderilir). */
function buildMazeretReportEmbed({ userId, sure, text }) {
  return baseEmbed(config.colors.mazeret)
    .setTitle('📋 Mazeret Bildirimi')
    .addFields(
      { name: 'Bildiren:', value: `<@${userId}>`, inline: true },
      { name: 'Süre:', value: sure ? String(sure).slice(0, 100) : 'Belirtilmedi', inline: true },
      { name: 'Mazeret:', value: String(text).slice(0, 1024), inline: false },
    )
    .setTimestamp();
}

/** Quit (ayrılma) bildirimi — şık, geniş kart. */
function buildQuitPanelEmbed({ user, roles = [], joinedAt = null }) {
  let avatar = null;
  try {
    avatar = user.displayAvatarURL({ size: 256 });
  } catch {
    /* avatarsız devam */
  }
  const embed = baseEmbed(config.colors.error)
    .setTitle('📤 Sunucudan Ayrıldı')
    .setDescription(`<@${user.id}>\n\`${user.id}\``)
    .addFields(
      { name: 'Kullanıcı', value: String(user.tag || 'Bilinmeyen').slice(0, 100), inline: true },
      { name: 'Katılım', value: joinedAt ? `<t:${Math.floor(joinedAt / 1000)}:R>` : 'Bilinmiyor', inline: true },
      { name: 'Roller', value: roles.length ? `${roles.length} rol` : 'Rol kaydı yok', inline: true },
    )
    .setTimestamp();
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function buildQuitRolesRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('quit_roles').setLabel('Eski Roller').setStyle(ButtonStyle.Secondary).setEmoji('🎭'),
  );
}

/** Eski roller listesi (ephemeral cevap). */
function buildQuitRolesEmbed({ userId, userTag, roles = [], guild = null }) {
  const lines = (roles || []).map((r) =>
    guild?.roles?.cache?.has(r.id) ? `<@&${r.id}>` : `~~${String(r.name || 'Bilinmeyen rol').slice(0, 100)}~~ (silinmiş)`,
  );
  return baseEmbed(config.colors.clear)
    .setTitle('🎭 Eski Roller')
    .setDescription(`<@${userId}> (${String(userTag || '').slice(0, 100)})\n\n${lines.length ? lines.join('\n').slice(0, 4000) : '*Kayıtlı rol yok.*'}`);
}

module.exports = {
  formatUserList,
  buildIngameEmbed,
  buildAktiflikEmbed,
  buildDmResultEmbed,
  buildClearEmbed,
  buildErrorEmbed,
  buildIcPanelEmbed,
  buildIcButtons,
  buildMazeretPanelEmbed,
  buildMazeretOpenRow,
  buildMazeretReportEmbed,
  getMazeretImage,
  validateImageAttachment,
  PANEL_IMAGE_EXTS,
  PANEL_IMAGE_MAX_BYTES,
  buildQuitPanelEmbed,
  buildQuitRolesRow,
  buildQuitRolesEmbed,
};
