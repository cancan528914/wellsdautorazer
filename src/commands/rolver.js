/**
 * /rolver - Seçilen kullanıcıya rol verir.
 * Koruma: kendine veremezsin, kendi rolünden üst/eşit rol veremezsin.
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
    .setName('rolver')
    .setDescription('Seçilen kullanıcıya rol verir.')
    .addUserOption((opt) => opt.setName('kullanici').setDescription('Rol verilecek kişi').setRequired(true))
    .addRoleOption((opt) => opt.setName('rol').setDescription('Verilecek rol').setRequired(true)),

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
      action: 'add',
    });
    if (!check.ok) {
      return interaction.reply({ embeds: [buildErrorEmbed(reasonText(check.reason))], flags: MessageFlags.Ephemeral });
    }

    try {
      // Hızlı ACK (kullanıcı anında geri bildirim görür), sonra tek API çağrısı
      await interaction.reply({ content: `⏳ **${role.name}** rolü veriliyor...`, flags: MessageFlags.Ephemeral });
      await target.roles.add(role, `RolVer: ${interaction.user.tag}`);
      logger.success(`Rol verildi: ${role.name} → ${target.user.tag} (veren: ${interaction.user.tag})`);
      return interaction.editReply({ content: `✅ <@${target.id}> kullanıcısına **${role.name}** rolü verildi.` });
    } catch (err) {
      logger.error('Interaction failed: /rolver.', err);
      const msg = err?.code === 50013 ? 'Rol verilemedi — bot yetkisini ve rol sıralamasını kontrol edin.' : 'Rol verilirken bir hata oluştu.';
      const payload = { embeds: [buildErrorEmbed(msg)], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  },
};
