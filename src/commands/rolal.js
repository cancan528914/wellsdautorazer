/**
 * /rolal - Seçilen kullanıcıdan rol alır.
 * Koruma: kendinden alamazsın, kendi rolünden üst/eşit rol alamazsın.
 * Yetki: ekip/admin (canManageTickets) + hiyerarşi kontrolleri.
 * Hız: tüm kontroller yerelde yapılır, önce hızlı ACK, sonra tek API çağrısı.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { checkRoleAction, reasonText } = require('../handlers/roleHandler');
const { canManageRoles } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  // Rol-yöneticisi istisnası: global listede olmasa bile ROLE_MANAGER listesindeki
  // roller BU komutu kullanabilir (başka hiçbir komutu açmaz).
  openToRoleManagers: true,
  data: new SlashCommandBuilder()
    .setName('rolal')
    .setDescription('Seçilen kullanıcıdan rol alır.')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Rol alınacak kişi').setRequired(true))
    .addRoleOption((opt) => opt.setName('rol').setDescription('Alınacak rol').setRequired(true)),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageRoles(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca yetkililer kullanabilir.')], flags: MessageFlags.Ephemeral });
    }

    // Tüm doğrulamalar yerelde ve anında — hata varsa tek çağrıda cevap
    const target = interaction.options.getMember('kullanici');
    const role = interaction.options.getRole('rol', true);
    const check = checkRoleAction({
      executor: interaction.member,
      target,
      role,
      me: interaction.guild.members.me,
      guildId: interaction.guildId,
      guildOwnerId: interaction.guild.ownerId,
      action: 'remove',
    });
    if (!check.ok) {
      return interaction.reply({ embeds: [buildErrorEmbed(reasonText(check.reason))], flags: MessageFlags.Ephemeral });
    }

    try {
      // Hızlı ACK (kullanıcı anında geri bildirim görür), sonra tek API çağrısı
      await interaction.reply({ content: `⏳ **${role.name}** rolü alınıyor...`, flags: MessageFlags.Ephemeral });
      await target.roles.remove(role, `RolAl: ${interaction.user.tag}`);
      logger.success(`Rol alındı: ${role.name} ← ${target.user.tag} (alan: ${interaction.user.tag})`);
      return interaction.editReply({ content: `✅ <@${target.id}> kullanıcısından **${role.name}** rolü alındı.` });
    } catch (err) {
      logger.error('Interaction failed: /rolal.', err);
      const msg = err?.code === 50013 ? 'Rol alınamadı — bot yetkisini ve rol sıralamasını kontrol edin.' : 'Rol alınırken bir hata oluştu.';
      const payload = { embeds: [buildErrorEmbed(msg)], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  },
};
