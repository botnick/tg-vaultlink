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
  broadcast_unsubscribed INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  credits_initialized INTEGER NOT NULL DEFAULT 0,
  -- Wave 9.2 — Stars refund defense. spend_locked_until is an ISO timestamp;
  -- when in the future, every credit spend short-circuits with SPEND_LOCKED.
  -- refund_count + total_refunded_stars feed the repeat-offender threshold.
  spend_locked_until TEXT,
  refund_count INTEGER NOT NULL DEFAULT 0,
  total_refunded_stars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_telegram_user_id ON users(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_users_spend_locked
  ON users(spend_locked_until)
  WHERE spend_locked_until IS NOT NULL;

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

-- Polymorphic: target_type ∈ {'file','collection'} with target_id pointing
-- into the matching table. No FK on target_id — the discriminator picks
-- which table to join at query time.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reporter_user_id INTEGER,
  reason TEXT NOT NULL,
  -- Enum discriminator: spam | illegal | copyright | malware | scam | other.
  -- Validated at the application layer (see `REPORT_REASON_CATEGORIES` in
  -- src/config/constants.ts) so the set can grow without a table rebuild.
  reason_category TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_target_status
  ON reports(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter
  ON reports(reporter_user_id, created_at DESC);

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

-- Wave 9: dynamic credit system.
-- Per-user balance lives on `users.credits`; the immutable ledger below is
-- the source of truth (history view, refund correctness, audit). Every
-- balance write goes through CreditRepository.applyDelta() which writes
-- one row here and bumps users.credits in the same transaction.
CREATE TABLE IF NOT EXISTS credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,             -- signed: +grant/refund, -spend
  reason TEXT NOT NULL,               -- enum, see CreditService
  balance_after INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_reason ON credit_transactions(reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user_reason
  ON credit_transactions(user_id, reason, created_at DESC);
-- Wave 9.2 — hard idempotency for Stars top-ups. A given
-- telegram_payment_charge_id can never produce two 'topup' rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_topup_charge
  ON credit_transactions(reference_id)
  WHERE reason = 'topup' AND reference_id IS NOT NULL;

-- Wave 9.1: self-custodial crypto top-up.
-- One row per top-up attempt. The (chain, tx_hash) UNIQUE constraint is
-- the load-bearing dedup that prevents double-crediting the same payment.
-- Settings configure receiving address, confirmation threshold, and
-- enable/disable per chain at runtime.
CREATE TABLE IF NOT EXISTS crypto_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chain TEXT NOT NULL,                 -- 'tron-usdt' | 'ton-native' | 'ton-usdt-jetton'
  status TEXT NOT NULL DEFAULT 'pending',
  amount_unit TEXT NOT NULL,
  amount_decimals INTEGER NOT NULL,
  amount_label TEXT NOT NULL,
  credits_to_grant INTEGER NOT NULL,
  pay_to_address TEXT NOT NULL,
  memo TEXT,
  -- Wave 9.2 — frozen wallet-deeplink/QR-payable URI (BIP-21, ton://, etc.).
  -- NULL for chains without a standard scheme; Mini App falls back to
  -- bare-address QR + amount as text in that case.
  payment_uri TEXT,
  tx_hash TEXT,
  from_address TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL,
  paid_at TEXT,
  applied_at TEXT,
  ledger_tx_id INTEGER,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (ledger_tx_id) REFERENCES credit_transactions(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_invoices_chain_tx
  ON crypto_invoices(chain, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_user ON crypto_invoices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_status ON crypto_invoices(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_memo ON crypto_invoices(memo) WHERE memo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_pending_poll
  ON crypto_invoices(status, last_polled_at)
  WHERE status IN ('pending', 'submitted', 'confirming');

-- Wave 9.3 — full-auto top-up. Memo-less chains (TRC-20 USDT/USDC, BEP-20,
-- ERC-20) attribute payments via a unique decimal-suffix amount per active
-- invoice (e.g. 10.000072 USDT). The service pre-checks for collision via
-- findActiveByChainAndAmount + retries with a fresh suffix; this partial
-- UNIQUE index is the load-bearing safety net under concurrent createInvoice
-- so two pending invoices on the same chain can never share an amount.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_invoices_active_amount
  ON crypto_invoices(chain, amount_unit)
  WHERE status IN ('pending', 'submitted', 'confirming');
