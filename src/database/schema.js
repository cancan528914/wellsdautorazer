/**
 * SQLite şeması.
 * - Discord ID'leri TEXT (string) saklanır (JS number taşması olmaması için).
 * - systems: takip edilen her /ingame ve /aktiflik mesajı (message_id bazlı).
 *   - /ingame için status: 'joined' | 'left' (kullanıcı başına tek satır, UNIQUE garantisi)
 *   - /aktiflik için status her zaman 'joined'
 * - tickets: açılan her ticket (channel_id üzerinden takip, restart-safe).
 * - settings: key-value kalıcı ayarlar (örn. ticket panel görseli).
 * - ticket_panels: her sunucudaki aktif ticket panel mesajı (/ticketpng güncelleyebilsin diye).
 * - transcripts: ticket kapanışında oluşturulan transcript kayıtları.
 * - transcript_messages: transcript'e ait mesaj snapshot'ları.
 * - transcript_users: transcript'e ait kullanıcı snapshot'ları.
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
  claimed_at    INTEGER,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  closed_by     TEXT,
  decision      TEXT CHECK (decision IN ('accepted', 'rejected')),
  decided_by    TEXT,
  decided_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets (guild_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (channel_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);

CREATE TABLE IF NOT EXISTS ticket_stats (
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  claimed_count INTEGER NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_stats_guild ON ticket_stats (guild_id, claimed_count DESC);

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

-- ===================== TRANSCRIPT SYSTEM =====================

CREATE TABLE IF NOT EXISTS transcripts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id   TEXT NOT NULL UNIQUE,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  ticket_owner_id TEXT NOT NULL,
  claimed_by_id   TEXT,
  closed_by_id    TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  message_count   INTEGER NOT NULL DEFAULT 0,
  user_count      INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  image_count     INTEGER NOT NULL DEFAULT 0,
  video_count     INTEGER NOT NULL DEFAULT 0,
  file_count      INTEGER NOT NULL DEFAULT 0,
  token           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  expires_at      INTEGER,
  web_url         TEXT
);

CREATE INDEX IF NOT EXISTS idx_transcripts_guild ON transcripts (guild_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_ticket ON transcripts (ticket_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_token ON transcripts (token);
CREATE INDEX IF NOT EXISTS idx_transcripts_transcript_id ON transcripts (transcript_id);

CREATE TABLE IF NOT EXISTS transcript_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id   TEXT NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT,
  discriminator   TEXT,
  avatar_url      TEXT,
  bot             INTEGER NOT NULL DEFAULT 0,
  content         TEXT,
  cleaned_content TEXT,
  edited_at       INTEGER,
  created_at      INTEGER NOT NULL,
  type            INTEGER NOT NULL DEFAULT 0,
  reply_to_id     TEXT,
  reply_preview   TEXT,
  attachments     TEXT NOT NULL DEFAULT '[]',
  embeds          TEXT NOT NULL DEFAULT '[]',
  reactions       TEXT NOT NULL DEFAULT '[]',
  sticker_items   TEXT NOT NULL DEFAULT '[]',
  role_color      INTEGER,
  role_name       TEXT
);

CREATE INDEX IF NOT EXISTS idx_transcript_msgs_transcript ON transcript_messages (transcript_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transcript_msgs_user ON transcript_messages (transcript_id, user_id);

CREATE TABLE IF NOT EXISTS transcript_users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id   TEXT NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT,
  discriminator   TEXT,
  avatar_url      TEXT,
  bot             INTEGER NOT NULL DEFAULT 0,
  roles           TEXT NOT NULL DEFAULT '[]',
  message_count   INTEGER NOT NULL DEFAULT 0,
  first_message_at INTEGER,
  last_message_at  INTEGER,
  UNIQUE(transcript_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_users_transcript ON transcript_users (transcript_id);

CREATE TABLE IF NOT EXISTS transcript_attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id   TEXT NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  attachment_id   TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT,
  size            INTEGER NOT NULL DEFAULT 0,
  url             TEXT NOT NULL,
  proxy_url       TEXT,
  width           INTEGER,
  height          INTEGER,
  duration_secs   REAL,
  archived        INTEGER NOT NULL DEFAULT 0,
  archived_path   TEXT,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_transcript_attach_transcript ON transcript_attachments (transcript_id);
`;

module.exports = { SCHEMA };