/**
 * Log embed tasarımı — TEK tutarlı görsel dil.
 *
 * Her log şu blokları içerir (gerektiğinde):
 *   👤 İşlemi Yapan (mention + username + ID)
 *   🎯 Hedef (mention/ID + açıklama)
 *   ⚙️ İşlem (ne yapıldı)
 *   📝 Sebep (Audit Log reason)
 *   🔎 Audit Log (doğrulandı / doğrulanamadı)
 *   🕒 Tarih (Discord timestamp)
 *
 * Footer: "Javrex Guard • <Kanal Etiketi>"
 * Hiçbir yerde plain text gönderilmez — her şey embed.
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { LOG_CHANNEL_MAP } = require('./constants');

const FOOTER_BASE = `${config.botName} Guard`;

/** Discord snowflake mi? */
function isSnowflake(id) {
  return /^\d{17,20}$/.test(String(id || ''));
}

/**
 * Executor blokunu kurar.
 * - executor yoksa veya doğrulanamadıysa AÇIKÇA belirtilir (asla uydurma).
 */
function actorField(executor, verified) {
  if (!executor || !isSnowflake(executor.id)) {
    return { name: '👤 İşlemi Yapan', value: '⚠️ **Doğrulanamadı**', inline: true };
  }
  const mention = `<@${executor.id}>`;
  const name = executor.username ? `\`${String(executor.username).slice(0, 32)}\`` : '—';
  const isBot = executor.bot ? ' 🤖' : '';
  const badge = verified === true ? '✅' : verified === false ? '❌' : '—';
  return {
    name: '👤 İşlemi Yapan',
    value: `${mention}${isBot}\n${name}\n\`${executor.id}\`\n${badge} Audit doğrulaması`,
    inline: true,
  };
}

/** Hedef blokları — tipine göre mention üretir. */
function targetFields(target) {
  if (!target) return [];
  const t = target;
  const fields = [];
  if (t.kind === 'role' && isSnowflake(t.id)) {
    fields.push({ name: t.label || '🎭 Hedef Rol', value: `<@&${t.id}>\n\`${t.id}\``, inline: true });
  } else if (t.kind === 'user' && isSnowflake(t.id)) {
    fields.push({ name: t.label || '🎯 Hedef Üye', value: `<@${t.id}>\n\`${t.id}\``, inline: true });
  } else if (t.kind === 'channel' && isSnowflake(t.id)) {
    fields.push({ name: t.label || '📁 Hedef Kanal', value: `<#${t.id}>\n\`${t.id}\``, inline: true });
  } else if (t.id) {
    fields.push({ name: t.label || '🎯 Hedef', value: `\`${String(t.id).slice(0, 64)}\``, inline: true });
  }
  if (t.extra) {
    fields.push({ name: t.label2 || '📎 Detay', value: String(t.extra).slice(0, 1000), inline: false });
  }
  return fields;
}

/** Bot mu yaptı, kullanıcı mı? */
function actorKindField(actorKind) {
  if (actorKind === 'bot') {
    return { name: '⚙️ Kaynak', value: '🤖 **Bot** (otomasyon / Guard işlemi)', inline: true };
  }
  if (actorKind === 'unknown') {
    return { name: '⚙️ Kaynak', value: '❓ **Bilinmiyor** (audit eşleşmedi)', inline: true };
  }
  return { name: '⚙️ Kaynak', value: '👤 **Kullanıcı**', inline: true };
}

/**
 * Ana log embed üretici.
 *
 * @param {object} p
 * @param {string} p.logType   - LOG_CHANNELS key (renk/etiket buradan gelir)
 * @param {string} p.title     - Örn. "ROL SİLİNDİ"
 * @param {object} [p.actor]   - { id, username, bot }
 * @param {boolean} [p.verified] - audit doğrulaması
 * @param {object} [p.target]  - { kind, id, label, extra }
 * @param {string} [p.action]  - işlem açıklaması
 * @param {string} [p.reason]  - audit reason
 * @param {string} [p.actorKind] - 'user' | 'bot' | 'unknown'
 * @param {string} [p.note]    - ek uyarı (ör. "kesin doğrulanamadı")
 * @param {number} [p.color]   - renk override
 * @param {string} [p.footerExtra]
 * @returns {EmbedBuilder}
 */
function buildLogEmbed(p = {}) {
  const meta = LOG_CHANNEL_MAP.get(p.logType) || {};
  const color = Number.isFinite(p.color) ? p.color : meta.color ?? 0x5865f2;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${meta.emoji || '📋'} ${String(p.title || meta.label || 'LOG').toUpperCase()}`)
    .setTimestamp();

  embed.addFields(actorField(p.actor, p.verified));
  embed.addFields(actorKindField(p.actorKind || (p.actor ? 'user' : 'unknown')));

  embed.addFields(...targetFields(p.target));

  if (p.action) {
    embed.addFields({ name: '⚙️ İşlem', value: String(p.action).slice(0, 1000), inline: false });
  }

  if (p.reason) {
    embed.addFields({ name: '📝 Sebep (Audit Log)', value: String(p.reason).slice(0, 500), inline: false });
  }

  // Doğrulama durumu — doğrulanamadıysa kesinlikle belirtilir.
  if (p.verified === false || p.verified === undefined) {
    embed.addFields({
      name: '🔎 Audit Log',
      value: '⚠️ **İşlemi yapan kullanıcı doğrulanamadı.**',
      inline: false,
    });
  } else if (p.verified === true) {
    embed.addFields({ name: '🔎 Audit Log', value: '✅ **Doğrulandı**', inline: true });
  }

  if (p.note) {
    embed.addFields({ name: 'ℹ️ Not', value: String(p.note).slice(0, 800), inline: false });
  }

  // Footer: tutarlı marka + kanal etiketi
  const label = meta.label ? ` • ${meta.label}` : '';
  embed.setFooter({ text: `${FOOTER_BASE}${label}${p.footerExtra ? ` • ${p.footerExtra}` : ''}` });

  return embed;
}

/**
 * Guard sistemi kendi işlemi (ceza, rollback, whitelist, setup) için embed.
 * logType her zaman 'guard'.
 */
function buildGuardActionEmbed({ title, action, detail, status, actor, color, note }) {
  const meta = LOG_CHANNEL_MAP.get('guard');
  const embed = new EmbedBuilder()
    .setColor(Number.isFinite(color) ? color : meta.color)
    .setTitle(`🛡️ ${String(title || 'GUARD').toUpperCase()}`)
    .setTimestamp();

  if (actor) {
    embed.addFields({ name: '👤 Yetkili', value: `<@${actor.id}>\n\`${actor.id}\``, inline: true });
  }
  if (action) embed.addFields({ name: '⚙️ İşlem', value: String(action).slice(0, 800), inline: false });
  if (detail) embed.addFields({ name: '📋 Sonuç', value: String(detail).slice(0, 1000), inline: false });
  if (status) {
    embed.addFields({
      name: status.ok === false ? '❌ Durum' : '✅ Durum',
      value: String(status.text || (status.ok ? 'Başarılı' : 'Başarısız')).slice(0, 300),
      inline: false,
    });
  }
  if (note) embed.addFields({ name: 'ℹ️ Not', value: String(note).slice(0, 800), inline: false });

  embed.setFooter({ text: `${FOOTER_BASE} • ${meta.label}` });
  return embed;
}

/** Gruplanan (spam-safe) toplu olay özeti embed'i. */
function buildGroupEmbed({ logType, title, entries, total, windowLabel }) {
  const meta = LOG_CHANNEL_MAP.get(logType) || {};
  const list = (entries || []).slice(0, 15);
  const lines = list.map((e) => `• ${e}`);
  let value = lines.join('\n');
  if ((entries || []).length > list.length) {
    value += `\n… +${entries.length - list.length} olay daha`;
  }
  return new EmbedBuilder()
    .setColor(meta.color ?? 0x5865f2)
    .setTitle(`${meta.emoji || '📋'} ${String(title || meta.label || 'LOG').toUpperCase()} (Gruplandı)`)
    .setDescription(value || '—')
    .addFields({ name: '📊 Toplam', value: `${Number(total) || (entries || []).length} olay`, inline: true })
    .setFooter({ text: `${FOOTER_BASE} • ${meta.label} • Gruplandı${windowLabel ? ` • ${windowLabel}` : ''}` })
    .setTimestamp();
}

module.exports = {
  buildLogEmbed,
  buildGuardActionEmbed,
  buildGroupEmbed,
  actorField,
  targetFields,
  isSnowflake,
  FOOTER_BASE,
};