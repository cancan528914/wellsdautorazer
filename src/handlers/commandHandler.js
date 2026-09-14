/**
 * Slash command yükleyici: src/commands/*.js dosyalarını client.commands koleksiyonuna yükler.
 */
const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');
const logger = require('../utils/logger');

function loadCommands(client) {
  client.commands = new Collection();
  const commandsDir = path.join(__dirname, '..', 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    try {
      const cmd = require(path.join(commandsDir, file));
      if (!cmd?.data?.name || typeof cmd.execute !== 'function') {
        logger.warn(`Komut atlandı (eksik data/execute): ${file}`);
        continue;
      }
      client.commands.set(cmd.data.name, cmd);
      logger.info(`Komut yüklendi: /${cmd.data.name}`);
    } catch (err) {
      logger.error(`Komut yüklenemedi: ${file}`, err);
    }
  }

  return client.commands;
}

module.exports = { loadCommands };
