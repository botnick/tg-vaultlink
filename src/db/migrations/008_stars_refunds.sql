-- VaultLink Bot — Wave 9.2: Stars refund defense.
--
-- Telegram lets a user dispute a Stars payment for up to 14 days; on
-- approval Telegram delivers a `refunded_payment` service message. Without
-- a defense, a hostile user could buy credits, redeem them for files, then
-- request a refund and walk away with both. This migration wires the
-- storage for a four-layer response:
--
--   1. CLAWBACK — when the refund event fires, reverse the original
--      `topup` ledger entry. Allows the cached `users.credits` to go
--      negative (the existing `applyDelta` rejects overdraft, so further
--      spending naturally fails until the deficit clears).
--
--   2. TIME LOCK — `users.spend_locked_until` is a wall-clock ISO timestamp
--      after which spending is allowed again. The handler sets it to
--      `now + (stars * STARS_REFUND_LOCK_SECONDS_PER_STAR)`, capped at
--      STARS_REFUND_LOCK_MAX_SECONDS. While the field is in the future,
--      every credit-spend short-circuits with SPEND_LOCKED.
--
--   3. REPEAT-OFFENDER HARD BAN — `refund_count` and
--      `total_refunded_stars` are running totals. The service computes
--      "events in the last STARS_REFUND_HARD_BAN_WINDOW_DAYS" by querying
--      audit_logs (already indexed on actor + action) and flips
--      `is_banned = 1` once the threshold trips.
--
--   4. ADMIN OVERRIDE — founder-only Mini App endpoints clear
--      `spend_locked_until` and (optionally) write off the deficit via an
--      `admin_writeoff` ledger row, for legitimate disputes Telegram
--      support occasionally honors.
--
-- Defensive: the index is partial so non-locked users don't pay any cost.

ALTER TABLE users ADD COLUMN spend_locked_until TEXT;
ALTER TABLE users ADD COLUMN refund_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN total_refunded_stars INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_spend_locked
  ON users(spend_locked_until)
  WHERE spend_locked_until IS NOT NULL;
