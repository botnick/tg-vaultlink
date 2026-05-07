-- VaultLink Bot — polymorphic reports.
--
-- Reports can target either a single file (`files.id`) or a collection
-- (`collections.id`). Before this migration the `reports` table only carried
-- a `file_id` column with a FK to `files`, so `/report <code>` for any
-- collection-shaped share code silently fell through to "not found" — the
-- router queries the files table only.
--
-- The new shape mirrors the polymorphic pattern already used by
-- `credit_transactions` (`reference_type` + `reference_id`): a small enum
-- discriminator plus a loose row-id, no FK on the target side. Auto-lock
-- counts and bot-scoped listings join through the target table at query time.
--
-- SQLite cannot DROP a column that is referenced by an FK, and the legacy
-- table holds `FOREIGN KEY (file_id) REFERENCES files(id)`. We therefore
-- rebuild the table inside the migration runner's enclosing transaction:
-- create the new shape, copy rows over (any orphan with `file_id IS NULL`
-- is dropped — it had no resolvable target anyway), drop the old table,
-- rename, recreate indexes.

CREATE TABLE reports_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'file' | 'collection'. Stored as TEXT for forward-compat with future
  -- target kinds (broadcast posts, profile pages, …) without a schema bump.
  target_type TEXT NOT NULL,
  -- Loose foreign key into files(id) or collections(id) depending on
  -- target_type. No FK constraint here — the discriminator decides which
  -- table to join.
  target_id INTEGER NOT NULL,
  reporter_user_id INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id)
);

-- Backfill from the legacy `file_id` column. NULL-target rows are abandoned
-- on purpose: they cannot be acted on anyway and would violate the new
-- NOT NULL constraint.
INSERT INTO reports_new (
  id, target_type, target_id, reporter_user_id, reason, status, created_at, updated_at
)
SELECT id, 'file', file_id, reporter_user_id, reason, status, created_at, updated_at
FROM reports
WHERE file_id IS NOT NULL;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
-- Composite covers both the per-target auto-lock count
-- (`WHERE target_type=? AND target_id=? AND status='pending'`) and the
-- per-bot moderator listing's target-side join.
CREATE INDEX IF NOT EXISTS idx_reports_target_status
  ON reports(target_type, target_id, status);
