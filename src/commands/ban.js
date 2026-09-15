/**
 * /ban - Seçilen kullanıcıyı sunucudan banlar.
 * Yetki: admin VEYA ban-yetkili rolü (global kapıdan muaf, SADECE bu komut için).
 * Koruma: kendine/sahibeye/bota yok, hiyerarşi kontrolü, bot yetkisi önceden denetlenir.
 * NOT: Guard whitelistin yoksa Guard seni banlayabilir — sonuç mesajında uyarılırsın.
 */
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageBan } = require('../utils/permissions');
const { guardCoverNote } = require('../guard/permissions');
const { sendModLog } = require('../utils/modlog');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Seçilen kullanıcıyı sunucudan banlar (sadece yetkililer).')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Banlanacak kişi').setRequired(true))
    .addStringOption((opt) => opt.setName('sebep').setDescription('Ban sebebi').setRequired(false).setMaxLength(450))
    .addIntegerOption((opt) => opt.setName('sil').setDescription('Silinecek mesaj günü (0-7)').setRequired(false).setMinValue(0).setMaxValue(7)),
  openToBanManagers: true,

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageBan(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser('kullanici', true);
    const sebep = (interaction.options.getString('sebep') || '').trim();
    const sil = interaction.options.getInteger('sil') || 0;

    // Yerel doğrulamalar (anında, tek çağrı)
    if (targetUser.id === interaction.user.id) {
      return interaction.reply({ embeds: [buildErrorEmbed('Kendini banlayamazsın.')], flags: MessageFlags.Ephemeral });
    }
    if (targetUser.id === interaction.guild.ownerId) {
      return interaction.reply({ embeds: [buildErrorEmbed('Sunucu sahibi banlanamaz.')], flags: MessageFlags.Ephemeral });
    }
    if (targetUser.id === interaction.client.user.id) {
      return interaction.reply({ embeds: [buildErrorEmbed('Botu banlayamazsın.')], flags: MessageFlags.Ephemeral });
    }

    const targetMember = interaction.options.getMember('kullanici');
    const isOwner = interaction.user.id === interaction.guild.ownerId;
    if (targetMember && !isOwner) {
      const execTop = interaction.member?.roles?.highest?.position ?? 0;
      if ((targetMember.roles?.highest?.position ?? 0) >= execTop) {
        return interaction.reply({ embeds: [buildErrorEmbed('Senden üst veya eşit konumdaki birini banlayamazsın.')], flags: MessageFlags.Ephemeral });
      }
    }
    const me = interaction.guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Botun **Üyeleri Yasakla** yetkisi yok.')], flags: MessageFlags.Ephemeral });
    }
    if (targetMember && (targetMember.roles?.highest?.position ?? 0) >= (me.roles?.highest?.position ?? 0)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Botun rolü yetersiz — bot rolünü hedefin üstüne taşı.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const reason = `Ban: ${interaction.user.tag}${sebep ? ` — ${sebep}` : ''}`.slice(0, 512);
      await interaction.guild.members.ban(targetUser.id, { reason, deleteMessageSeconds: sil * 86400 });
      logger.success(`Ban: ${targetUser.tag} (yapan: ${interaction.user.tag}${sebep ? `, sebep: ${sebep}` : ''})`);
      await sendModLog(interaction.guild, {
        kind: 'ban', ok: true, targetId: targetUser.id, targetTag: targetUser.tag,
        executor: interaction.user, reason: sebep || undefined,
      }).catch(() => {});
      const note = guardCoverNote(interaction.guildId, interaction.user.id);
      return interaction.editReply({ content: `🔨 <@${targetUser.id}> banlandı.${sebep ? `\nSebep: ${sebep}` : ''}${note}` });
    } catch (err) {
      logger.error('Interaction failed: /ban.', err);
      let msg = 'Ban atılırken bir hata oluştu.';
      if (err?.code === 50013) msg = 'Ban atılamadı — bot yetkisini ve rol sıralamasını kontrol edin.';
      else if (err?.code === 404 || err?.code === 10013) msg = 'Kullanıcı bulunamadı.';
      await sendModLog(interaction.guild, {
        kind: 'ban', ok: false, targetId: targetUser?.id || '?', targetTag: targetUser?.tag,
        executor: interaction.user, reason: sebep || undefined,
        detail: `Error Code: ${err?.code || '?'}`,
      }).catch(() => {});
      return interaction.editReply({ embeds: [buildErrorEmbed(msg)] }).catch(() => {});
    }
  },
};
