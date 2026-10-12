/**
 * /oyuncular — FiveM sunucusundaki tüm aktif oyuncuları listeler.
 *
 * Bu komut /aktifoyuncular ile AYNI işi yapar. Mantık burada YENİDEN yazılmaz:
 * execute doğrudan kanonik komut modülüne devreder. Böylece iki komut
 * arasında davranış farkı oluşamaz ve bakım tek yerde kalır.
 */
const { SlashCommandBuilder } = require('discord.js');
const aktifOyuncular = require('./aktifoyuncular');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('oyuncular')
    .setDescription('FiveM sunucusundaki tüm aktif oyuncuları listeler.'),
  openToEveryone: true,

  execute(interaction) {
    return aktifOyuncular.execute(interaction);
  },
};