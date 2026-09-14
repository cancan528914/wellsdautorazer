/**
 * Select menu interaction yönlendirici (StringSelect + UserSelect).
 * Button'larla aynı desen: statik customId, restart-safe.
 */
const { MessageFlags } = require('discord.js');
const { buildErrorEmbed } = require('../utils/embeds');
const { buildTicketPanelEmbed, buildCategoryMenu } = require('../utils/ticketEmbeds');
const { createTicketFromSelect, handleAddUserSelect } = require('./ticketHandler');
const logger = require('../utils/logger');

async function handleSelectMenu(interaction) {
  try {
    // --- String Select: ticket kategori menüsü ---
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId !== 'ticket_category') return false;

      const value = interaction.values?.[0];

      // Seçimi sıfırla: menüyü ilk haline döndür
      if (value === 'ticket_reset') {
        await interaction
          .update({ embeds: [buildTicketPanelEmbed(interaction.guild)], components: [buildCategoryMenu()] })
          .catch(() => {});
        await interaction
          .followUp({ content: '🔄 Seçim sıfırlandı.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return true;
      }

      // Kategori seçimi: ticketcat:<key>
      if (typeof value === 'string' && value.startsWith('ticketcat:')) {
        await createTicketFromSelect(interaction, value.slice('ticketcat:'.length));
        return true;
      }

      return false;
    }

    // --- User Select: ticket'a kullanıcı ekleme ---
    if (interaction.isUserSelectMenu()) {
      if (interaction.customId !== 'ticket_adduser_select') return false;
      await handleAddUserSelect(interaction);
      return true;
    }

    return false;
  } catch (err) {
    if (err?.code === 10062) {
      logger.error('Interaction EXPIRED: [select] — kullanıcı "Uygulama yanıt vermedi" gördü.');
      return true;
    }
    logger.error(`Interaction failed: select ${interaction.customId}`, err);
    try {
      const payload = { embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply(payload).catch(() => {});
    } catch {
      /* sessiz geç */
    }
    return true;
  }
}

module.exports = { handleSelectMenu };
