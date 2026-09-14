/**
 * guildMemberUpdate - rol değişimlerini DB'ye işler (quit anında eski roller bilinsin diye).
 * Hafif işlemdir (yerel SQLite yazma), diğer güncellemeler yoksayılır.
 */
const logger = require('../utils/logger');
const { handleMemberUpdate } = require('../handlers/quitHandler');

module.exports = {
  name: 'guildMemberUpdate',

  async execute(oldMember, newMember) {
    try {
      await handleMemberUpdate(oldMember, newMember);
    } catch (err) {
      logger.error('guildMemberUpdate failed.', err);
    }
  },
};
