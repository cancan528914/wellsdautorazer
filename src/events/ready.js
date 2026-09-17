/**
 * ready event - bot açılışında çalışır.
 * DB'deki aktif sistem sayısını loglar (restart sonrası veri kaybı kontrolü).
 */
const { ActivityType, Routes } = require('discord.js');
const config = require('../config');
const { getAllSystems, getAllTickets, deleteTicket, countGuardGuilds } = require('../database/database');
const { getSavedVoiceChannel, joinVoice, leaveVoice } = require('../handlers/voiceHandler');
const logger = require('../utils/logger');

module.exports = {
  name: 'ready',
  once: true,

  async execute(client) {
    logger.success(`Bot çevrimiçi: ${client.user.tag}`);

    try {
      const systems = getAllSystems();
      const ingame = systems.filter((s) => s.type === 'ingame').length;
      const aktiflik = systems.filter((s) => s.type === 'aktiflik').length;
      logger.info(`Aktif paneller yüklendi: ${ingame} ingame, ${aktiflik} aktiflik (toplam ${systems.length})`);
    } catch (err) {
      logger.error('Aktif paneller yüklenirken hata.', err);
    }

    // Ticket uzlaşması: bot kapalıyken silinen kanalların DB kayıtlarını temizle.
    try {
      const tickets = getAllTickets();
      const open = tickets.filter((t) => t.status === 'open').length;
      let pruned = 0;
      for (const t of tickets) {
        try {
          const ch = await client.channels.fetch(t.channel_id).catch(() => null);
          if (!ch) {
            deleteTicket(t.id);
            pruned++;
          }
        } catch {
          /* tek ticket hatası diğerlerini engellemez */
        }
      }
      logger.info(`Ticketlar yüklendi: ${open} açık (toplam ${tickets.length})${pruned ? `, ${pruned} ölü kayıt temizlendi` : ''}`);
    } catch (err) {
      logger.error('Ticketlar yüklenirken hata.', err);
    }

    // Staff ticket rolü + görüntüleyici rol: açık ticketlara geriye dönük izin uygula (spec 7,8)
    try {
      const { syncStaffTicketPermissions, syncTicketViewerRole } = require('../handlers/ticketHandler');
      const staffRes = await syncStaffTicketPermissions(client);
      const viewRes = await syncTicketViewerRole(client);
      if (staffRes.checked || viewRes.synced || staffRes.failed || viewRes.failed) {
        logger.info(`Ticket permission repair tamam: staff ${staffRes.fixed}/${staffRes.checked} düzeltildi, viewer ${viewRes.synced} düzeltildi.`);
      }
    } catch (err) {
      logger.error('Ticket permission senkronunda hata.', err);
    }

    // Kategori seviye staff izni (spec 6) — sadece bir kez, kanal overwrite zaten yeterli ama kategori de düzelsin
    try {
      const catId = config.ticket.categoryId;
      const staffId = config.STAFF_TICKET_ROLE_ID || '1522773972393922730';
      if (catId && staffId) {
        for (const [, guild] of client.guilds.cache) {
          try {
            const cat = await guild.channels.fetch(catId).catch(() => null);
            if (!cat || cat.type !== 4) continue; // 4 = GuildCategory
            const existing = cat.permissionOverwrites.cache.get(staffId);
            const hasView = existing?.allow?.has?.(require('discord.js').PermissionFlagsBits.ViewChannel);
            if (!hasView) {
              await cat.permissionOverwrites.edit(staffId, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }, 'Ticket kategori staff erişimi (startup)').catch(() => {});
              logger.info(`Kategori ${cat.id} staff overwrite eklendi (guild ${guild.id})`);
            }
          } catch {}
        }
      }
    } catch (err) {
      logger.debug(`Kategori staff overwrite kontrolü atlandı: ${err.message}`);
    }

    try {
      logger.info(`Guard: ${countGuardGuilds()} sunucuda aktif`);
    } catch (err) {
      logger.error('Guard durumu okunamadı.', err);
    }

    // Kapı kanıtı: bu satır yoksa çalışan bot ESKİ koddur (restart gerekli)
    try {
      const n = (config.globalAllowedRoleIds || []).length;
      if (n) logger.success(`Komut erişim kapısı AKTİF: ${n} rol + adminler (diğerleri engellenir)`);
      else logger.warn('Komut erişim kapısı PASİF: BOT_ALLOWED_ROLE_IDS boş, herkes kullanabilir.');
    } catch (err) {
      logger.error('Erişim kapısı durumu okunamadı.', err);
    }

    // Ses kalıcılığı: restart öncesi bir kanalda idiysem geri katıl
    try {
      for (const [, guild] of client.guilds.cache) {
        const savedId = getSavedVoiceChannel(guild.id);
        if (!savedId) continue;
        try {
          // fetch: cache'i doldurur (joinVoice cache üzerinden doğrular)
          await guild.channels.fetch(savedId).catch(() => null);
          await joinVoice(guild, savedId);
          logger.info(`Sese geri dönüldü: <#${savedId}>`);
        } catch (err) {
          if (err?.code === 'NO_CHANNEL' || err?.code === 'ALREADY_THERE') {
            if (err?.code === 'NO_CHANNEL') {
              await leaveVoice(guild.id); // ölü kayıt temizliği
              logger.warn(`Kayıtlı ses kanalı artık yok, kayıt silindi (guild ${guild.id})`);
            }
          } else {
            logger.warn(`Sese geri dönülemedi: ${err.code || err.message} (sonraki /sesgir ile manuel katılın)`);
          }
        }
      }
    } catch (err) {
      logger.error('Ses geri katılımında hata.', err);
    }

    // REST heartbeat: DPI'lı ağlarda SOĞUK TLS handshake 10sn+ sürer, oysa Discord
    // etkileşim ACK'lerinin 3sn içinde ulaşması gerekir. 40sn'de bir yapılan bu
    // minik istek (kimlik gerektirmez) havuzdaki bağlantıyı sıcak tutar.
    // Trafik maliyeti: 1 küçük istek / 40sn. Kapatmak için HEARTBEAT_MS=0.
    const hbRaw = parseInt(process.env.HEARTBEAT_MS || '40000', 10);
    const HEARTBEAT_MS = Number.isFinite(hbRaw) && hbRaw >= 0 ? hbRaw : 40000;
    if (HEARTBEAT_MS > 0) {
      logger.info(`REST heartbeat aktif (${HEARTBEAT_MS}ms) — etkileşim cevapları için bağlantı sıcak tutulacak.`);
      let hbFirst = true;
      const timer = setInterval(async () => {
        try {
          const t0 = Date.now();
          await client.rest.get(Routes.gateway());
          const ms = Date.now() - t0;
          if (hbFirst) {
            hbFirst = false;
            logger.success(`Heartbeat OK (${ms}ms) — REST bağlantısı sıcak.`);
          } else if (ms > 3000) {
            logger.warn(`Heartbeat yavaş (${ms}ms) — ağ gecikmesi yüksek, ilk komutlar gecikebilir.`);
          }
        } catch (err) {
          logger.warn(`Heartbeat failed: ${err.code || err.message} (bağlantı soğumuş olabilir, bir sonraki turda yenilenecek)`);
        }
      }, HEARTBEAT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }

    // Profil durumu rotasyonu: 5sn'de bir değişen "İzliyor" metni (sonsuz döngü).
    // Liste buradan düzenlenir. (Discord ~5sn sıklığa izin verir, daha hızlı yapmayın.)
    const PRESENCE_ROTATION = ['Well SD 🤍 Javrex', 'Well SD 🤍 Martı', 'Well SD 🤍 Egax'];
    const PRESENCE_INTERVAL_MS = 5000;
    try {
      let presenceIdx = 0;
      const applyPresence = () => {
        try {
          client.user.setPresence({
            activities: [{ name: PRESENCE_ROTATION[presenceIdx % PRESENCE_ROTATION.length], type: ActivityType.Watching }],
            status: 'online',
          });
          presenceIdx++;
        } catch {
          /* presence kritik değil */
        }
      };
      applyPresence();
      const presenceTimer = setInterval(applyPresence, PRESENCE_INTERVAL_MS);
      if (typeof presenceTimer.unref === 'function') presenceTimer.unref();
      logger.info(`Profil rotasyonu aktif (${PRESENCE_ROTATION.length} metin, ${PRESENCE_INTERVAL_MS}ms)`);
    } catch {
      /* presence kritik değil */
    }
  },
};
