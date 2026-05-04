-- VaultLink Bot — Wave 8: broadcasts.
--
-- A broadcast is a one-shot announcement that fans out a single message to
-- every user matching an audience filter. Persisted (not fire-and-forget) so
-- the worker can resume after a crash, denormalized counts so the Mini App
-- can render live progress without a per-row aggregate.
--
-- Lifecycle: draft → (scheduled →) sending → completed | cancelled | failed.
-- Recipients: one row per user, claimed in batches with a SELECT-id +
-- UPDATE-WHERE-status pattern (SQLite has no UPDATE … LIMIT in stock builds).
--
-- Cross-bot file_id is a footgun — Telegram file_ids are bot-scoped — so
-- v0.3.0 does not surface media uploads to the composer. The columns are
-- here so the worker can use copyMessage in v0.3.1 without another
-- migration.

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  -- 'draft' | 'scheduled' | 'sending' | 'completed' | 'cancelled' | 'failed'

  -- Content. parse_mode is nullable (NULL = plain text). buttons_json stores a
  -- 2-D array of {text, url} rows: [[ {text,url}, ... ], [ ... ]]; null/empty
  -- means no inline keyboard.
  text TEXT NOT NULL,
  parse_mode TEXT,
  media_type TEXT,
  media_file_id TEXT,
  buttons_json TEXT,
  disable_web_page_preview INTEGER NOT NULL DEFAULT 0,
  protect_content INTEGER NOT NULL DEFAULT 0,
  silent INTEGER NOT NULL DEFAULT 0,

  -- Audience (denormalized JSON so the filter is replayable + auditable).
  audience_json TEXT NOT NULL,
  audience_count INTEGER NOT NULL DEFAULT 0,

  -- Scheduling.
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,

  -- Progress (kept in sync by the worker so the UI doesn't aggregate per tick).
  count_sent INTEGER NOT NULL DEFAULT 0,
  count_failed INTEGER NOT NULL DEFAULT 0,
  count_blocked INTEGER NOT NULL DEFAULT 0,
  count_pending INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (bot_id) REFERENCES managed_bots(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_broadcasts_bot ON broadcasts(bot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_broadcasts_creator ON broadcasts(created_by, created_at);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  telegram_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'sending' | 'sent' | 'failed' | 'blocked' | 'cancelled'

  message_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  sent_at TEXT,
  failed_at TEXT,

  UNIQUE (broadcast_id, user_id),
  FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status
  ON broadcast_recipients(broadcast_id, status);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending
  ON broadcast_recipients(broadcast_id, status, next_attempt_at)
  WHERE status = 'pending';

-- Per-user opt-out. Global (one flag covers every bot) for v0.3.0; will
-- evolve to a per-bot join table in v0.4 if operators request it.
ALTER TABLE users ADD COLUMN broadcast_unsubscribed INTEGER NOT NULL DEFAULT 0;
