-- VaultLink Bot — Wave 9.2: payment URI on crypto invoices.
--
-- Stores the wallet-deeplink/QR-payable URI alongside each invoice so the
-- string the user sees (and the QR they scan) is frozen at creation time.
-- That makes audit/forensics trivial — a support ticket can quote the exact
-- payload that was rendered to the customer without re-deriving it.
--
-- The URI is generated server-side from the chain's address + the invoice's
-- amount + memo (when supported). Standards-only: BIP-21 for BTC, ton://
-- for TON family; bare address for chains that lack a standard scheme.
-- Values are validated against an allowlist regex per chain before insert.
--
-- NULL = no URI (chain doesn't support a standard scheme); the Mini App
-- falls back to address-only QR + amount/memo as text in that case.

ALTER TABLE crypto_invoices ADD COLUMN payment_uri TEXT;
