/**
 * /komutlar - Tüm bot komutlarını kategorili, şık yardım menüsü olarak gösterir.
 * Sağ üstteki rozet: /komutlarpng ile kaydedilen görsel (DB öncelikli) veya KOMUTLAR_IMAGE.
 */
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { getSetting } = require('../database/database');
const logger = require('../utils/logger');

const GROUPS = [
  {
    title: '🎮 Katılım',
    commands: [
      ['/ingame', 'INGAME katılım paneli oluşturur'],
      ['/aktiflik', 'Aktiflik yoklama paneli oluşturur'],
    ],
  },
  {
    title: '🎫 Destek',
    commands: [
      ['/ticketpanel', 'Ticket açma paneli gönderir'],
      ['/ticketpng', 'Ticket panel görselini değiştirir'],
      ['/ticketop', 'En fazla ticket sahiplenen ilk 10 yetkiliyi gösterir'],
      ['/mazeret', 'Mazeret bildirim paneli gönderir'],
      ['/mazeretpng', 'Mazeret panel görselini değiştirir'],
    ],
  },
  {
    title: '🛡️ Guard',
    commands: [
      ['/guardekle', 'Kullanıcıyı Guard whitelistine ekler'],
      ['/guardçıkar', 'Kullanıcıyı Guard whitelistinden çıkarır'],
      ['/guardliste', 'Guard whitelistini listeler'],
      ['/guardsetup', 'Guard sistemini kurar'],
    ],
  },
  {
    title: '🔊 Ses',
    commands: [
      ['/sesgir', 'Botu ses kanalına sokar (kalır)'],
      ['/sescik', 'Botu ses kanalından çıkarır'],
      ['/topluses', 'Sesteki herkesi seçilen kanala taşır'],
    ],
  },
  {
    title: '🛠️ Yönetim',
    commands: [
      ['/setup', 'Log kanallarını kurar'],
      ['/clear', 'Kanaldaki mesajları toplu siler'],
      ['/dmmesaj', 'Sunucudaki üyelere toplu DM gönderir'],
      ['/rolver', 'Seçilen kullanıcıya rol verir'],
      ['/rolal', 'Seçilen kullanıcıdan rol alır'],
      ['/ban', 'Seçilen kullanıcıyı sunucudan banlar'],
      ['/unban', 'Banlı kullanıcının banını açar'],
    ],
  },
  {
    title: '📜 Yardım',
    commands: [
      ['/komutlar', 'Bu yardım menüsünü gösterir'],
      ['/komutlarpng', 'Yardım menüsü görselini değiştirir'],
    ],
  },
];

function getKomutlarImage() {
  try {
    return getSetting('komutlar_image') || config.komutlarImage || null;
  } catch {
    return config.komutlarImage || null;
  }
}

function buildKomutlarEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xeab308) // şerif altını
    .setTitle('📜 Komutlar')
    .setDescription('**Javrex Bot System** komut listesi — ihtiyacın olanı seç, detay için komutu kullan.')
    .setFooter({ text: `${config.botName} | Yardım` })
    .setTimestamp();
  for (const g of GROUPS) {
    embed.addFields({
      name: g.title,
      value: g.commands.map(([cmd, desc]) => `**${cmd}** — ${desc}`).join('\n'),
      inline: false,
    });
  }
  const img = getKomutlarImage();
  if (img) embed.setThumbnail(img);
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder().setName('komutlar').setDescription('Tüm komutları ve ne işe yaradıklarını gösterir.'),
  // Global kapıdan muaf: yardım menüsü herkese açık (kullanım yetkileri ayrıca denetlenir).
  openToEveryone: true,

  async execute(interaction) {
    try {
      return interaction.reply({ embeds: [buildKomutlarEmbed()], flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.error('Interaction failed: /komutlar.', err);
      if (!interaction.replied && !interaction.deferred && interaction.isRepliable()) {
        await interaction.reply({ content: 'Menü gösterilemedi. Lütfen tekrar deneyin.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },

  GROUPS,
  buildKomutlarEmbed,
  getKomutlarImage,
};
