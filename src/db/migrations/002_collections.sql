-- VaultLink Bot — Wave 7: collections (multi-file share codes).
--
-- A collection is a named bundle of media items that resolves through the
-- same share-code surface as a single file. The owning user assembles items
-- in a `collection_drafts` row, then "finishes" the draft to mint the live
-- collection (allocated code, immutable item list snapshot). Drafts are
-- transient and pruned by the `collection_drafts.expires_at` TTL.

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
