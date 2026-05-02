-- VaultLink Bot — consolidated schema reference (same as the latest migration result).
--
-- This file is for human reference and tooling (schema diffs, ER-diagram
-- generators). The runtime never reads it directly: tables are created by
-- applying the numbered files under `src/db/migrations/` in order. Keep
-- this file in lockstep with whatever the final migration leaves on disk.
-- All TEXT timestamps are ISO-8601 UTC strings (e.g. 2026-05-02T14:25:11.123Z).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  locale TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_telegram_user_id ON users(telegram_user_id);

CREATE TABLE IF NOT EXISTS managed_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  telegram_bot_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  encrypted_token TEXT NOT NULL,
  token_nonce TEXT NOT NULL,
  token_auth_tag TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_managed_bots_username ON managed_bots(username);
CREATE INDEX IF NOT EXISTS idx_managed_bots_owner ON managed_bots(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_managed_bots_status ON managed_bots(status);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  bot_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  file_type TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  caption TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  password_hash TEXT,
  expires_at TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, code),
  FOREIGN KEY (bot_id) REFERENCES managed_bots(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_files_code ON files(code);
CREATE INDEX IF NOT EXISTS idx_files_bot_code ON files(bot_id, code);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_deleted_locked ON files(is_deleted, is_locked);

CREATE TABLE IF NOT EXISTS file_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  requester_user_id INTEGER,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (requester_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_file ON file_access_logs(file_id);

CREATE TABLE IF NOT EXISTS bot_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (bot_id, user_id, permission_type),
  FOREIGN KEY (bot_id) REFERENCES managed_bots(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_bot_permissions_bot_user ON bot_permissions(bot_id, user_id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER,
  reporter_user_id INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (reporter_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_file ON reports(file_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL,
  UNIQUE (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_scope_key ON rate_limits(scope, key);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- Wave 7: collections (multi-file share codes).
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  bot_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  password_hash TEXT,
  expires_at TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, code),
  FOREIGN KEY (bot_id) REFERENCES managed_bots(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_collections_bot_code ON collections(bot_id, code);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_collections_deleted_locked ON collections(is_deleted, is_locked);

CREATE TABLE IF NOT EXISTS collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  file_type TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  caption TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_sort ON collection_items(collection_id, sort_order);

CREATE TABLE IF NOT EXISTS collection_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  description TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, owner_user_id, status),
  FOREIGN KEY (bot_id) REFERENCES managed_bots(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_collection_drafts_owner_status ON collection_drafts(owner_user_id, status);

CREATE TABLE IF NOT EXISTS collection_draft_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  file_type TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  caption TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES collection_drafts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_collection_draft_items_draft ON collection_draft_items(draft_id);
