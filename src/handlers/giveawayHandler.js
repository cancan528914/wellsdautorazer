/**
 * Çekiliş sistemi: oluşturma / reaksiyon katılım / sonuçlandırma / reroll / restore.
 * - Tek panel mesajı üzerinden yürür (ayrı katılım mesajı yok — daha stabil).
 * - Tüm durum DB'de (endAt); timer'lar sadece tetikleyici, restart-safe.
 * - Başarılı sonuç public; hatalar ephemeral/DM, crash asla yok.
 */
const crypto = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const logger = require('../utils/logger');
const { buildErrorEmbed } = require('../utils/embeds');
const { canManageTickets } = require('../utils/permissions');
const {
  GIVEAWAY_EMOJI,
  buildGiveawayEmbed,
  buildGiveawayEndedEmbed,
  buildGiveawayResultEmbed,
} = require('../utils/giveawayEmbeds');
const {
  createGiveaway,
  getGiveaway,
  getGiveawayByMessage,
  getActiveGiveaways,
  setGiveawayPanelMessage,
  setGiveawayResultMessage,
  addGiveawayParticipant,
  removeGiveawayParticipant,
  getGiveawayParticipants,
  countGiveawayParticipants,
  claimGiveawayFinalize,
  finishGiveaway,
  updateGiveawayWinners,
} = require('../database/database');

const REROLL_PREFIX = 'giveaway_reroll:';
const timers = new Map(); // giveawayId -> timeout
const refreshTimers = new Map(); // giveawayId -> timeout (panel debounce)

function parseIdList(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Fisher-Yates çekilişi (crypto RNG). excluded listedekiler havuza girmez.
 * Aynı kullanıcı iki kez seçilmez. Test edilebilir saf fonksiyon.
 */
function drawWinners(participants, count, excluded = []) {
  const banned = new Set((excluded || []).map(String));
  const pool = [...new Set((participants || []).map(String))].filter((id) => id && !banned.has(id));
  const n = Math.min(Math.max(0, Number(count) || 0), pool.length);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function rerollRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${REROLL_PREFIX}${giveawayId}`).setLabel('🔄 Reroll').setStyle(ButtonStyle.Secondary),
  );
}

function clearTimer(id) {
  try {
    const t = timers.get(Number(id));
    if (t) clearTimeout(t);
    timers.delete(Number(id));
  } catch {
    /* ignore */
  }
}

function scheduleGiveaway(client, g) {
  try {
    clearTimer(g.id);
    const delay = Number(g.end_at) - Date.now();
    if (delay <= 0) {
      finalizeGiveaway(client, g.id, { reason: 'süre doldu (açılışta)' }).catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      timers.delete(Number(g.id));
      finalizeGiveaway(client, g.id, { reason: 'süre doldu' }).catch(() => {});
    }, delay);
    if (typeof t.unref === 'function') t.unref();
    timers.set(Number(g.id), t);
  } catch (err) {
    logger.error(`[Çekiliş] zamanlama hatası #${g?.id}.`, err);
  }
}

/** Paneli debounce ile günceller (reaksiyon yağmurunda rate-limit koruması). */
function schedulePanelRefresh(client, giveawayId) {
  try {
    const id = Number(giveawayId);
    if (refreshTimers.has(id)) return;
    const t = setTimeout(() => {
      refreshTimers.delete(id);
      refreshPanel(client, id).catch(() => {});
    }, 2500);
    if (typeof t.unref === 'function') t.unref();
    refreshTimers.set(id, t);
  } catch {
    /* ignore */
  }
}

async function refreshPanel(client, giveawayId) {
  try {
    const g = getGiveaway(giveawayId);
    if (!g || g.status !== 'active' || !g.panel_message_id) return;
    const channel = await client.channels.fetch(g.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    const msg = await channel.messages.fetch(g.panel_message_id).catch(() => null);
    if (!msg) return;
    const count = countGiveawayParticipants(g.id);
    await msg.edit({ embeds: [buildGiveawayEmbed(g, count)] }).catch((err) => {
      if (err?.code !== 10008 && err?.code !== 10003) logger.warn(`[Çekiliş] panel güncellenemedi #${g.id}: ${err.code || err.message}`);
    });
  } catch (err) {
    logger.warn(`[Çekiliş] refreshPanel hatası #${giveawayId}: ${err.code || err.message}`);
  }
}

/** Katılım reddi: reaksiyonu kaldır + DM ile bildir (ikisi de best-effort). */
async function rejectJoin(reaction, user, reason) {
  try {
    await reaction.users.remove(user.id).catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    const dm = await user.createDM().catch(() => null);
    if (dm) await dm.send(`🎉 Çekilişe katılamadın: ${reason}`).catch(() => {});
  } catch {
    /* DM kapalı olabilir */
  }
}

async function resolveReaction(reaction) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
  } catch (err) {
    logger.warn(`[Çekiliş] reaksiyon fetch hatası: ${err.code || err.message}`);
    return null;
  }
  return reaction;
}

async function handleReactionAdd(reaction, user) {
  try {
    if (!user || user.bot) return;
    reaction = await resolveReaction(reaction);
    if (!reaction || reaction.emoji?.name !== GIVEAWAY_EMOJI) return;
    const message = reaction.message;
    if (!message?.guild) return;
    const g = getGiveawayByMessage(message.id);
    if (!g || g.status !== 'active') return;

    const guild = message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    // Rol şartı (rol silinmişse kısıtlama yok sayılır)
    if (g.required_role_id) {
      const role = await guild.roles.fetch(g.required_role_id).catch(() => null);
      if (role && !member.roles?.cache?.has(g.required_role_id)) {
        logger.info(`[Çekiliş] rol reddi #${g.id}: ${user.tag}`);
        await rejectJoin(reaction, user, 'Bu çekilişe katılmak için gerekli role sahip değilsin.');
        return;
      }
    }

    // Kişi sınırı
    const max = Number(g.max_participants) || 0;
    const current = countGiveawayParticipants(g.id);
    if (max > 0 && current >= max) {
      logger.info(`[Çekiliş] limit reddi #${g.id}: ${user.tag}`);
      await rejectJoin(reaction, user, 'Çekiliş dolu (kişi sınırına ulaşıldı).');
      return;
    }

    const { added, count } = addGiveawayParticipant(g.id, user.id);
    if (added) {
      logger.info(`[Çekiliş] katıldı #${g.id}: ${user.tag} (${count}${max > 0 ? `/${max}` : ''})`);
      schedulePanelRefresh(reaction.client, g.id);
    }
  } catch (err) {
    logger.error('[Çekiliş] reactionAdd hatası.', err);
  }
}

async function handleReactionRemove(reaction, user) {
  try {
    if (!user || user.bot) return;
    reaction = await resolveReaction(reaction);
    if (!reaction || reaction.emoji?.name !== GIVEAWAY_EMOJI) return;
    const message = reaction.message;
    if (!message) return;
    const g = getGiveawayByMessage(message.id);
    if (!g || g.status !== 'active') return;
    const { removed, count } = removeGiveawayParticipant(g.id, user.id);
    if (removed) {
      logger.info(`[Çekiliş] ayrıldı #${g.id}: ${user.tag || user.id} (${count})`);
      schedulePanelRefresh(reaction.client, g.id);
    }
  } catch (err) {
    logger.error('[Çekiliş] reactionRemove hatası.', err);
  }
}

/** Küçük eşzamanlılık havuzu (toplu üye doğrulama için). */
async function mapPool(items, size, fn) {
  const out = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        out.push(await fn(item));
      } catch {
        out.push(null);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Katılımcıları doğrula: sunucuda mı + rol şartı. Dönüş: geçerli userId listesi. */
async function validateParticipants(guild, giveaway, userIds) {
  let role = null;
  if (giveaway.required_role_id) {
    role = await guild.roles.fetch(giveaway.required_role_id).catch(() => null);
    if (!role) logger.warn(`[Çekiliş] gerekli rol silinmiş #${giveaway.id} — rol şartı yok sayılıyor.`);
  }
  const checked = await mapPool(userIds, 5, async (uid) => {
    const member = await guild.members.fetch(uid).catch(() => null);
    if (!member) return null;
    if (role && !member.roles?.cache?.has(role.id)) return null;
    return String(uid);
  });
  return checked.filter(Boolean);
}

/**
 * Çekilişi sonuçlandırır. Çift-finalize kilidi DB'dedir (claimGiveawayFinalize).
 * Panel yoksa/kanal yoksa da DB kapanır; sonuç mesajı best-effort gönderilir.
 */
async function finalizeGiveaway(client, giveawayId, { reason = '' } = {}) {
  const id = Number(giveawayId);
  if (!claimGiveawayFinalize(id)) return null; // başkası sonuçlandırıyor/bitirmiş
  clearTimer(id);
  let g = getGiveaway(id);
  if (!g) return null;
  logger.info(`[Çekiliş] sonuçlandırılıyor #${id}${reason ? ` (${reason})` : ''}`);

  let channel = null;
  try {
    channel = await client.channels.fetch(g.channel_id).catch(() => null);
    if (channel && !channel.isTextBased?.()) channel = null;
  } catch {
    channel = null;
  }
  if (!channel) {
    logger.warn(`[Çekiliş] kanal bulunamadı #${id} — sonuçsuz kapatılıyor.`);
    finishGiveaway(id, [], parseIdList(g.excluded));
    return { giveaway: getGiveaway(id), winners: [] };
  }

  const guild = channel.guild;
  const rawParticipants = getGiveawayParticipants(id);
  const valid = guild ? await validateParticipants(guild, g, rawParticipants) : [];
  const winners = drawWinners(valid, Number(g.winner_count) || 1);
  const excluded = [...new Set([...parseIdList(g.excluded), ...winners])];
  finishGiveaway(id, winners, excluded);
  g = getGiveaway(id) || g;
  const count = valid.length;

  // Paneli kapat
  try {
    const panelMsg = g.panel_message_id ? await channel.messages.fetch(g.panel_message_id).catch(() => null) : null;
    if (panelMsg) {
      await panelMsg.edit({ embeds: [buildGiveawayEndedEmbed(g, count, winners)] }).catch((err) => {
        logger.warn(`[Çekiliş] kapanış paneli düzenlenemedi #${id}: ${err.code || err.message}`);
      });
    }
  } catch (err) {
    logger.warn(`[Çekiliş] panel kapatma hatası #${id}: ${err.code || err.message}`);
  }

  // Sonuç mesajı (+ reroll butonu, havuz boş değilse)
  try {
    const payload = { embeds: [buildGiveawayResultEmbed(g, winners)] };
    if (valid.length > 0) payload.components = [rerollRow(id)];
    const content = winners.length ? `🎉 ${winners.map((w) => `<@${w}>`).join(' ')}` : undefined;
    const sent = await channel.send({ ...(content ? { content } : {}), ...payload });
    if (sent?.id) setGiveawayResultMessage(id, sent.id);
  } catch (err) {
    logger.warn(`[Çekiliş] sonuç mesajı gönderilemedi #${id}: ${err.code || err.message}`);
  }

  logger.success(`[Çekiliş] bitti #${id}: ${winners.length} kazanan / ${count} katılımcı`);
  return { giveaway: g, winners };
}

/** 🔄 Reroll: staff-only, eski kazananlar hariç, yeni sonuç mesajı gönderir. */
async function handleReroll(interaction) {
  const EPH = { flags: MessageFlags.Ephemeral };
  try {
    const id = Number(String(interaction.customId || '').split(':')[1]);
    if (!Number.isFinite(id)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Geçersiz çekiliş.')], ...EPH }).catch(() => {});
    }
    if (!canManageTickets(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu işlem için ticket yetkilisi olmalısınız.')], ...EPH }).catch(() => {});
    }
    const g = getGiveaway(id);
    if (!g || g.status !== 'ended') {
      return interaction.reply({ embeds: [buildErrorEmbed('Bu çekiliş için reroll yapılamaz (aktif ya da bulunamadı).')], ...EPH }).catch(() => {});
    }
    await interaction.deferUpdate().catch(() => {});
    const channel = interaction.channel;
    const guild = interaction.guild;
    if (!channel?.isTextBased?.() || !guild) {
      return interaction.followUp({ embeds: [buildErrorEmbed('Kanal bulunamadı.')], ...EPH }).catch(() => {});
    }
    const rawParticipants = getGiveawayParticipants(id);
    const valid = await validateParticipants(guild, g, rawParticipants);
    const excluded = [...new Set([...parseIdList(g.excluded), ...parseIdList(g.winners)])];
    const winners = drawWinners(valid, Number(g.winner_count) || 1, excluded);
    if (!winners.length) {
      return interaction.followUp({ content: 'ℹ️ Reroll için uygun aday kalmadı (herkes daha önce kazandı veya elendi).', ...EPH }).catch(() => {});
    }
    const newExcluded = [...new Set([...excluded, ...winners])];
    updateGiveawayWinners(id, winners, newExcluded);
    const fresh = getGiveaway(id) || g;
    const content = `🔄 Reroll! 🎉 ${winners.map((w) => `<@${w}>`).join(' ')}`;
    const sent = await channel.send({ content, embeds: [buildGiveawayResultEmbed({ ...fresh, prize: g.prize, host_id: g.host_id }, winners)], components: [rerollRow(id)] }).catch((err) => {
      logger.warn(`[Çekiliş] reroll mesajı gönderilemedi #${id}: ${err.code || err.message}`);
      return null;
    });
    if (sent?.id) setGiveawayResultMessage(id, sent.id);
    logger.success(`[Çekiliş] reroll #${id}: ${winners.join(',')} (yapan: ${interaction.user.tag})`);
    return true;
  } catch (err) {
    logger.error('[Çekiliş] reroll hatası.', err);
    try {
      if (interaction.deferred) await interaction.followUp({ embeds: [buildErrorEmbed('Reroll sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral });
      else await interaction.reply({ embeds: [buildErrorEmbed('Reroll sırasında bir hata oluştu.')], flags: MessageFlags.Ephemeral });
    } catch {
      /* ignore */
    }
    return true;
  }
}

/**
 * /çekiliş oluşturma akışı (komut deferReply sonrası çağrılır).
 * Dönüş: panel mesajı. Hata durumunda throw (komut yakalar).
 */
async function createGiveawayFlow(interaction, { prize, durationSec, winnerCount, maxParticipants, requiredRole }) {
  const guild = interaction.guild;
  const channel = interaction.channel;
  if (!channel?.isTextBased?.()) throw new Error('Bu komut yalnızca metin kanalında kullanılabilir.');

  const now = Date.now();
  const id = createGiveaway({
    guildId: guild.id,
    channelId: channel.id,
    prize,
    durationSec,
    endAt: now + durationSec * 1000,
    winnerCount,
    maxParticipants,
    requiredRoleId: requiredRole ? requiredRole.id : null,
    hostId: interaction.user.id,
  });

  let g = getGiveaway(id);
  const msg = await channel.send({ embeds: [buildGiveawayEmbed(g, 0)] });
  setGiveawayPanelMessage(id, msg.id);
  try {
    await msg.react(GIVEAWAY_EMOJI);
  } catch (err) {
    logger.warn(`[Çekiliş] bot reaksiyonu bırakılamadı #${id}: ${err.code || err.message} (katılım yine de emojiyle mümkün)`);
  }
  g = getGiveaway(id);
  scheduleGiveaway(interaction.client, g);
  logger.success(`[Çekiliş] oluşturuldu #${id}: "${prize}" (${durationSec}sn, kazanan:${winnerCount}, limit:${maxParticipants || 'yok'})`);
  return msg;
}

/** Restart/kapanış sonrası aktif çekilişleri geri yükler: reconcile + timer/finalize. */
async function restoreGiveaways(client) {
  let list = [];
  try {
    list = getActiveGiveaways();
  } catch (err) {
    logger.error('[Çekiliş] aktif liste okunamadı.', err);
    return { restored: 0, finished: 0 };
  }
  if (!list.length) {
    logger.info('[Çekiliş] geri yüklenecek aktif çekiliş yok.');
    return { restored: 0, finished: 0 };
  }
  let restored = 0;
  let finished = 0;
  for (const g of list) {
    try {
      // Panel hâlâ duruyor mu? Yoksa self-heal ile yeniden gönder.
      let panelOk = false;
      try {
        const channel = await client.channels.fetch(g.channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          const msg = g.panel_message_id ? await channel.messages.fetch(g.panel_message_id).catch(() => null) : null;
          if (msg) {
            panelOk = true;
            // Reaksiyon yağmuru uzlaşması: bot kapalıyken basanları içeri al.
            await reconcileReactions(client, getGiveaway(g.id) || g, msg).catch(() => {});
          } else {
            const count = countGiveawayParticipants(g.id);
            const fresh = await channel.send({ embeds: [buildGiveawayEmbed(getGiveaway(g.id) || g, count)] }).catch(() => null);
            if (fresh?.id) {
              setGiveawayPanelMessage(g.id, fresh.id);
              await fresh.react(GIVEAWAY_EMOJI).catch(() => {});
              panelOk = true;
              logger.warn(`[Çekiliş] panel yeniden gönderildi #${g.id} (eski mesaj silinmiş).`);
            }
          }
        }
      } catch {
        /* tek çekiliş hatası diğerlerini engellemez */
      }
      if (!panelOk) {
        logger.warn(`[Çekiliş] kanal/panel yok #${g.id} — sonuçsuz kapatılıyor.`);
        finishGiveaway(g.id, [], parseIdList(g.excluded));
        finished++;
        continue;
      }
      if (Number(g.end_at) <= Date.now()) {
        await finalizeGiveaway(client, g.id, { reason: 'süre dolmuş (restart sonrası)' }).catch(() => {});
        finished++;
      } else {
        scheduleGiveaway(client, getGiveaway(g.id) || g);
        restored++;
      }
    } catch (err) {
      logger.warn(`[Çekiliş] restore hatası #${g.id}: ${err.code || err.message}`);
    }
  }
  logger.info(`[Çekiliş] restore tamam: ${restored} takipte, ${finished} kapatıldı.`);
  return { restored, finished };
}

/** Bot kapalıyken basılan reaksiyonları DB ile uzlaştır (limit + rol kontrollü). */
async function reconcileReactions(client, g, msg) {
  try {
    if (!g || g.status !== 'active') return;
    let reaction = msg.reactions?.cache?.get(GIVEAWAY_EMOJI) || null;
    if (!reaction) {
      try {
        await msg.react(GIVEAWAY_EMOJI).catch(() => {});
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      if (reaction.partial) await reaction.fetch();
    } catch {
      return;
    }
    const users = await reaction.users.fetch().catch(() => null);
    if (!users) return;
    const guild = msg.guild;
    const max = Number(g.max_participants) || 0;
    for (const [, user] of users) {
      try {
        if (!user || user.bot) continue;
        if (countGiveawayParticipants(g.id) >= max && max > 0) break;
        const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
        if (!member) continue;
        if (g.required_role_id) {
          const role = guild ? await guild.roles.fetch(g.required_role_id).catch(() => null) : null;
          if (role && !member.roles?.cache?.has(g.required_role_id)) continue;
        }
        addGiveawayParticipant(g.id, user.id);
      } catch {
        /* tek kullanıcı hatası diğerlerini engellemez */
      }
    }
    schedulePanelRefresh(client, g.id);
  } catch (err) {
    logger.warn(`[Çekiliş] reconcile hatası #${g?.id}: ${err.code || err.message}`);
  }
}

module.exports = {
  REROLL_PREFIX,
  drawWinners,
  createGiveawayFlow,
  scheduleGiveaway,
  schedulePanelRefresh,
  refreshPanel,
  handleReactionAdd,
  handleReactionRemove,
  validateParticipants,
  finalizeGiveaway,
  handleReroll,
  restoreGiveaways,
  reconcileReactions,
};
