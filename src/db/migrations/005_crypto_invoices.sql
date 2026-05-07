-- VaultLink Bot — Wave 9.1: self-custodial crypto top-up.
--
-- Layered on top of the Wave 9 credit system. The bot never holds private
-- keys: each enabled chain has a watch-only receiving address configured
-- in the `settings` table, and every crediting decision is gated on an
-- on-chain verification + a UNIQUE(tx_hash) constraint so the same
-- transaction can never grant credits twice.
--
-- Flow:
--   1. User asks for a top-up of N credits via chain X.
--   2. Bot creates a `pending` invoice with a unique memo + expected amount.
--   3. User pays from their own wallet to the configured address.
--   4. User pastes the tx hash (primary path) OR the auto-poll worker
--      detects the transfer (secondary path).
--   5. Adapter verifies on-chain that:
--        - tx exists, status=success
--        - to == invoice.pay_to_address
--        - amount >= invoice.amount_unit (with optional tolerance)
--        - memo matches (when chain supports it)
--        - confirmations >= invoice.required_confirmations
--   6. On success: insert tx_hash into the invoice, apply credits via
--      CreditService.applyTopup() (one ledger row), mark `applied_at`.
--
-- Idempotency: the (chain, tx_hash) UNIQUE index is the load-bearing
-- guarantee — re-submitting the same hash is rejected at the SQL layer
-- before any credit is granted.

CREATE TABLE IF NOT EXISTS crypto_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,

  -- Logical chain id (matches CryptoChainId in src/types).
  -- 'tron-usdt' | 'ton-native' | 'ton-usdt-jetton' | …
  chain TEXT NOT NULL,

  -- 'pending'    — created, no payment claimed yet
  -- 'submitted'  — user pasted a tx hash; awaiting confirmations
  -- 'confirming' — adapter saw the tx but conf threshold not yet reached
  -- 'confirmed'  — credits applied (terminal success)
  -- 'expired'    — TTL elapsed without payment (terminal)
  -- 'failed'     — verification failed permanently (terminal)
  status TEXT NOT NULL DEFAULT 'pending',

  -- Amount the user owes. Stored as a decimal string in HUMAN UNITS so
  -- "10.5 USDT" reads naturally; chain decimals live alongside for the
  -- adapter to convert to base units (10500000 atomic for TRC20 USDT).
  amount_unit TEXT NOT NULL,
  amount_decimals INTEGER NOT NULL,
  amount_label TEXT NOT NULL,        -- e.g. "10.5 USDT"
  credits_to_grant INTEGER NOT NULL,

  -- Destination + attribution. memo is null on chains that don't support it
  -- (the user just pastes the tx hash on those chains).
  pay_to_address TEXT NOT NULL,
  memo TEXT,

  -- Filled in once the user pastes a hash or the poller finds a match.
  tx_hash TEXT,
  from_address TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL,

  -- Lifecycle timestamps.
  paid_at TEXT,
  applied_at TEXT,                   -- when credits were granted
  ledger_tx_id INTEGER,              -- credit_transactions.id for the topup row
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

-- Load-bearing dedup. A single tx hash on a single chain can credit at most
-- one invoice. The partial WHERE keeps the index small while the column is
-- still null for unpaid invoices.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_invoices_chain_tx
  ON crypto_invoices(chain, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crypto_invoices_user
  ON crypto_invoices(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crypto_invoices_status
  ON crypto_invoices(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_crypto_invoices_memo
  ON crypto_invoices(memo)
  WHERE memo IS NOT NULL;

-- Worker entry point: pending/submitted/confirming rows ordered by oldest
-- last_polled_at so the poller never starves a single invoice.
CREATE INDEX IF NOT EXISTS idx_crypto_invoices_pending_poll
  ON crypto_invoices(status, last_polled_at)
  WHERE status IN ('pending', 'submitted', 'confirming');
