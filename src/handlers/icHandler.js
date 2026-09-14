/**
 * IC isim onay sistemi.
 * Ayarlı kanala yazılan her mesaj için Onayla/Reddet panelli kayıt açılır.
 * Mesaj içeriği API'den çekilir (MessageContent intent'i gerekmez).
 * Buton customId'leri statiktir → restart-safe (panel mesaj ID üzerinden çözülür).
 */
const { MessageFlags } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { canManageTickets } = require('../utils/permissions');
const { buildErrorEmbed, buildIcPanelEmbed, buildIcButtons } = require('../utils/embeds');
const { createIcRequest, getIcByPanel, getPendingIc, decideIc, setIcPanel } = require('../database/database');

async function handleIcMessage(message) {
  const guild = message.guild;
  const user = message.author;
  try {
    // Duplicate: bekleyen talebi varsa yenisini sil, DM ile bilgilendir
    const pending = getPendingIc(guild.id, user.id);
    if (pending) {
      await message.delete().catch(() => {});
      await user
        .send('ℹ️ Zaten bekleyen bir IC isim talebin var. O sonuçlanmadan yeni talep açamazsın.')
        .catch(() => {});
      logger.info(`IC mükerrer talep engellendi: ${user.tag}`);
      return;
    }

    let text = '';
    try {
      const full = await message.channel.messages.fetch(message.id);
      text = String(full?.content || '').trim();
    } catch (err) {
      logger.warn(`IC talep içeriği okunamadı: ${message.id} (${err.code || err.message})`);
    }

    const id = createIcRequest({
      guildId: guild.id,
      userId: user.id,
      channelId: message.channelId,
      requestMessageId: message.id,
      requestedText: text,
    });

    const panel = await message.channel.send({
      embeds: [
        buildIcPanelEmbed({
          userId: user.id,
          requestedText: text,
          status: 'pending',
          createdUnix: Math.floor(Date.now() / 1000),
        }),
      ],
      components: [buildIcButtons(false)],
    });
    setIcPanel(id, panel.id);
    logger.success(`IC talebi #${id} açıldı (${user.tag})`);
  } catch (err) {
    logger.error('IC talebi işlenemedi.', err);
  }
}

async function handleIcButton(interaction) {
  try {
    if (!canManageTickets(interaction.member)) {
      await interaction
        .reply({ embeds: [buildErrorEmbed('Bu işlem için yetkili olmalısınız.')], flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }

    const rec = getIcByPanel(interaction.message?.id);
    if (!rec) {
      await interaction
        .reply({ embeds: [buildErrorEmbed('Talep kaydı bulunamadı.')], flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }
    if (rec.status !== 'pending') {
      await interaction
        .reply({ content: 'ℹ️ Bu talep zaten karara bağlanmış.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }

    const approved = interaction.customId === 'ic_approve';
    decideIc(rec.panel_message_id, approved ? 'approved' : 'rejected', interaction.user.id);
    const fresh = getIcByPanel(rec.panel_message_id) || { ...rec, status: approved ? 'approved' : 'rejected', decided_by: interaction.user.id };

    await interaction.update({
      embeds: [
        buildIcPanelEmbed({
          userId: fresh.user_id,
          requestedText: fresh.requested_text,
          status: fresh.status,
          decidedBy: fresh.decided_by,
        }),
      ],
      components: [buildIcButtons(true)],
    });
    await interaction
      .followUp({ content: approved ? '✅ Talep onaylandı.' : '❌ Talep reddedildi.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    logger.success(`IC talebi #${rec.id} ${approved ? 'onaylandı' : 'reddedildi'} (${interaction.user.tag})`);
  } catch (err) {
    if (err?.code === 10062) {
      logger.error('Interaction EXPIRED: [ic buton] — kullanıcı "Uygulama yanıt vermedi" gördü.');
      return true;
    }
    logger.error('Interaction failed: ic button.', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.isRepliable()) {
        await interaction.reply({ embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* sessiz geç */
    }
  }
  return true;
}

module.exports = { handleIcMessage, handleIcButton };
