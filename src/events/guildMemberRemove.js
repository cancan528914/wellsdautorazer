/**
 * guildMemberRemove - sunucudan ayrılan üye için quit paneli.
 */
const logger = require('../utils/logger');
const { handleMemberRemove } = require('../handlers/quitHandler');

module.exports = {
  name: 'guildMemberRemove',

  async execute(member) {
    try {
      await handleMemberRemove(member);
    } catch (err) {
      logger.error('guildMemberRemove failed.', err);
    }
  },
};
