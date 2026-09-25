/**
 * messageReactionRemove - çekiliş katılım çıkışı (diğer reaksiyonlar yoksayılır).
 */
const logger = require('../utils/logger');
const { handleReactionRemove } = require('../handlers/giveawayHandler');

module.exports = {
  name: 'messageReactionRemove',

  async execute(reaction, user) {
    try {
      await handleReactionRemove(reaction, user);
    } catch (err) {
      logger.error('messageReactionRemove failed.', err);
    }
  },
};
