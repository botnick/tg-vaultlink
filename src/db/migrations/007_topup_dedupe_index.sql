-- VaultLink Bot — Wave 9.2: hard-dedupe Stars top-up ledger inserts.
--
-- v0.4.0 deferred per-payment-charge-id idempotency for Stars top-ups,
-- relying on the fact that Telegram doesn't normally redeliver the same
-- successful_payment. With openInvoice() now firing inside the Mini App
-- (where the user can plausibly retry-after-cancel) we close the gap at
-- the database layer: a single (reason='topup', reference_id=charge_id)
-- can never appear twice. A duplicate insert raises a UNIQUE constraint
-- violation that the topup handler surfaces as a logged no-op rather
-- than silently double-crediting.
--
-- The index is partial (only 'topup' rows) so it stays small and the
-- reference_id polymorphism on other reasons remains untouched.

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_topup_charge
  ON credit_transactions(reference_id)
  WHERE reason = 'topup' AND reference_id IS NOT NULL;
