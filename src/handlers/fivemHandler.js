/**
 * FiveM pagination buton handler — /aktifoyuncular ve /tag sayfa çevirme.
 * customId: fivem_p_first | fivem_p_prev | fivem_p_next | fivem_p_last (statik).
 * Sayfa verisi oturum snapshot'ından gelir; YENİ API isteği yapılmaz.
 */
const { pagination } = require('../services/fivem');
const { buildPagedPayload } = require('../utils/fivemEmbeds');

function renderPage(session, page, total) {
  return buildPagedPayload(session, page, total);
}

async function handleFivemButton(interaction) {
  return pagination.handlePaginationButton(interaction, renderPage);
}

module.exports = { handleFivemButton, renderPage };
