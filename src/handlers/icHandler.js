/**
 * IC isim onay sistemi.
 * Ayarlı kanala yazılan her mesaj için Onayla/Reddet panelli kayıt açılır.
 * Mesaj içeriği API'den çekilir (MessageContent intent'i gerekmez).
 * Buton customId'leri statiktir → restart-safe (panel mesaj ID üzerinden çözülür).
 */
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { canManageTickets } = require('../utils/permissions');
const { buildErrorEmbed, buildIcPanelEmbed, buildIcButtons } = require('../utils/embeds');
const { createIcRequest, getIcByPanel, getPendingIc, decideIc, setIcPanel } = require('../database/database');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Talep metnini çöz: önce event içeriği (MessageContent intent'i açıksa anında),
 * yoksa API'den kısa retry ile çek. { text, ok } döner.
 */
async function resolveIcText(message) {
  const direct = String(message.content || '').trim();
  if (direct) return { text: direct.slice(0, 1000), ok: true };
  for (let i = 0; i < 3; i++) {
    try {
      const full = await message.channel.messages.fetch(message.id);
      const t = String(full?.content || '').trim();
      if (t) return { text: t.slice(0, 1000), ok: true };
      return { text: '', ok: true }; // mesaj var ama metin yok (sadece ek olabilir)
    } catch (err) {
      if (i === 2) logger.warn(`IC talep içeriği okunamadı: ${message.id} (${err.code || err.message})`);
      else await sleep(1000);
    }
  }
  return { text: '', ok: false };
}

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

    const { text, ok } = await resolveIcText(message);

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
          userTag: user.tag,
          requestedText: text,
          unreadable: !ok,
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

    // Onayda: kullanıcının yazdığı isim doğrudan takma ad yapılır.
    // (Üye tek sefer çekilir: hem takma ad hem panel etiketi için kullanılır.)
    let targetMember = null;
    try {
      targetMember = (await interaction.guild?.members?.fetch?.(fresh.user_id)) || null;
    } catch {
      targetMember = null;
    }
    const userTag = targetMember?.user?.tag || null;

    let nickNote = '';
    if (approved) {
      const wanted = String(fresh.requested_text || '').trim().slice(0, 32);
      if (!wanted) {
        nickNote = '\n⚠️ Talep metni okunamadığı/boş olduğu için takma ad değiştirilemedi.';
      } else if (!targetMember) {
        nickNote = '\n⚠️ Kullanıcı sunucuda bulunamadı, takma ad değiştirilemedi.';
      } else {
        const blockReason = diagnoseNickname(interaction.guild, targetMember);
        if (blockReason) {
          nickNote = `\n⚠️ Takma ad değiştirilemedi (${blockReason})`;
        } else {
          try {
            await targetMember.setNickname(wanted, `IC onay: ${interaction.user.tag}`);
            nickNote = `\n✏️ Takma ad değiştirildi: **${wanted}**`;
          } catch (err) {
            logger.warn(`IC takma ad değiştirilemedi (${fresh.user_id}): ${err.code || err.message}`);
            nickNote = '\n⚠️ Takma ad değiştirilemedi (beklenmeyen API hatası, loga yazıldı).';
          }
        }
      }
    }

    await interaction.update({
      embeds: [
        buildIcPanelEmbed({
          userId: fresh.user_id,
          userTag,
          requestedText: fresh.requested_text,
          status: fresh.status,
          decidedBy: fresh.decided_by,
        }),
      ],
      components: [buildIcButtons(true)],
    });
    await interaction
      .followUp({ content: `${approved ? '✅ Talep onaylandı.' : '❌ Talep reddedildi.'}${nickNote}`, flags: MessageFlags.Ephemeral })
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

module.exports = { handleIcMessage, handleIcButton, diagnoseNickname };

/**
 * Takma ad değişiminin BAŞTAN başarısız olacağı durumları tespit eder.
 * @returns {string|null} engel yoksa null, varsa kullanıcıya gösterilecek sebep
 */
function diagnoseNickname(guild, targetMember) {
  try {
    const me = guild?.members?.me;
    if (!me) return 'bot üye önbelleğinde bulunamadı (tekrar deneyin)';
    if (!me.permissions?.has?.(PermissionFlagsBits.ManageNicknames)) {
      return 'bot rolünde **Üye Adlarını Yönet** yetkisi kapalı — Sunucu Ayarları → Roller → bot rolü → yetkilerden açın (rol sırası yetmez, izin şart)';
    }
    if (targetMember.id === guild.ownerId) {
      return 'sunucu sahibinin takma adı Discord tarafından değiştirilemez';
    }
    const botTop = me.roles?.highest?.position ?? 0;
    const tgtTop = targetMember.roles?.highest?.position ?? 0;
    if (botTop <= tgtTop) {
      return 'bot rolü hedefin rolünden üstte olmalı — bot rolünü rol listesinde hedefin rollerinin üstüne sürükleyin';
    }
    return null;
  } catch {
    return null; // teşhis patlarsa denemeye devam et
  }
}
