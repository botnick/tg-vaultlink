-- VaultLink Bot — categorize abuse reports.
--
-- The reports queue used to carry a single free-text `reason` column, which
-- meant moderators had to skim the body of every entry to triage spam vs
-- copyright vs malware. We add a small enum discriminator so:
--   - moderators can filter the queue by category;
--   - submission UIs (Mini App report sheet, bot `/report`) can present a
--     short list of common categories instead of a blank text box;
--   - audit logs and stats can aggregate by category.
--
-- Existing rows backfill to `'other'` — they will surface in the catch-all
-- bucket without losing their free-text body. The CHECK constraint is
-- enforced at the application layer (the constants list lives in
-- `src/config/constants.ts`); we leave it OFF the column so a future enum
-- expansion does not require another table rebuild.
--
-- A second supporting index (idx_reports_reporter) powers the new
-- `/reports/mine` and `/my_reports` endpoints which list a single user's
-- own submissions. The existing idx_reports_target_status already covers
-- the per-target auto-lock count.

ALTER TABLE reports ADD COLUMN reason_category TEXT NOT NULL DEFAULT 'other';
CREATE INDEX IF NOT EXISTS idx_reports_reporter
  ON reports(reporter_user_id, created_at DESC);
