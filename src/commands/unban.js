/**
 * /unban - Banlı kullanıcının banını açar (ID ile de çalışır).
 * Yetki: admin VEYA ban-yetkili rolü (global kapıdan muaf, SADECE bu komut için).
 * NOT: Guard whitelistin yoksa Guard seni banlayabilir — sonuç mesajında uyarılırsın.
 */
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageBan } = require('../utils/permissions');
const { guardCoverNote } = require('../guard/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Banlı kullanıcının banını açar (sadece yetkililer).')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Banı açılacak kişi (ID de olur)').setRequired(true))
    .addStringOption((opt) => opt.setName('sebep').setDescription('Sebep').setRequired(false).setMaxLength(450)),
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

    const me = interaction.guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Botun **Üyeleri Yasakla** yetkisi yok.')], flags: MessageFlags.Ephemeral });
    }

    const banned = await interaction.guild.bans.fetch(targetUser.id).catch(() => null);
    if (!banned) {
      return interaction.reply({ content: 'ℹ️ Bu kullanıcı banlı değil.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const reason = `Unban: ${interaction.user.tag}${sebep ? ` — ${sebep}` : ''}`.slice(0, 512);
      await interaction.guild.members.unban(targetUser.id, reason);
      logger.success(`Unban: ${targetUser.tag} (yapan: ${interaction.user.tag})`);
      const note = guardCoverNote(interaction.guildId, interaction.user.id);
      return interaction.editReply({ content: `✅ <@${targetUser.id}> kullanıcısının banı açıldı.${note}` });
    } catch (err) {
      logger.error('Interaction failed: /unban.', err);
      const msg = err?.code === 50013 ? 'Ban açılamadı — bot yetkisini kontrol edin.' : 'Ban açılırken bir hata oluştu.';
      return interaction.editReply({ embeds: [buildErrorEmbed(msg)] }).catch(() => {});
    }
  },
};
