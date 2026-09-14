/**
 * SQLite persistence katmanı (Node.js built-in `node:sqlite`, senkron + WAL).
 * Restart sonrası tüm /ingame ve /aktiflik mesajları buradan geri yüklenir.
 *
 * Neden built-in? better-sqlite3 native derleme gerektirir (Visual Studio / build tools),
 * node:sqlite ise Node 22.5+ ile gömülü gelir: kurulum sorunsuz, dosya formatı standart SQLite.
 */
const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('[ERROR] Bu bot için Node.js 22.5+ gerekli (built-in node:sqlite). Lütfen Node sürümünüzü yükseltin.');
  process.exit(1);
}

const config = require('../config');
const logger = require('../utils/logger');
const { SCHEMA } = require('./schema');

let db = null;

function getDbPath() {
  const p = path.resolve(process.cwd(), config.dbPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

function initDatabase() {
  if (db) return db;
  try {
    const dbPath = getDbPath();
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    migrate(db);
    logger.db(`Veritabanı hazır: ${dbPath}`);
    return db;
  } catch (err) {
    logger.error('Veritabanı başlatılamadı.', err);
    throw err;
  }
}

/**
 * Mevcut DB'leri yeni şemaya taşır (CREATE TABLE IF NOT EXISTS eski
 * tablolara sütun eklemez — o yüzden ALTER'lar burada, hatalar yutulur).
 */
function migrate(database) {
  const stmts = [
    'ALTER TABLE tickets ADD COLUMN log_message_id TEXT',
    'ALTER TABLE tickets ADD COLUMN panel_message_id TEXT',
    'ALTER TABLE tickets ADD COLUMN claimed_at INTEGER',
  ];
  for (const sql of stmts) {
    try {
      database.exec(sql);
      logger.db(`Migrasyon uygulandı: ${sql}`);
    } catch {
      /* sütun zaten varsa hata verir — normal, geç */
    }
  }
}

function getDb() {
  if (!db) return initDatabase();
  return db;
}

// ---------- System kayıtları ----------

function upsertSystem({ messageId, channelId, guildId, type, createdBy }) {
  try {
    getDb()
      .prepare(
        `INSERT INTO systems (message_id, channel_id, guild_id, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET channel_id = excluded.channel_id, guild_id = excluded.guild_id, type = excluded.type`,
      )
      .run(String(messageId), String(channelId), String(guildId), type, createdBy ? String(createdBy) : null, Date.now());
  } catch (err) {
    logger.error(`[DB] upsertSystem failed: ${messageId}`, err);
    throw err;
  }
}

function getSystem(messageId) {
  try {
    return getDb().prepare('SELECT * FROM systems WHERE message_id = ?').get(String(messageId)) || null;
  } catch (err) {
    logger.error(`[DB] getSystem failed: ${messageId}`, err);
    return null;
  }
}

function getAllSystems() {
  try {
    return getDb().prepare('SELECT * FROM systems ORDER BY created_at ASC').all();
  } catch (err) {
    logger.error('[DB] getAllSystems failed.', err);
    return [];
  }
}

function deleteSystem(messageId) {
  try {
    getDb().prepare('DELETE FROM systems WHERE message_id = ?').run(String(messageId));
  } catch (err) {
    logger.error(`[DB] deleteSystem failed: ${messageId}`, err);
  }
}

// ---------- /ingame katılımcı mantığı ----------

/**
 * Kullanıcıyı ingame listesinde işaretle. Aynı kullanıcı iki listede ASLA bulunmaz:
 * tek satır status ile tutulur (joined/left), bu yüzden mutual-exclusion DB seviyesinde garantilidir.
 */
function setIngameStatus(messageId, userId, status) {
  try {
    getDb()
      .prepare(
        `INSERT INTO participants (message_id, user_id, status, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(String(messageId), String(userId), status, Date.now());
  } catch (err) {
    logger.error(`[DB] setIngameStatus failed: ${messageId}/${userId}`, err);
    throw err;
  }
}

function getIngameLists(messageId) {
  try {
    const rows = getDb().prepare('SELECT user_id, status FROM participants WHERE message_id = ?').all(String(messageId));
    const joined = [];
    const left = [];
    for (const r of rows) {
      if (r.status === 'joined') joined.push(String(r.user_id));
      else if (r.status === 'left') left.push(String(r.user_id));
    }
    return { joined, left };
  } catch (err) {
    logger.error(`[DB] getIngameLists failed: ${messageId}`, err);
    return { joined: [], left: [] };
  }
}

function getIngameStatus(messageId, userId) {
  try {
    const row = getDb()
      .prepare('SELECT status FROM participants WHERE message_id = ? AND user_id = ?')
      .get(String(messageId), String(userId));
    return row ? row.status : null;
  } catch (err) {
    logger.error(`[DB] getIngameStatus failed: ${messageId}/${userId}`, err);
    return null;
  }
}

// ---------- /aktiflik katılımcı mantığı ----------

function addAktiflikParticipant(messageId, userId) {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO participants (message_id, user_id, status, updated_at)
         VALUES (?, ?, 'joined', ?)
         ON CONFLICT(message_id, user_id) DO NOTHING`,
      )
      .run(String(messageId), String(userId), Date.now());
    return Number(res.changes) > 0; // true = yeni eklendi, false = zaten vardı (duplicate yok)
  } catch (err) {
    logger.error(`[DB] addAktiflikParticipant failed: ${messageId}/${userId}`, err);
    throw err;
  }
}

function getAktiflikList(messageId) {
  try {
    const rows = getDb()
      .prepare("SELECT user_id FROM participants WHERE message_id = ? AND status = 'joined' ORDER BY updated_at ASC")
      .all(String(messageId));
    return rows.map((r) => String(r.user_id));
  } catch (err) {
    logger.error(`[DB] getAktiflikList failed: ${messageId}`, err);
    return [];
  }
}

module.exports = {
  initDatabase,
  migrate,
  getDb,
  upsertSystem,
  getSystem,
  getAllSystems,
  deleteSystem,
  setIngameStatus,
  getIngameLists,
  getIngameStatus,
  addAktiflikParticipant,
  getAktiflikList,
  // --- Ticket sistemi ---
  createTicket,
  getTicket,
  getTicketByChannel,
  getOpenTicket,
  countOpenTickets,
  setTicketChannel,
  setTicketPanelMessage,
  claimTicket,
  closeTicket,
  deleteTicket,
  incrementClaimStat,
  getTopClaimers,
  getAllTickets,
  getSetting,
  setSetting,
  deleteSetting,
  upsertTicketPanel,
  getTicketPanel,
  upsertMazeretPanel,
  getMazeretPanel,
  // --- IC onay ---
  createIcRequest,
  getIcByPanel,
  getPendingIc,
  decideIc,
  setIcPanel,
  setTicketLogMessage,
  // --- Quit takibi ---
  trackMemberRoles,
  getMemberRoles,
  createQuitLog,
  getQuitByPanel,
  setQuitPanel,
  pruneQuitLogs,
  // --- Guard ---
  getGuardLevel,
  setGuardLevel,
  removeGuard,
  listWhitelist,
  getGuardSettings,
  saveGuardSettings,
  countGuardGuilds,
};

// ---------- Ticket kayıtları ----------

function createTicket({ guildId, userId, channelId, panelMessageId, categoryKey, categoryLabel }) {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO tickets (guild_id, user_id, channel_id, panel_message_id, category_key, category_label, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        String(guildId),
        String(userId),
        String(channelId),
        panelMessageId ? String(panelMessageId) : null,
        String(categoryKey),
        String(categoryLabel),
        Date.now(),
      );
    return Number(res.lastInsertRowid);
  } catch (err) {
    logger.error(`[DB] createTicket failed: ${guildId}/${userId}`, err);
    throw err;
  }
}

function getTicket(id) {
  try {
    return getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id)) || null;
  } catch (err) {
    logger.error(`[DB] getTicket failed: ${id}`, err);
    return null;
  }
}

function getTicketByChannel(channelId) {
  try {
    return getDb().prepare('SELECT * FROM tickets WHERE channel_id = ?').get(String(channelId)) || null;
  } catch (err) {
    logger.error(`[DB] getTicketByChannel failed: ${channelId}`, err);
    return null;
  }
}

/** Kullanıcının açık ticket'ı (duplicate engelleme için). */
function getOpenTicket(guildId, userId) {
  try {
    return (
      getDb()
        .prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
        .get(String(guildId), String(userId)) || null
    );
  } catch (err) {
    logger.error(`[DB] getOpenTicket failed: ${guildId}/${userId}`, err);
    return null;
  }
}

function countOpenTickets(guildId, userId) {
  try {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'")
      .get(String(guildId), String(userId));
    return Number(row?.c || 0);
  } catch (err) {
    logger.error(`[DB] countOpenTickets failed: ${guildId}/${userId}`, err);
    return 0;
  }
}

function setTicketChannel(id, channelId) {
  try {
    getDb().prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(String(channelId), Number(id));
  } catch (err) {
    logger.error(`[DB] setTicketChannel failed: ${id}`, err);
    throw err;
  }
}

function setTicketPanelMessage(id, panelMessageId) {
  try {
    getDb().prepare('UPDATE tickets SET panel_message_id = ? WHERE id = ?').run(String(panelMessageId), Number(id));
  } catch (err) {
    logger.error(`[DB] setTicketPanelMessage failed: ${id}`, err);
  }
}

function claimTicket(id, staffId) {
  try {
    getDb().prepare('UPDATE tickets SET claimed_by = ?, claimed_at = ? WHERE id = ?').run(String(staffId), Date.now(), Number(id));
  } catch (err) {
    logger.error(`[DB] claimTicket failed: ${id}`, err);
    throw err;
  }
}

function closeTicket(id, closedBy) {
  try {
    getDb()
      .prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?")
      .run(Date.now(), closedBy ? String(closedBy) : null, Number(id));
  } catch (err) {
    logger.error(`[DB] closeTicket failed: ${id}`, err);
    throw err;
  }
}

function deleteTicket(id) {
  try {
    getDb().prepare('DELETE FROM tickets WHERE id = ?').run(Number(id));
  } catch (err) {
    logger.error(`[DB] deleteTicket failed: ${id}`, err);
  }
}

// ---------- Ticket sahiplenme istatistikleri (sunucu bazlı, kalıcı) ----------

/**
 * Gerçek bir sahiplenmede +1. Sadece claim anında çağrılır (kapanışta ASLA).
 * Negatif olamaz (CHECK + clamp).
 */
function incrementClaimStat(guildId, userId) {
  try {
    getDb()
      .prepare(
        'INSERT INTO ticket_stats (guild_id, user_id, claimed_count, updated_at) VALUES (?, ?, 1, ?) ' +
          'ON CONFLICT(guild_id, user_id) DO UPDATE SET claimed_count = max(0, claimed_count) + 1, updated_at = excluded.updated_at',
      )
      .run(String(guildId), String(userId), Date.now());
  } catch (err) {
    logger.error(`[DB] incrementClaimStat failed: ${guildId}/${userId}`, err);
    throw err;
  }
}

/** En çok sahiplenenler: sayı azalan, eşitlikte userId artan (deterministik). */
function getTopClaimers(guildId, limit = 10) {
  try {
    const n = Math.max(1, Math.min(100, Number(limit) || 10));
    return getDb()
      .prepare('SELECT user_id, claimed_count FROM ticket_stats WHERE guild_id = ? ORDER BY claimed_count DESC, user_id ASC LIMIT ?')
      .all(String(guildId), n)
      .map((r) => ({ user_id: String(r.user_id), claimed_count: Math.max(0, Number(r.claimed_count) || 0) }))
      .filter((r) => r.user_id);
  } catch (err) {
    logger.error(`[DB] getTopClaimers failed: ${guildId}`, err);
    return [];
  }
}

function getAllTickets() {
  try {
    return getDb().prepare('SELECT * FROM tickets ORDER BY id ASC').all();
  } catch (err) {
    logger.error('[DB] getAllTickets failed.', err);
    return [];
  }
}

// ---------- Kalıcı ayarlar (key-value) ----------

function getSetting(key) {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row ? String(row.value) : null;
  } catch (err) {
    logger.error(`[DB] getSetting failed: ${key}`, err);
    return null;
  }
}

function setSetting(key, value) {
  try {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(String(key), String(value), Date.now());
  } catch (err) {
    logger.error(`[DB] setSetting failed: ${key}`, err);
    throw err;
  }
}

function deleteSetting(key) {
  try {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(String(key));
  } catch (err) {
    logger.error(`[DB] deleteSetting failed: ${key}`, err);
  }
}

// ---------- Ticket panel mesajı (sunucu başına tek) ----------

function upsertTicketPanel(guildId, channelId, messageId) {
  try {
    getDb()
      .prepare(
        `INSERT INTO ticket_panels (guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at`,
      )
      .run(String(guildId), String(channelId), String(messageId), Date.now());
  } catch (err) {
    logger.error(`[DB] upsertTicketPanel failed: ${guildId}`, err);
    throw err;
  }
}

function getTicketPanel(guildId) {
  try {
    return getDb().prepare('SELECT * FROM ticket_panels WHERE guild_id = ?').get(String(guildId)) || null;
  } catch (err) {
    logger.error(`[DB] getTicketPanel failed: ${guildId}`, err);
    return null;
  }
}

// ---------- Mazeret panel mesajı (sunucu başına tek) ----------

function upsertMazeretPanel(guildId, channelId, messageId) {
  try {
    getDb()
      .prepare(
        `INSERT INTO mazeret_panels (guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at`,
      )
      .run(String(guildId), String(channelId), String(messageId), Date.now());
  } catch (err) {
    logger.error(`[DB] upsertMazeretPanel failed: ${guildId}`, err);
    throw err;
  }
}

function getMazeretPanel(guildId) {
  try {
    return getDb().prepare('SELECT * FROM mazeret_panels WHERE guild_id = ?').get(String(guildId)) || null;
  } catch (err) {
    logger.error(`[DB] getMazeretPanel failed: ${guildId}`, err);
    return null;
  }
}

// ---------- Quit takibi: rol snapshot + ayrılma kayıtları ----------

/** Üyenin rollerini anlık görüntüsüyle saklar (roles: [{id, name}]). */
function trackMemberRoles(guildId, userId, roles) {
  try {
    const clean = (roles || [])
      .filter((r) => r && r.id && String(r.id) !== String(guildId)) // @everyone hariç
      .map((r) => ({ id: String(r.id), name: String(r.name || 'Bilinmeyen rol').slice(0, 100) }))
      .slice(0, 50);
    getDb()
      .prepare(
        `INSERT INTO member_roles (guild_id, user_id, roles, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET roles = excluded.roles, updated_at = excluded.updated_at`,
      )
      .run(String(guildId), String(userId), JSON.stringify(clean), Date.now());
  } catch (err) {
    logger.error(`[DB] trackMemberRoles failed: ${guildId}/${userId}`, err);
  }
}

function getMemberRoles(guildId, userId) {
  try {
    const row = getDb().prepare('SELECT roles FROM member_roles WHERE guild_id = ? AND user_id = ?').get(String(guildId), String(userId));
    const arr = row ? JSON.parse(row.roles) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    logger.error(`[DB] getMemberRoles failed: ${guildId}/${userId}`, err);
    return [];
  }
}

function createQuitLog({ guildId, userId, userTag, channelId, roles }) {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO quit_logs (guild_id, user_id, user_tag, channel_id, roles, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(guildId),
        String(userId),
        userTag ? String(userTag).slice(0, 100) : null,
        String(channelId),
        JSON.stringify(roles || []),
        Date.now(),
      );
    return Number(res.lastInsertRowid);
  } catch (err) {
    logger.error(`[DB] createQuitLog failed: ${guildId}/${userId}`, err);
    throw err;
  }
}

function getQuitByPanel(panelMessageId) {
  try {
    return getDb().prepare('SELECT * FROM quit_logs WHERE panel_message_id = ?').get(String(panelMessageId)) || null;
  } catch (err) {
    logger.error(`[DB] getQuitByPanel failed: ${panelMessageId}`, err);
    return null;
  }
}

function setQuitPanel(id, panelMessageId) {
  try {
    getDb().prepare('UPDATE quit_logs SET panel_message_id = ? WHERE id = ?').run(String(panelMessageId), Number(id));
  } catch (err) {
    logger.error(`[DB] setQuitPanel failed: ${id}`, err);
  }
}

/** 90 günden eski quit kayıtlarını temizler. */
function pruneQuitLogs(guildId, maxAgeMs = 90 * 24 * 60 * 60 * 1000) {
  try {
    getDb().prepare('DELETE FROM quit_logs WHERE guild_id = ? AND created_at < ?').run(String(guildId), Date.now() - maxAgeMs);
  } catch (err) {
    logger.error(`[DB] pruneQuitLogs failed: ${guildId}`, err);
  }
}

// ---------- IC isim onay kayıtları ----------

function createIcRequest({ guildId, userId, channelId, requestMessageId, requestedText }) {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO ic_approvals (guild_id, user_id, channel_id, request_message_id, requested_text, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(String(guildId), String(userId), String(channelId), String(requestMessageId), String(requestedText || '').slice(0, 1000), Date.now());
    return Number(res.lastInsertRowid);
  } catch (err) {
    logger.error(`[DB] createIcRequest failed: ${guildId}/${userId}`, err);
    throw err;
  }
}

function getIcByPanel(panelMessageId) {
  try {
    return getDb().prepare('SELECT * FROM ic_approvals WHERE panel_message_id = ?').get(String(panelMessageId)) || null;
  } catch (err) {
    logger.error(`[DB] getIcByPanel failed: ${panelMessageId}`, err);
    return null;
  }
}

function getPendingIc(guildId, userId) {
  try {
    return (
      getDb()
        .prepare("SELECT * FROM ic_approvals WHERE guild_id = ? AND user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
        .get(String(guildId), String(userId)) || null
    );
  } catch (err) {
    logger.error(`[DB] getPendingIc failed: ${guildId}/${userId}`, err);
    return null;
  }
}

function setIcPanel(id, panelMessageId) {
  try {
    getDb().prepare('UPDATE ic_approvals SET panel_message_id = ? WHERE id = ?').run(String(panelMessageId), Number(id));
  } catch (err) {
    logger.error(`[DB] setIcPanel failed: ${id}`, err);
  }
}

function decideIc(panelMessageId, status, decidedBy) {
  try {
    getDb()
      .prepare("UPDATE ic_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE panel_message_id = ? AND status = 'pending'")
      .run(status, decidedBy ? String(decidedBy) : null, Date.now(), String(panelMessageId));
  } catch (err) {
    logger.error(`[DB] decideIc failed: ${panelMessageId}`, err);
    throw err;
  }
}

// ---------- Ticket log mesajı (tek-mesaj logu için) ----------

function setTicketLogMessage(id, logMessageId) {
  try {
    getDb().prepare('UPDATE tickets SET log_message_id = ? WHERE id = ?').run(String(logMessageId), Number(id));
  } catch (err) {
    logger.error(`[DB] setTicketLogMessage failed: ${id}`, err);
  }
}

// ---------- Guard whitelist + ayarlar ----------

function getGuardLevel(guildId, userId) {
  try {
    const row = getDb().prepare('SELECT level FROM guard_whitelist WHERE guild_id = ? AND user_id = ?').get(String(guildId), String(userId));
    const lvl = Number(row?.level || 0);
    return lvl >= 1 && lvl <= 4 ? lvl : 0;
  } catch (err) {
    logger.error(`[DB] getGuardLevel failed: ${guildId}/${userId}`, err);
    return 0;
  }
}

function setGuardLevel(guildId, userId, level, addedBy) {
  try {
    const now = Date.now();
    const exists = getDb().prepare('SELECT 1 FROM guard_whitelist WHERE guild_id = ? AND user_id = ?').get(String(guildId), String(userId));
    getDb()
      .prepare(
        'INSERT INTO guard_whitelist (guild_id, user_id, level, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(guild_id, user_id) DO UPDATE SET level = excluded.level, added_by = excluded.added_by, updated_at = excluded.updated_at',
      )
      .run(String(guildId), String(userId), Number(level), addedBy ? String(addedBy) : null, now, now);
    return { created: !exists };
  } catch (err) {
    logger.error(`[DB] setGuardLevel failed: ${guildId}/${userId}`, err);
    throw err;
  }
}

function removeGuard(guildId, userId) {
  try {
    const res = getDb().prepare('DELETE FROM guard_whitelist WHERE guild_id = ? AND user_id = ?').run(String(guildId), String(userId));
    return Number(res.changes) > 0;
  } catch (err) {
    logger.error(`[DB] removeGuard failed: ${guildId}/${userId}`, err);
    return false;
  }
}

function listWhitelist(guildId) {
  try {
    return getDb().prepare('SELECT * FROM guard_whitelist WHERE guild_id = ? ORDER BY level DESC, created_at ASC').all(String(guildId));
  } catch (err) {
    logger.error(`[DB] listWhitelist failed: ${guildId}`, err);
    return [];
  }
}

function getGuardSettings(guildId) {
  try {
    const row = getDb().prepare('SELECT * FROM guard_settings WHERE guild_id = ?').get(String(guildId));
    return row ? { guild_id: String(row.guild_id), log_channel_id: row.log_channel_id ? String(row.log_channel_id) : null, enabled: Number(row.enabled) === 1 } : null;
  } catch (err) {
    logger.error(`[DB] getGuardSettings failed: ${guildId}`, err);
    return null;
  }
}

function saveGuardSettings(guildId, opts) {
  try {
    const o = opts || {};
    getDb()
      .prepare(
        'INSERT INTO guard_settings (guild_id, log_channel_id, enabled, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id, enabled = excluded.enabled, updated_at = excluded.updated_at',
      )
      .run(String(guildId), o.logChannelId ? String(o.logChannelId) : null, o.enabled ? 1 : 0, Date.now());
  } catch (err) {
    logger.error(`[DB] saveGuardSettings failed: ${guildId}`, err);
    throw err;
  }
}

function countGuardGuilds() {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM guard_settings WHERE enabled = 1').get();
    return Number(row?.c || 0);
  } catch (err) {
    logger.error('[DB] countGuardGuilds failed.', err);
    return 0;
  }
}
