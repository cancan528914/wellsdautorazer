/**
 * /dmmesaj - Sunucudaki üyelere kontrollü toplu DM.
 * - Sadece yetkililer (ADMIN_ROLE_ID / Administrator / ManageGuild).
 * - Botlara göndermez, kendine göndermez.
 * - Paralel işçi havuzu (varsayılan 5) + grup arası nefes payı ile hızlı gönderim.
 *   DM kanal açma Discord'un en katı limitidir; eşzamanlılık 10 ile sınırlıdır,
 *   429 cevaplarına lib otomatik saygı gösterir (bekleyip devam eder).
 * - Sonuç ephemeral özet olarak gösterilir.
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { buildDmResultEmbed, buildErrorEmbed } = require('../utils/embeds');
const { canUseDm } = require('../utils/permissions');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limit güvenlik sınırları: DM kanal açma Discord'un en katı endpoint'idir.
// Sınırsız paralellik 429 yağmuru doğurur; o yüzden işçi sayısı tavanlıdır.
const MIN_DELAY_MS = 100;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;
const PROGRESS_EVERY = 10;

function resolveDelayMs() {
  return Math.max(MIN_DELAY_MS, config.dm.delayMs || 0);
}

function resolveConcurrency() {
  const n = parseInt(config.dm.concurrency, 10);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dmmesaj')
    .setDescription('Sunucudaki üyelere DM gönderir (sadece yetkililer).')
    .addStringOption((opt) =>
      opt.setName('mesaj').setDescription('Gönderilecek mesaj').setRequired(true).setMaxLength(1800),
    ),

  async execute(interaction) {
    if (!canUseDm(interaction.member)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Bu komutu kullanma yetkiniz yok.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const text = interaction.options.getString('mesaj', true).trim();
    if (!text) {
      return interaction.reply({ embeds: [buildErrorEmbed('Mesaj boş olamaz.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply({ embeds: [buildErrorEmbed('Bu komut sadece sunucuda kullanılabilir.')] });
      }

      // Tüm üyeleri çek (büyük sunucularda biraz sürebilir)
      const members = await guild.members.fetch();
      let targets = [...members.values()].filter((m) => !m.user.bot && m.user.id !== interaction.client.user.id);

      // Rol filtresi: ayarlıysa sadece bu role sahip üyelere gönderilir
      const targetRoleId = config.dm.targetRoleId;
      if (targetRoleId) {
        targets = targets.filter((m) => m.roles?.cache?.has(targetRoleId));
        logger.info(`DM rol filtresi aktif: ${targetRoleId} (${targets.length} hedef)`);
      }

      if (config.dm.maxTargets > 0) targets = targets.slice(0, config.dm.maxTargets);

      let success = 0;
      let failed = 0;
      const delayMs = resolveDelayMs();
      const concurrency = resolveConcurrency();

      logger.info(`DM gönderimi başladı: ${targets.length} hedef (${concurrency} paralel, ${delayMs}ms aralıkla, başlatan: ${interaction.user.tag})`);

      const prefix = `📩 **${guild.name}** duyurusu:\n\n`;

      await interaction.editReply({ content: `⏳ Gönderiliyor... 0/${targets.length}` }).catch(() => {});

      let done = 0;
      for (let i = 0; i < targets.length; i += concurrency) {
        const chunk = targets.slice(i, i + concurrency);
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.allSettled(
          chunk.map(async (member) => {
            try {
              await member.send(`${prefix}${text}`);
              return true;
            } catch {
              // DM kapalı / engelli / API hatası -> başarısız say, devam et
              return false;
            }
          }),
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value === true) success++;
          else failed++;
        }
        done += chunk.length;

        // Canlı ilerleme (kullanıcı kör beklemez); edit hatası akışı bozmaz
        if (done % PROGRESS_EVERY === 0 || done === targets.length) {
          await interaction.editReply({ content: `⏳ Gönderiliyor... ${done}/${targets.length}` }).catch(() => {});
        }

        // Gruplar arası nefes payı (son gruptan sonra bekleme)
        if (i + concurrency < targets.length && delayMs > 0) await sleep(delayMs);
      }

      const total = success + failed;
      logger.success(`DM gönderimi tamamlandı: başarılı=${success} başarısız=${failed} toplam=${total}`);

      await interaction.editReply({
        content: total === 0 ? 'ℹ️ Gönderilecek kimse bulunamadı (rol filtresi buysa rolü kontrol edin).' : undefined,
        embeds: [buildDmResultEmbed(success, failed, total)],
      });
    } catch (err) {
      logger.error('Interaction failed: /dmmesaj çalışırken hata.', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('DM gönderimi sırasında bir hata oluştu.')] }).catch(() => {});
    }
  },

  resolveDelayMs,
  resolveConcurrency,
  MIN_DELAY_MS,
  MAX_CONCURRENCY,
};
