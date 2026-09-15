/**
 * /unban - Banlı kullanıcının banını ID ile açar.
 * Yetki: admin VEYA ban-yetkili rolü (global kapıdan muaf, SADECE bu komut için).
 * - ID + mention yapıştırma kabul edilir, Snowflake doğrulanır.
 * - Üyenin sunucuda olması gerekmez (doğrudan ID ile unban).
 * - Aynı ID'ye eşzamanlı çift işlem engellenir.
 * - Botun kendi unban'i internal tracker'a işaretlenir (Guard çakışmaz).
 * - Başarı/başarısızlık mod-log'a düşer (ayarlıysa).
 */
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { AuditLogEvent } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageBan } = require('../utils/permissions');
const { guardCoverNote } = require('../guard/permissions');
const { markBotAction } = require('../guard/tracker');
const { sendModLog } = require('../utils/modlog');
const logger = require('../utils/logger');

// Aynı hedefe eşzamanlı çift unban engeli (process belleği)
const inflightUnbans = new Set();

/** Mention (`<@123>` / `<@!123>`) veya düz metinden ID çıkarır. */
function extractUserId(raw) {
  const m = String(raw || '').match(/(\d{17,20})/);
  return m ? m[1] : '';
}

/** Discord API hatasını kullanıcı dostu kategoriye çevirir. Teknik detay loglanır. */
function mapUnbanError(err) {
  const code = err?.code;
  const status = err?.status;
  logger.error(`Unban API hatası: code=${code} status=${status} message=${err?.message}`, err?.rawError || err);
  if (code === 10026) return { kind: 'not-banned', msg: 'ℹ️ Bu kullanıcı banlı değil (başka işlem kaldırmış olabilir).' };
  if (code === 50013 || code === 50001) return { kind: 'perm', msg: '❌ Bu işlemi gerçekleştirmek için Ban Members yetkim bulunmuyor.' };
  if (code === 10004) return { kind: 'guild', msg: '❌ Sunucu bulunamadı.' };
  if (code === 30035 || status === 429) return { kind: 'ratelimit', msg: '❌ Rate limit — biraz sonra tekrar deneyin.' };
  if (code === 10013 || code === 404) return { kind: 'user', msg: '❌ Kullanıcı bulunamadı.' };
  return { kind: 'unknown', msg: '❌ Unban işlemi sırasında beklenmeyen bir hata oluştu.' };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Banlı kullanıcının banını ID ile açar (sadece yetkililer).')
    .addStringOption((opt) =>
      opt
        .setName('kullanici')
        .setDescription('Banı açılacak kişinin Discord ID’si (mention da olur)')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(30),
    )
    .addStringOption((opt) => opt.setName('sebep').setDescription('Sebep').setRequired(false).setMaxLength(450)),
  openToBanManagers: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageBan(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    const targetId = extractUserId(interaction.options.getString('kullanici', true));
    const sebep = (interaction.options.getString('sebep') || '').trim();
    if (!targetId) {
      return interaction.reply({ embeds: [buildErrorEmbed('❌ Geçersiz kullanıcı ID’si. 17-20 haneli sayı girin.')], flags: MessageFlags.Ephemeral });
    }

    const execTag = interaction.user.tag;
    const guild = interaction.guild;

    if (inflightUnbans.has(targetId)) {
      return interaction.reply({ content: '⏳ Bu kullanıcı için işlem zaten sürüyor, bekleyin.', flags: MessageFlags.Ephemeral });
    }
    // Set'e SENKRON ekle (await öncesi) — yoksa eşzamanlı iki istek arayı kaçırır
    inflightUnbans.add(targetId);

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch {
      inflightUnbans.delete(targetId);
      throw new Error('Interaction cevaplanamadı (süresi dolmuş olabilir).');
    }

    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
      return interaction.editReply({ embeds: [buildErrorEmbed('❌ Bu işlemi gerçekleştirmek için Ban Members yetkim bulunmuyor.')] });
    }

    const banned = await guild.bans.fetch(targetId).catch((err) => {
      logger.warn(`Ban listesi okunamadı (${targetId}): ${err.code || err.message}`);
      return null;
    });
    if (!banned) {
      return interaction.editReply({ content: 'ℹ️ Bu kullanıcı sunucuda banlı değil.' });
    }
    const targetTag = banned.user?.tag || `Bilinmeyen (${targetId})`;

    try {
      const reason = `Unban: ${execTag}${sebep ? ` — ${sebep}` : ''}`.slice(0, 512);
      // Guard internal tracking: izinli unban saldırı sayılmaz
      markBotAction(guild.id, AuditLogEvent.MemberBanRemove, targetId, 'unban-komutu');
      await guild.members.unban(targetId, reason);
      logger.success(`Unban: ${targetTag} (yapan: ${execTag})`);
      const note = guardCoverNote(guild.id, interaction.user.id);
      const embed = new EmbedBuilder()
        .setColor(config.colors.success)
        .setTitle('🔓 UNBAN BAŞARILI')
        .addFields(
          { name: 'Kullanıcı', value: `<@${targetId}>`, inline: true },
          { name: 'Kullanıcı ID', value: `\`${targetId}\``, inline: true },
          { name: 'İşlemi yapan', value: `<@${interaction.user.id}>`, inline: false },
          { name: 'Durum', value: '✅ Kullanıcının yasağı kaldırıldı', inline: false },
          { name: 'Tarih', value: new Date().toLocaleString('tr-TR', { hour12: false }), inline: false },
        )
        .setFooter({ text: `${config.botName} | Moderasyon` })
        .setTimestamp();
      await sendModLog(guild, {
        kind: 'unban', ok: true, targetId, targetTag,
        executor: interaction.user, reason: sebep || undefined,
      }).catch(() => {});
      return interaction.editReply({ embeds: [embed], content: note || undefined });
    } catch (err) {
      const mapped = mapUnbanError(err);
      // 10026 yarış durumu: bilgi mesajı yeterli
      if (mapped.kind === 'not-banned') {
        return interaction.editReply({ content: mapped.msg }).catch(() => {});
      }
      await sendModLog(guild, {
        kind: 'unban', ok: false, targetId, targetTag,
        executor: interaction.user, reason: sebep || undefined,
        detail: `Error Code: ${err?.code || '?'} (${mapped.kind})`,
      }).catch(() => {});
      const payload = mapped.kind === 'perm' || mapped.kind === 'guild'
        ? { embeds: [buildErrorEmbed(mapped.msg)] }
        : { content: mapped.msg };
      return interaction.editReply(payload).catch(() => {});
    } finally {
      inflightUnbans.delete(targetId);
    }
  },

  // testler için
  extractUserId,
  mapUnbanError,
  _inflightUnbans: inflightUnbans,
};
