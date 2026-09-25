/**
 * messageReactionAdd - çekiliş katılım girişi (diğer reaksiyonlar yoksayılır).
 */
const logger = require('../utils/logger');
const { handleReactionAdd } = require('../handlers/giveawayHandler');

module.exports = {
  name: 'messageReactionAdd',

  async execute(reaction, user) {
    try {
      await handleReactionAdd(reaction, user);
    } catch (err) {
      logger.error('messageReactionAdd failed.', err);
    }
  },
};
