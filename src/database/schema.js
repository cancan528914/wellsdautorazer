/**
 * SQLite şeması.
 * - Discord ID'leri TEXT (string) saklanır (JS number taşması olmaması için).
 * - systems: takip edilen her /ingame ve /aktiflik mesajı (message_id bazlı).
 * - participants: o mesaja bağlı kullanıcı durumları.
 *   - /ingame için status: 'joined' | 'left' (kullanıcı başına tek satır, UNIQUE garantisi)
 *   - /aktiflik için status her zaman 'joined'
 * - tickets: açılan her ticket (channel_id üzerinden takip, restart-safe).
 * - settings: key-value kalıcı ayarlar (örn. ticket panel görseli).
 * - ticket_panels: her sunucudaki aktif ticket panel mesajı (/ticketpng güncelleyebilsin diye).
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS systems (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('ingame', 'aktiflik')),
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_systems_guild ON systems (guild_id);
CREATE INDEX IF NOT EXISTS idx_systems_type  ON systems (type);

CREATE TABLE IF NOT EXISTS participants (
  message_id TEXT NOT NULL REFERENCES systems (message_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('joined', 'left')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_message ON participants (message_id);
CREATE INDEX IF NOT EXISTS idx_participants_status ON participants (message_id, status);

CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  channel_id    TEXT NOT NULL UNIQUE,
  panel_message_id TEXT,
  log_message_id TEXT,
  category_key  TEXT NOT NULL,
  category_label TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  claimed_by    TEXT,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  closed_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets (guild_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (channel_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_panels (
  guild_id   TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mazeret_panels (
  guild_id   TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  roles      TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS quit_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  user_tag         TEXT,
  channel_id       TEXT NOT NULL,
  panel_message_id TEXT UNIQUE,
  roles            TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quit_panel ON quit_logs (panel_message_id);
CREATE INDEX IF NOT EXISTS idx_quit_guild ON quit_logs (guild_id, created_at);

CREATE TABLE IF NOT EXISTS ic_approvals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  request_message_id TEXT NOT NULL UNIQUE,
  panel_message_id   TEXT UNIQUE,
  requested_text     TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by         TEXT,
  created_at         INTEGER NOT NULL,
  decided_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ic_user ON ic_approvals (guild_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_ic_panel ON ic_approvals (panel_message_id);

CREATE TABLE IF NOT EXISTS guard_whitelist (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  level      INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
  added_by   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_guard_wl_guild ON guard_whitelist (guild_id);

CREATE TABLE IF NOT EXISTS guard_settings (
  guild_id       TEXT PRIMARY KEY,
  log_channel_id TEXT,
  enabled        INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
`;

module.exports = { SCHEMA };
