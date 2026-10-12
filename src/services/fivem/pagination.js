/**
 * FiveM liste pagination — buton oturumları (bellek içi, TTL'li).
 *
 * - customId'ler statiktir: fivem_p_first | fivem_p_prev | fivem_p_next | fivem_p_last
 * - Hangi liste olduğu interaction.message.id üzerinden çözülür (butonda state taşınmaz).
 * - Sayfa değişimi YENİ API isteği yapmaz: komut anındaki snapshot render edilir (spec §37).
 * - Restart sonrası oturumlar kaybolur → kullanıcıya "komutu tekrar çalıştırın" denir (sessiz crash yok).
 * - Butonlara SADECE komutu kullanan basabilir; mesajın kendisi herkese açıktır (spec §10-11).
 */
const { MessageFlags } = require('discord.js');
const config = require('../../config');
const logger = require('../../utils/logger');
const { buildErrorEmbed } = require('../../utils/embeds');

const PREFIX = 'fivem_p_';
const FIRST = `${PREFIX}first`;
const PREV = `${PREFIX}prev`;
const NEXT = `${PREFIX}next`;
const LAST = `${PREFIX}last`;
const VALID_IDS = new Set([FIRST, PREV, NEXT, LAST]);
const MAX_SESSIONS = 200;

// messageId -> { type:'players'|'tag', term, ownerId, players, hostname, maxClients, latencyMs, totalPages, createdAt }
const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > config.fivem.sessionTtlMs) sessions.delete(k);
  }
  if (sessions.size > MAX_SESSIONS) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [k] of sorted.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(k);
  }
}

function totalPagesFor(count) {
  return Math.max(1, Math.ceil(count / config.fivem.pageSize));
}

function createSession(messageId, data) {
  sweep();
  sessions.set(String(messageId), { ...data, createdAt: Date.now() });
}

function getSession(messageId) {
  const s = sessions.get(String(messageId));
  if (!s) return null;
  if (Date.now() - s.createdAt > config.fivem.sessionTtlMs) {
    sessions.delete(String(messageId));
    return null;
  }
  return s;
}

function pageSlice(players, page) {
  const size = config.fivem.pageSize;
  const start = (page - 1) * size;
  return players.slice(start, start + size);
}

function isPaginationButton(customId) {
  return typeof customId === 'string' && VALID_IDS.has(customId);
}

/**
 * Pagination butonlarını işler. buttonHandler'dan çağrılır.
 * @returns {Promise<boolean>} true = ele alındı (bilinmeyen buton değil)
 */
async function handlePaginationButton(interaction, renderPage) {
  const { customId } = interaction;
  if (!isPaginationButton(customId)) return false;
  try {
    const messageId = interaction.message?.id;
    const session = messageId ? getSession(messageId) : null;
    if (!session) {
      await interaction
        .reply({
          embeds: [buildErrorEmbed('Bu liste artık güncel değil. Lütfen komutu tekrar çalıştırın.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return true;
    }
    // Sadece komut sahibi çevirebilir (mesaj herkese açık kalır)
    if (String(interaction.user.id) !== String(session.ownerId)) {
      await interaction
        .reply({ content: '❌ Sayfaları yalnızca komutu kullanan kişi çevirebilir.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return true;
    }
    const total = totalPagesFor(session.players.length);
    let page = session.page || 1;
    if (customId === FIRST) page = 1;
    else if (customId === PREV) page = Math.max(1, page - 1);
    else if (customId === NEXT) page = Math.min(total, page + 1);
    else if (customId === LAST) page = total;
    session.page = page;

    const payload = renderPage(session, page, total);
    await interaction.update(payload).catch(async () => {
      // Mesaj silinmişse (10008) oturumu temizle
      sessions.delete(String(messageId));
    });
    return true;
  } catch (err) {
    logger.error(`Interaction failed: button ${customId} (fivem pagination).`, err);
    try {
      if (!interaction.replied && !interaction.deferred && interaction.isRepliable()) {
        await interaction.reply({ embeds: [buildErrorEmbed('Sayfa değiştirilemedi.')], flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* sessiz geç */
    }
    return true;
  }
}

module.exports = {
  PREFIX,
  FIRST,
  PREV,
  NEXT,
  LAST,
  createSession,
  getSession,
  pageSlice,
  totalPagesFor,
  isPaginationButton,
  handlePaginationButton,
  _sessions: sessions,
};
