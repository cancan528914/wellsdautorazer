/**
 * Button interaction handler - restart-safe.
 * customId'ler statiktir (ingame_join / ingame_leave / aktiflik_join),
 * hangi mesaja ait olduğu interaction.message.id üzerinden DB'den çözülür.
 * Böylece bot yeniden başlasa bile eski mesajların butonları çalışır.
 *
 * Self-healing: DB'de kaydı olmayan (örn. başka klasör/örnek tarafından açılmış
 * ya da DB'si silinmiş) bir panele basılırsa, customId'den tipi anlaşılıp panel
 * sahiplenilir (adopt) ve çalışmaya devam eder. Eski liste sıfırdan başlar —
 * kullanıcıya bu durum açıkça söylenir, gizlenmez.
 */
const { MessageFlags } = require('discord.js');
const { buildIngameEmbed, buildAktiflikEmbed, buildErrorEmbed } = require('../utils/embeds');
const {
  getSystem,
  upsertSystem,
  deleteSystem,
  setIngameStatus,
  getIngameLists,
  getIngameStatus,
  addAktiflikParticipant,
  getAktiflikList,
} = require('../database/database');
const ingameCmd = require('../commands/ingame');
const aktiflikCmd = require('../commands/aktiflik');
const ticketHandler = require('./ticketHandler');
const { handleIcButton } = require('./icHandler');
const { handleMazeretOpen } = require('./mazeretHandler');
const { handleQuitButton } = require('./quitHandler');
const logger = require('../utils/logger');

const ADOPT_NOTE = '\nℹ️ Not: Bu panel kayıtlarda yoktu, yeniden etkinleştirildi — liste sıfırdan başlatıldı.';

function inferType(customId) {
  if (customId.startsWith('ingame_')) return 'ingame';
  if (customId.startsWith('aktiflik_')) return 'aktiflik';
  return null;
}

async function handleButton(interaction) {
  const { customId } = interaction;

  // Ticket butonları ayrı handler'da (aynı giriş noktası, süre logları korunur)
  if (typeof customId === 'string' && customId.startsWith('ticket_')) {
    return ticketHandler.handleTicketButton(interaction);
  }

  // IC onay + mazeret butonları
  if (customId === 'ic_approve' || customId === 'ic_reject') {
    return handleIcButton(interaction);
  }
  if (customId === 'mazeret_open') {
    return handleMazeretOpen(interaction);
  }
  if (customId === 'quit_roles') {
    return handleQuitButton(interaction);
  }

  if (!['ingame_join', 'ingame_leave', 'aktiflik_join'].includes(customId)) return false;

  try {
    const messageId = interaction.message?.id;
    if (!messageId) {
      return interaction.reply({ embeds: [buildErrorEmbed('Mesaj bilgisi alınamadı.')], flags: MessageFlags.Ephemeral });
    }

    let system = getSystem(messageId);
    let adopted = false;

    if (!system) {
      const inferred = inferType(customId);
      if (!inferred || !interaction.guildId) {
        logger.warn(`Buton bilinmeyen mesaja basıldı: ${messageId} (${customId})`);
        return interaction.reply({
          embeds: [buildErrorEmbed('Bu panel artık aktif değil. Lütfen yeni bir panel oluşturun.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      // Self-healing: paneli sahiplen, boş listeyle devam et
      upsertSystem({
        messageId,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        type: inferred,
        createdBy: interaction.user.id,
      });
      system = getSystem(messageId);
      adopted = true;
      logger.warn(`Yabancı panel sahiplenildi (adopt): ${messageId} type=${inferred} — eski liste kurtarılamaz, sıfırdan başlatıldı.`);
    }

    const userId = interaction.user.id;

    // ---- /ingame butonları ----
    if (system.type === 'ingame' && (customId === 'ingame_join' || customId === 'ingame_leave')) {
      const want = customId === 'ingame_join' ? 'joined' : 'left';
      const current = getIngameStatus(messageId, userId);

      if (current === want && !adopted) {
        return interaction.reply({
          content: want === 'joined' ? '✅ Zaten katılanlar listesindesiniz.' : '✅ Zaten ayrılanlar listesindesiniz.',
          flags: MessageFlags.Ephemeral,
        });
      }

      setIngameStatus(messageId, userId, want);
      const { joined, left } = getIngameLists(messageId);

      await interaction.update({
        embeds: [buildIngameEmbed(joined, left)],
        components: [ingameCmd.buildButtons()],
      });

      // update() zaten cevap sayılır; ek bilgi için followUp (ephemeral)
      await interaction.followUp({
        content:
          (want === 'joined' ? '🟢 INGAME listesine eklendiniz.' : '🔴 Ayrılanlar listesine eklendiniz.') +
          (adopted ? ADOPT_NOTE : ''),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ---- /aktiflik butonu ----
    if (system.type === 'aktiflik' && customId === 'aktiflik_join') {
      const isNew = addAktiflikParticipant(messageId, userId);
      const list = getAktiflikList(messageId);

      await interaction.update({
        embeds: [buildAktiflikEmbed(list)],
        components: [aktiflikCmd.buildButtons()],
      });

      await interaction.followUp({
        content:
          (isNew
            ? `🟢 Aktiflik listesine eklendiniz. (Toplam: ${list.length})`
            : `✅ Zaten listedesiniz. (Toplam: ${list.length})`) + (adopted ? ADOPT_NOTE : ''),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // Tip/customId uyuşmazlığı (örn. aktiflik mesajında ingame butonu - normalde olmaz)
    logger.warn(`Tip/customId uyuşmazlığı: type=${system.type} customId=${customId}`);
    return interaction.reply({
      embeds: [buildErrorEmbed('Bu buton bu panel için geçerli değil.')],
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    // Mesaj silinmişse Discord 10008 (Unknown Message) döner -> DB kaydını temizle
    if (err?.code === 10008 && interaction.message?.id) {
      deleteSystem(interaction.message.id);
      logger.warn(`Silinmiş mesajın DB kaydı temizlendi: ${interaction.message.id}`);
    } else {
      logger.error(`Interaction failed: button ${customId}`, err);
    }

    try {
      if (interaction.deferred || interaction.replied) {
        // update sonrası followUp edilebilir
        await interaction.followUp({
          embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.')],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.isRepliable()) {
        await interaction.reply({
          embeds: [buildErrorEmbed('İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.')],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      /* cevap verilemediyse sessiz geç (interaction süresi dolmuş olabilir) */
    }
    return true;
  }
}

module.exports = { handleButton, inferType };
