/**
 * /idbul — FiveM aktif oyuncuları arasında İSİM araması yapar.
 *
 * Bu komut /tag ile AYNI işi yapar (case-insensitive substring arama).
 * Mantık burada YENİDEN yazılmaz: execute kanonik komut modülüne devreder.
 */
const { SlashCommandBuilder } = require('discord.js');
const tag = require('./tag');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('idbul')
    .setDescription('FiveM aktif oyuncularında isim arar.')
    .addStringOption((o) =>
      o.setName('isim').setDescription('Aranan metin (isim içinde geçer)').setRequired(true).setMaxLength(64),
    ),
  openToEveryone: true,

  execute(interaction) {
    return tag.execute(interaction);
  },
};