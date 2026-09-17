/**
 * guildMemberAdd — sunucuya yeni üye katıldığında join log gönderir.
 */
const logger = require('../utils/logger');
const { handleMemberAdd } = require('../handlers/joinHandler');

module.exports = {
  name: 'guildMemberAdd',

  async execute(member) {
    try {
      await handleMemberAdd(member);
    } catch (err) {
      logger.error('guildMemberAdd failed.', err);
    }
  },
};
