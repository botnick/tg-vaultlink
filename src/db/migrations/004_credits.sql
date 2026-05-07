-- VaultLink Bot — Wave 9: dynamic credit system.
--
-- Two pieces:
--   1. Per-user balance + idempotency flag, added to the `users` table.
--   2. An immutable `credit_transactions` ledger so refunds, audits, and the
--      Mini App "history" view all read from one source of truth. The
--      `users.credits` column is the cached balance — every write goes
--      through the ledger and bumps that column atomically inside a single
--      transaction.
--
-- The whole system is gated by the dynamic `credits.enabled` setting; this
-- migration only provisions the storage and is safe to apply even when the
-- feature is left disabled. Toggles, costs, signup bonus amounts, and topup
-- packages live in the `settings` table — see CreditService for the keys.

-- The migration runner records `004` in `schema_migrations` so this file
-- runs exactly once per database. SQLite's ALTER TABLE has no IF NOT EXISTS
-- guard, but the runner skips already-applied versions before exec'ing the
-- SQL, so a plain ADD COLUMN is safe.
ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;

-- Set to 1 the first time the signup bonus is granted. Kept separate from
-- the balance so a user who spends down to zero does not retrigger the
-- bonus on the next interaction.
ALTER TABLE users ADD COLUMN credits_initialized INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,

  -- Signed delta applied to users.credits in the same transaction:
  --   positive  → grant / refund / topup / referral
  --   negative  → spend
  delta INTEGER NOT NULL,

  -- Stable enum (string for forward-compat). Recognised values:
  --   'signup_bonus' | 'referral_reward' | 'spend_decode'
  --   'spend_collection_open' | 'spend_collection_send'
  --   'refund' | 'topup' | 'admin_adjust' | 'admin_set'
  reason TEXT NOT NULL,

  -- Snapshot of users.credits AFTER this row was applied. Lets the Mini App
  -- render history without re-summing from scratch and gives admins an easy
  -- consistency check ("did the balance match the ledger at this point?").
  balance_after INTEGER NOT NULL,

  -- Loose foreign key — references files.id, collections.id, users.id, or
  -- a topup invoice payload. Stored as TEXT to keep the column polymorphic
  -- without join-table gymnastics.
  reference_type TEXT,
  reference_id TEXT,

  -- Free-form structured payload (e.g. {stars, paymentChargeId, note}).
  metadata_json TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_reason ON credit_transactions(reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user_reason
  ON credit_transactions(user_id, reason, created_at DESC);
