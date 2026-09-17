/**
 * /ticketpermissionrepair — Ticket permission repair (sadece ticket yöneticileri).
 * Mevcut açık ticketları tarar, staff rol (1522773972393922730) eksikse düzeltir.
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageTickets } = require('../utils/permissions');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticketpermissionrepair')
    .setDescription('Açık ticketlardaki staff rol izinlerini onarır (sadece yetkililer).'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komut yalnızca sunucuda kullanılabilir.')], flags: MessageFlags.Ephemeral });
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu komutu yalnızca ticket yetkilileri kullanabilir.')], flags: MessageFlags.Ephemeral });
    }
    const me = interaction.guild.members.me;
    if (me && !me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Botun **Kanalları Yönet** ve **Rolleri Yönet** yetkisi yok — onarım yapılamaz.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { repairAllTicketPermissions, STAFF_TICKET_ROLE_ID } = require('../handlers/ticketHandler');
      const result = await repairAllTicketPermissions(interaction.client);
      const staff = result.staff || { checked: 0, fixed: 0, already: 0, failed: 0 };
      const viewer = result.viewer || { synced: 0, skipped: 0, failed: 0 };
      const roleId = STAFF_TICKET_ROLE_ID || config.STAFF_TICKET_ROLE_ID || '1522773972393922730';
      const roleMention = `<@&${roleId}>`;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 Ticket Permission Repair')
        .setDescription(
          `**Staff Role:** ${roleMention} (\`${roleId}\`)\n` +
          `**Kontrol edilen:** ${staff.checked} ticket\n` +
          `**Düzeltilen:** ${staff.fixed} ticket\n` +
          `**Zaten doğru:** ${staff.already} ticket\n` +
          `**Başarısız:** ${staff.failed} ticket\n` +
          (viewer.synced || viewer.failed ? `\n*Viewer sync:* ${viewer.synced} düzeltildi, ${viewer.skipped} atlandı, ${viewer.failed} hatalı` : '')
        )
        .setFooter({ text: `${config.botName} | Ticket System` })
        .setTimestamp();
      // Guard log gibi değil, sadece ephemeral cevap
      await interaction.editReply({ embeds: [embed] });
      logger.success(`Ticket permission repair: ${staff.checked} kontrol, ${staff.fixed} düzeltildi (by ${interaction.user.tag})`);
    } catch (err) {
      logger.error('Interaction failed: /ticketpermissionrepair.', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Onarım sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },
};
