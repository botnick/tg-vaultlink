# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-04

### Added (broadcast system)

- **Full broadcast system, end-to-end.** Operators can compose, schedule,
  and send announcement messages to every user of any bot they own.
  Founders can broadcast on behalf of any bot. Persisted, resumable,
  rate-limited, idempotent at the recipient level. Composer + status
  surface live entirely in the Mini App.
- **Schema:** new `broadcasts` and `broadcast_recipients` tables (migration
  `003_broadcasts.sql`). `broadcasts` carries the content + audience
  snapshot + denormalized progress counters; `broadcast_recipients` is
  the per-user delivery row with status, retry count, error code, and
  message id. `users.broadcast_unsubscribed` flag added for the global
  opt-out.
- **`BroadcastRepository`**: insert / updateDraft / list / detail /
  delete / atomic `tryTransition` for status flips / `materializeRecipients`
  (single `INSERT OR IGNORE … SELECT FROM users WHERE <audience>` so a
  re-run after a crash is a no-op) / `claimPending` (atomic batch claim
  via SELECT-id + UPDATE-WHERE-status, single-process safe within
  SQLite's writer lock) / `markSent` / `markBlocked` / `markFailed` /
  `rescheduleForRetry` / `recomputeCounts`.
- **`BroadcastService`**: founder-or-bot-owner permission gate; text /
  button / audience JSON validation (URL scheme allowlist —
  http/https/tg only, max button rows + per-row caps); `audiencePreview`
  (count + 5 sample); typed-confirmation-required `send` ("SEND"
  literal); `schedule` with ISO 8601 input; idempotent `cancel`;
  `deleteDraft`. Audit entries on every write
  (`broadcast.create / send / cancel / schedule / delete`).
- **`BroadcastWorker`**: 1 Hz tick loop, batches of 50 recipients per
  broadcast per tick, dispatches via the owning bot's grammY `api`.
  Resumable on restart — anything left in `sending` resumes from
  pending recipients on the next tick. Rate limiting delegated to the
  per-bot throttler that's already on every bot's `api` (no second
  token bucket). Error classification (extracted to
  `utils/telegramErrors.ts`):
    - `403 / 400 unreachable` (blocked / chat-not-found / deactivated)
      → terminal `blocked`, never retried.
    - `429` with `parameters.retry_after` → `pending` with
      `next_attempt_at` set, retry budget per-recipient (default 3).
    - `5xx` → `pending` with exponential backoff (2s → 4s → 8s).
    - Other `4xx` → terminal `failed` with the description recorded.
- **Audience filter:** locale (`all / en / th`), role
  (`all / super_admin / user`), `exclude_banned`, `exclude_unsubscribed`,
  `registered_within_days`, and an explicit `user_ids` allowlist that
  short-circuits every other filter (test-send / "ping these specific
  users" workflows).
- **Template variables in the message body:** `{{first_name}}`,
  `{{last_name}}`, `{{full_name}}`, `{{username}}`, `{{user_id}}` —
  substituted at dispatch time and HTML-escaped or
  MarkdownV2-escaped according to the broadcast's `parse_mode` so a
  user with `<` in their name doesn't break markup.
- **Inline buttons:** up to 8 rows × 4 buttons each, text + url only.
  URL scheme whitelisted to `http(s)` and `tg://` so the broadcaster
  can never become a phishing redirector.
- **Media via Telegram `file_id`:** photo / video / document /
  animation. The composer takes a `file_id` you obtain by forwarding
  the file to your bot first; cross-bot send is rejected at dispatch
  time because Telegram `file_id`s are bot-scoped (the worker would
  surface a 400 from Telegram, not a silent corruption).
- **Flags:** `silent` (no notification sound), `protect_content` (no
  forward), `disable_web_page_preview`.
- **Lifecycle:** `draft → scheduled → sending → completed`. Or
  `draft → sending → completed`. Or
  `* → cancelled`. Status transitions are atomic — concurrent flips
  are rejected at the SQL level and the second caller gets the
  current row back.
- **Bot commands:** `/stop_broadcasts` flips
  `users.broadcast_unsubscribed=1` and audits
  `broadcast.user_unsubscribed`. `/start_broadcasts` re-subscribes.
- **Mini App API** — 11 endpoints under `/api/v1/broadcasts` (auth
  required, founder-or-owner enforced by service):
  `POST / GET / GET :id / PATCH :id / DELETE :id /
   POST :id/audience-preview / POST :id/send / POST :id/schedule /
   POST :id/cancel / GET :id/recipients`. Recipients endpoint
  enriches each row with the user's `username` + `first_name` so the
  detail table doesn't fan out N profile lookups from the frontend.
- **Mini App pages** — three new screens:
    - `/admin/broadcasts` — paginated list with status filter chips
      (all / draft / scheduled / sending / completed / cancelled /
      failed), live progress bar on `sending` rows, 4-second poll.
    - `/admin/broadcasts/new` and `/admin/broadcasts/:id/edit` —
      single-screen composer: bot picker, text editor with parse-mode
      toggle, flags (silent / protect / no preview), media file_id
      input, inline buttons editor, audience filter, audience
      preview button, Save Draft / Send Now / Schedule. Send-Now
      opens a confirmation dialog requiring the operator to type
      `SEND`.
    - `/admin/broadcasts/:id` — read-only detail with rendered
      content, audience snapshot, live progress (2-second poll while
      sending), per-recipient table with status filter chips and
      pagination, action bar with Edit (drafts only) / Cancel
      (anything pre-completion).
- **Locales:** every key in the broadcast surface translated en + th.

### Changed

- `ChildBotManager` exposes `getByBotId(botId)` for O(1) lookups by
  the local `managed_bots.id` (broadcast worker dispatches by
  `bot_id`). Indexed alongside the existing username map; both maps
  stay in sync on start / stop / runner-died.
- Extracted `isUnreachableChatError` from `bot/middlewares/error.middleware.ts`
  to `utils/telegramErrors.ts` so the broadcast worker can share it
  without importing bot-side modules.
- Added `getRetryAfterSeconds` and `isTelegramServerError` helpers
  alongside it for the worker's classifier.

### Notes

- 21 new tests (`broadcast.service.test.ts` + `broadcast.worker.test.ts`).
  Total now 185 (was 164). Lint clean, typecheck clean, Mini App
  production build is 333 KB JS / 26 KB CSS (94 KB / 6 KB gzipped).
- Resumable across restarts — broadcasts in `sending` on boot pick up
  from `pending` recipients on the next worker tick, no manual
  intervention needed.
- Single-process design — production deployments run one Node process
  per database, which the rest of the app already assumes. Multi-process
  would race on the recipient claim despite SQLite's writer lock; not
  needed at the project's 5,000-user scale and explicitly deferred.
- Edit / delete sent messages, Mini App media upload, A/B variants,
  and per-bot opt-out are tracked for v0.3.1.

## [0.2.5] - 2026-05-02

### Changed (admin Mini App — compact pass)

- **`AdminDashboard` is now one phone-screen tall on most viewports.**
  The aurora-mesh hero shrunk (`p-4`, `text-lg` heading) and the stat
  block went from a 2-column grid of large cards to a tight 3×2 grid of
  glass tiles (`rounded-xl px-2.5 py-2`, `text-lg` numerics). Drill-down
  shortcuts collapsed to a single column of compact rows: 36 px
  gradient icon, `text-sm` title, `text-[11px]` subtitle, `padding="sm"`
  cards, `space-y-2`. Outer `space-y-3` (was 5).
- **`AdminUsers` rows are half the height.** Promote / Demote actions
  moved from a full button row at the bottom of each card to inline
  28 px circular icon buttons (↑ / ↓) on the right side, only rendered
  when the action is available. Status pills shrunk to a single emoji
  in `text-[9px]` (🔑 founder, 👑 super, 🚫 banned). User metadata
  collapsed to one line: `tg #id · locale · joined`. Card padding
  `sm`, list `space-y-1.5`, search input `h-10` (was 11).
- **`AdminFiles` rows are tighter and the share-code line goes first.**
  The code+copy row leads each card; filename and metadata follow in
  smaller fonts (`text-xs` filename, `text-[10px]` meta with the
  created date inlined). Status pills use single emoji
  (`text-[9px]`, 🗑 / 🔒 / 🔑 / private / ⌛). Pill row only renders
  when at least one flag is set.
- **`AuditLogs` rows fit in two lines.** Action + timestamp on one
  row, actor + target inlined on the second, JSON toggle moved to
  `text-[9px]` and the JSON pre-block uses `text-[10px]
  max-h-56`. Filter inputs shrunk to `h-9 text-xs`.
- All admin pages dropped pagination icon size to 14 px and tightened
  the page label to `text-[11px]` for visual consistency.

### Notes

- No backend or schema changes; pure CSS / React layout pass.
- Typecheck + lint + 164 tests pass; Mini App production build is
  120 modules / 296 KB JS / 24 KB CSS (87 KB / 6 KB gzipped).

## [0.2.4] - 2026-05-04

### Added (admin Mini App overhaul)

- **System-wide file listing** — new `GET /api/v1/admin/files` returns
  every file across every bot, newest-first, server-enriched with the
  owner's `@username` / first name and the owning bot's username + mode.
  No more "this file's owner is `#197`" — the admin sees `@bbbbbn5 ·
Boat`. Powered by a new `FileRepository.listAll()`. The Mini App page
  also makes the share code itself a tap-to-copy surface.
- **System-wide user listing with live search** — `GET /admin/users`
  accepts `?q=` and matches case-insensitively against `username`,
  `first_name`, `last_name`, and `telegram_user_id`. The Mini App
  `AdminUsers` page wires this to a 250 ms debounced input box so
  every keystroke isn't a round-trip.
- **Founder-only role mutator endpoint** — new `POST
/api/v1/admin/users/:id/role` accepts `{role: 'super_admin' | 'user'}`
  and is gated by `permission.isFounder()` (env `ADMIN_IDS` only). The
  service-layer `userService.setRole()` re-checks the same predicate so
  a forgotten gate on a future code path can never escalate. The Mini
  App `AdminUsers` page renders per-row "Promote" / "Demote" buttons
  that fire this endpoint — the buttons are hidden for non-founders,
  for the operator's own row, and for founder targets (founders must
  be removed from `.env` first). Audit entries
  `user.promoted_to_super_admin` / `user.demoted_from_super_admin`
  fire on every successful mutation.
- **`is_founder` exposed on `/me`** so the frontend can render the
  founder-only affordances. The auth provider exposes
  `useAuth().isFounder` alongside `isAdmin`.
- **Audit log enrichment** — `GET /admin/audit` returns
  `actor: { id, telegram_user_id, username, first_name }` alongside the
  numeric `actor_user_id` so the UI can show `@username (Boat)` instead
  of `#197`. The Mini App `AuditLogs` page also adds a per-row
  "show / hide JSON" toggle that pretty-prints `metadata_json` with
  two-space indents in a scrollable preformatted block.

### Changed (Mini App)

- **`AdminDashboard` redesign**: aurora-mesh hero with six glass stat
  tiles (users / files / bots / downloads / pending / active files) +
  five gradient drill-down tiles (📁 all files, 👥 all users,
  🚩 reports, 📜 audit, 🤖 all bots). Replaces the flat 5-tile layout.
- **New routes**: `/admin/files` and `/admin/users` mounted under
  `<RequireAdmin>`. Pagination + skeleton loading + error retry, same
  pattern as the existing admin pages. Founder rows render with a
  🔑 brand-gradient pill in the user list; promoted super admins get
  the 👑 violet→fuchsia pill; banned rows get a 🚫 destructive pill.
- **AdminFiles share-code is tap-to-copy** — the `<code>` block plus
  a circular copy-icon button next to it both trigger the clipboard
  write with haptic feedback, matching the existing `FileDetail` and
  `CollectionDetail` pages.
- **New `UsersIcon`** in the icon set for the new admin user listing.

## [0.2.3] - 2026-05-04

### Changed (logging hygiene)

- **Mini App request logger split by status.** 5xx still logs at `error`
  (real bug), but 4xx — auth-expired 401s, permission-denied 403s, probe
  404s — drops to `warn`. Telegram clients aggressively retry the
  `/me` / `/files` / `/bots` endpoints when initData is briefly stale,
  so the previous "every 4xx is an error" rule was flooding the alert
  feed with normal traffic.
- **`Forbidden: bot was blocked by the user`** is now caught explicitly
  in the bot error boundary and logged at `warn` — not as an "unhandled
  bot error". Same handling for `chat not found`, `user is deactivated`,
  `bot was kicked`, and `bot can't initiate conversation`. These are
  user-side outcomes (the recipient walked away), not bugs to alert on.
  The error boundary also stops trying to reply with a generic message
  in those cases — the next `sendMessage` would just hit the same wall
  and produce another error log line.

## [0.2.2] - 2026-05-03

### Fixed

- **Oversized files now reject early** (when each file arrives) instead of
  silently passing into the upload session and only failing at finalise.
  The `MAX_FILE_SIZE_MB` check + blocked-extension check were lifted out
  of `FileService.upload` into the upload-router attachment handler so the
  user sees a localized "file is too large (max …)" reply immediately —
  no more orphan drafts left behind by a 1-item session that couldn't
  ship. `FileService.isFileTooLarge` and `FileService.isBlockedExtension`
  are now public so the router can run the same predicates. Defensive
  cleanup also drops the draft if `finalizeSession` ever fails for
  another reason.

### Changed

- **Quieter logs for expected user-input rejections.** AppError instances
  with `expose: true` (invalid token, file too large, password incorrect,
  not-found, locked, expired, etc.) now log at `warn` instead of `error` —
  these are normal traffic, not alerts. Genuine surprises (`expose:false`)
  still log at `error`. Same downgrade applied to the upload router's
  finalize-failure path.

## [0.2.1] - 2026-05-02

### Added (founder-tier admin)

- **Two-tier admin model**: anyone listed in `.env ADMIN_IDS` is a
  **founder** — the only role that can promote / demote other users to /
  from `role='super_admin'`. Promoted super admins inherit every
  super-admin power EXCEPT this one — they cannot grow the trust graph
  further. The env file stays the single root of authority and a
  compromised promoted account cannot escalate.
- **New commands** (founder-only, hidden from non-founders):
  `/promote [user_id]` — promote a regular user to super admin.
  `/demote [user_id]` — remove super admin from a previously-promoted user.
  `/super_admins` — list every super admin with a 🔑 founder / promoted tag.
- **`permission.isFounder(user)`** — strict check for `ADMIN_IDS`
  membership. Banned users are never founders.
- **`user.service.setRole()`** with defense-in-depth: re-checks
  founder status server-side, refuses self-mutation, refuses to
  promote a banned user, and refuses to demote a founder via DB
  (must remove from `.env` first). Idempotent on no-op.
- **`founderOnlyMiddleware`** — coarse first-pass gate, attached
  per-command (no global `composer.use`) so non-founder traffic
  doesn't reach handlers that would just throw.
- **Boot-time founder sync**: every `ADMIN_IDS` member is now seeded
  as `role='super_admin'` on every boot — previously only the first
  admin id got the role column set, the others were admins only via
  the runtime ADMIN_IDS check. Now `/super_admins` shows everyone
  consistently.
- **`/admin` menu adapts to founder role**: when the caller is a
  founder, an extra "🔑 Founder only" section lists `/promote`,
  `/demote`, and `/super_admins`. Non-founders never see those
  commands surfaced.
- **Audit log entries** `user.promoted_to_super_admin` and
  `user.demoted_from_super_admin` for every successful role change.

## [0.2.0] - 2026-05-02

### Changed (UX simplification — Tier A)

- **BotFather menu trimmed to 4 commands**: `/start /help /files /settings`.
  `/bots` and `/cancel` still work as hidden commands but are no longer
  surfaced in the Telegram client's `/` picker for less first-time
  cognitive load.
- **Aliases dropped**: `/my_files`, `/my_bots`, `/revoke`, `/lang`,
  `/dashboard`, `/admin_dashboard`. Replacements (`/files`, `/bots`,
  `/del`, `/settings`, the in-page WebApp button) cover every flow.
- **`/add_bot` is now a single command** that defaults to `personal_public`
  (anyone can decode AND upload, just like the system's main bot). Owners
  flip to private with `/mode private` later. The legacy `/add_bot_open`
  was removed.
- **`/mode public|private` replaces `/mode_public` and `/mode_private`** —
  one command with a subcommand argument; usage hint surfaces when the
  arg is missing.
- **`/help` is now paginated tabs**: 📖 Overview, 📁 Files, 🤖 Bots,
  🔧 Settings, and 🛡 Admin (visible only to moderators). Switching tabs
  edits the same message in place so the chat doesn't accumulate stale
  help bubbles. Each tab's body lists the commands relevant to that
  surface in monospace blocks.
- **Locale strings cleaned**: every `&lt;X&gt;` placeholder in usage hints
  was rewritten as `[X]` so the rendered message looks like
  `/del [CODE]` instead of the awkward escaped angle brackets.
- **`/bots` and `/files` are flat**: one chat message per invocation —
  list rows + pagination keyboard + Mini-App button. The previous
  per-row inline keyboards (one extra message per item) are gone; per-item
  management routes through slash commands or the Mini App.

### Added (cross-bot moderation)

- **Bot owners are now per-bot moderators.** Anyone who registered a bot
  via `/add_bot` can `/lock_file`, `/unlock_file`, `/delete_file`, and
  view `/admin_reports` — but ONLY for content on bots they own. Super
  admins keep their cross-bot powers; new methods
  `permission.canModerateFile`, `canModerateCollection`, and `isModerator`
  enforce the gate. `/admin_reports` filters the queue at the SQL layer
  (`SELECT … JOIN files WHERE bot_id IN (…)`) so a bot owner cannot see
  another owner's reports.
- **Confined `adminOnlyMiddleware`.** The previous global
  `composer.use(adminOnlyMiddleware())` accidentally blocked every
  subsequent middleware in the parent composer (decode router included)
  for non-admins, surfacing as a "permission denied" reply to plain-text
  share-code lookups. The middleware is now attached per-command via
  `composer.command(name, guard, handler)`.
- **`/admin` menu adapts to role**: bot owners see only the per-bot
  moderation block; super admins see the additional system-wide block
  (stats, ban/unban, broadcast).
- **Main system bot is no longer removable.** `/remove_bot @main_bot`
  and the Mini App `DELETE /bots/:id` both refuse when the row's mode
  is `main_public`. The bootstrap re-seeds the main row every restart
  anyway, but blocking the remove avoids a confusing "bot offline until
  restart" gap.

### Added (per-share visibility)

- **`visibility = private` is now enforced at decode time.**
  `share.ensureAccessible({ collection, actor })` and
  `file.service.decode({ user })` both reject non-owner non-admin callers
  with `FILE_NOT_AVAILABLE` (the same shape a deleted row produces) so
  private codes don't leak existence. Public is still the default and
  unchanged.

### Added (Mini App polish — fintech card aesthetic)

- **Brand palette + gradient utilities.** Tailwind config gains
  `bg-gradient-hero` (indigo → violet → pink), `bg-gradient-mint`,
  `bg-gradient-sunset`, and `bg-gradient-aurora` plus
  `shadow-glow` / `shadow-glow-pink` / `shadow-glow-cyan` and brand
  colour stops (`brand.indigo`, `brand.violet`, `brand.fuchsia`,
  `brand.pink`, `brand.cyan`, `brand.teal`, `brand.amber`).
- **Aurora-mesh hero**, `.glass` / `.glass-dark` surfaces with
  `backdrop-filter`, and a one-shot `shine-sweep` overlay that wraps
  primary buttons and the home hero. All animations respect
  `prefers-reduced-motion`.
- **Floating bottom-nav**: rounded glass pill above the safe-area, with
  a brand-gradient indicator behind the active tab — replaces the flat
  bottom bar.
- **Card variants** (`default` / `glass` / `gradient` / `outline`)
  with optional `accentGlow` (`violet` / `pink` / `cyan`).
- **`Button` primary** is a gradient pill with glow + shine sweep +
  haptic feedback; legacy flat style remains as `solid`.
- **Skeleton + EmptyState refresh**: skeleton rows show an avatar
  bubble + shimmer; empty states use a floating gradient bubble icon.
- **Home redesign**: aurora-mesh hero card with stat tiles ("Files",
  "Bots") in `glass-dark`, action grid below with per-tile gradient
  icon bubbles. Stagger-animation cascade on first paint.
- **`CopyButton` defaults to icon-only** (circular, 36×36, with
  copy-success check-mark feedback). The text-pill variant is still
  available via `<CopyButton variant="pill" …/>`.
- **`share_code` field on every file/collection DTO**: Mini App now
  shows the canonical `botname:CODE_<n><L>` form everywhere — the
  recipient can copy it from a list view and paste it back into chat
  without manually re-stitching the prefix.

### Added (Mini App diagnostics)

- **Per-request id** (`X-Request-Id` response header) stamped on every
  Mini App API call. Every 4xx and 5xx response is logged with that id,
  the path, status, and duration so a 500 can be matched 1-to-1 to its
  server stack — the request id is also returned in the JSON body so
  users can quote it in bug reports.

### Changed (UX)

- **Share code now carries a type-count suffix.** Codes display as
  `botname:CODE_<n>P_<m>V_<k>D` (Photos / Videos / Documents — also
  `A`udio, `W`(voice), `G`(animation), `S`(sticker)) so the recipient
  sees what's behind a code at a glance. Single-file shares get
  `_1P` / `_1V` / etc.; collections get the full breakdown
  (e.g. `mybot:KQ7TG2X4NPM3_5P_1V_1D`). The base code on the deep link
  is unchanged — `?start=KQ7TG2X4NPM3` still works — and the parser
  strips the suffix before lookup.
- **Separator restored to `:`.** Earlier in this Unreleased cycle we
  briefly switched the bot/code separator to `_` to dodge Telegram's
  auto-linker. With the new type-count suffix using `_` itself, `:`
  is the cleanest separator and matches the original design. The parser
  still accepts the brief `_` form for backward compatibility.
- **Upload sessions replace per-message bundling.** One session per
  `(bot, user)`, not per `media_group_id`. Any inbound media starts
  or extends the session; consecutive uploads — Telegram album, separate
  messages, or a mix — accumulate into one Collection draft. Rate limit
  is one slot per session (a rejected first item drops a sentinel so
  the rest of an in-flight album stays silent).
- **Confirmation prompt before finalising.** After a 1.5 s pause the bot
  posts (or edits) a "🛑 End adding?" prompt with live counts and a
  single button to finalise. Sending more files extends the session and
  refreshes the prompt; the button ships immediately. As a safety net
  the session auto-finalises 5 min after the last upload so drafts
  cannot stick. On finalise: 0 items → silent drop; 1 item with no
  description → single-file share; 1 item with a description, or 2+
  items → real Collection. The prompt message is deleted on close so
  it doesn't pollute the chat.
- **Text messages during a session become the collection description.**
  While the upload session is open, any plain-text message from the
  same user is captured as the description and shown in the next prompt
  refresh. The decode router only sees text outside of a session. The
  description appears alongside the share code in the final reply and
  is persisted on the collection row.
- **Collection preview now delivers real media.** Decoding a Collection
  share code ships the actual files for the current page — photos and
  videos in one Telegram media group, documents in their own group,
  audios in theirs, and animations / voice / stickers individually.
  A separate text + keyboard message follows with the page caption and
  numbered pagination buttons (📗 for current, ❎ for others) plus a
  "📂 send all remaining" shortcut that delivers pages from the
  current+1 onward, capped at `MAX_BULK_SEND_ITEMS`.
- **Less chatter, same gates.** The bot now stays quiet when nothing needs
  saying. Specifically:
  - Batch decode no longer posts a "Found N codes" banner or per-item
    success/failure replies. The delivered files are themselves the success
    indicator. If any code in the paste fails, ONE compact summary at the
    end lists the failed codes — that's it.
  - Single-code decode keeps the specific error replies (password prompt,
    locked, expired, …) so the user knows what to do next.
  - `help.intro`, `decode.prompt`, and `decode.prefix_required` rewritten as
    one-liners. Verbose multi-step "1. … 2. … 3. …" intros are gone.
  - Security gates are unchanged: strict `botname:CODE` prefix still
    enforced, rate limits still apply, password / lock / expiry / report
    flows untouched.
- **Albums become Collections automatically.** When the user uploads multiple
  media as one Telegram album, the upload router now detects the shared
  `media_group_id`, opens a draft, appends each item, and debounce-finalises
  ~1.5 s after the last arrival into a single Collection — replying ONCE with
  one share code instead of N "Upload successful" messages. No `/new`, no
  buttons; sending several files at once IS the way to bundle them.
- **Per-album rate-limit accounting.** An album counts as ONE upload event,
  not N: only the first item in a `media_group_id` consumes a slot from
  `UPLOAD_LIMIT_PER_HOUR`. Subsequent items in the same album skip the
  limiter, so a 17-photo album no longer burns through the hourly quota and
  no longer floods the user with rate-limited replies.
- **Removed the `/new` picker.** The "single file vs Collection" choice was
  redundant — single uploads stay single, multi-uploads auto-bundle. The
  `/new` command, the `coll:finish` / `coll:summary` / `coll:cancel`
  callbacks, and the "📤 สร้างรหัสแชร์" main-menu button are all gone.
  `PUBLIC_BOT_COMMANDS` is one shorter; `setMyCommands` reflects the
  cleaner surface on next boot.
- **Strict share-code prefix in chat.** The decode router now requires the
  full `botname:CODE` form (or a `https://t.me/<bot>?start=<CODE>` deep link).
  Bare codes typed alone are rejected with a clear hint. This removes a class
  of cross-bot misroutes when users paste a code to the wrong instance.
  Admin commands (`/del`, `/lock_file`, etc.) still accept bare codes —
  the strict gate only applies to plain-text decode messages.
- **Batch decode.** A single message can now carry many `botname:CODE`
  lines (one per line); the bot delivers each in order with a small spacing
  delay, capped at `MAX_BULK_SEND_ITEMS`, and posts a single summary at the
  end. Single-line messages keep the existing single-delivery UX.

### Added (transport)

- `TELEGRAM_UPDATE_MODE` env switch — pick `long_poll` (default, current
  behaviour) or `webhook`. In webhook mode every managed bot is registered
  on a single Hono listener at `<WEBHOOK_BASE_URL>/webhook/<telegram_bot_id>`
  with the optional `secret_token` header check. Telegram POSTs in instead
  of the bot polling out, which sidesteps the 409-Conflict races that arise
  when more than one process holds a `getUpdates` lock for the same token.
  New env: `WEBHOOK_BASE_URL`, `WEBHOOK_PORT`, `WEBHOOK_SECRET_TOKEN`.
- Long-poll preflight: before starting the runner the bootstrap now calls
  `getUpdates(timeout=0, offset=-1)` and retries on 409 until the stale
  poll lock from the previous process expires. Translation: a clean
  `Ctrl+C` followed by an immediate restart no longer fails with 409.

### Reliability

- Long-poll runner now self-heals on 409. grammY's runner treats 409 as a
  fatal `task()` rejection, but operationally a 409 just means a stale
  long-poll on Telegram's side hasn't expired yet. The wrapper restarts the
  runner with linear backoff (5 s → 10 s → 15 s → 20 s → 25 s → 30 s) up to
  six consecutive failures; the counter resets the moment any update flows
  through the bot, so legitimate transient races never escalate to a
  process exit. After the cap we log a clear "another deployment is
  polling Telegram" message and shut down so the operator sees the real
  failure signal.

### Performance

- SQLite tuned for high-throughput, low-memory operation: `cache_size=-32000`
  (32 MB page cache), `temp_store=MEMORY`, `mmap_size=128MB`,
  `wal_autocheckpoint=1000`, `journal_size_limit=64MB`. Conservative enough
  to fit a 1 GB container while still giving the planner working room.
- `PRAGMA optimize` runs on close so the next process boot starts with
  fresh query-planner stats.
- Long-poll shutdown now sends one final `getUpdates(offset=lastAcked+1,
timeout=0)` so Telegram releases the long-poll session immediately
  instead of holding it for up to 50 s. Translation: `Ctrl+C` →
  `pnpm dev` is sub-second again, no 409 wait.

### Fixed (critical: 409 Conflict on every restart)

- The main bot's row in `managed_bots` (mode `main_public`) was being picked
  up by `ChildBotManager.startAll()`, which spun up a SECOND grammY runner
  on the same `bot_id`. The bootstrap already owns the main bot's runner,
  so two pollers were racing inside one process — Telegram answered every
  `getUpdates` with **409 Conflict** and no token regen, no waiting, and
  no shutdown discipline could resolve it. `BotRepository.listActive()` now
  excludes `mode='main_public'`; the child manager only drives child bots,
  the main bot stays exclusively owned by `src/app.ts`. This was the real
  source of the persistent 409 on `pnpm dev` / `start.bat`.

### Fixed (operational reliability)

- Main bot now self-heals its `managed_bots` row on every successful boot:
  the encrypted token is refreshed from `.env`, `display_name` is re-synced,
  `status` is forced back to `active`, and any stale `last_error` is cleared.
  Operators can now recover from Telegram token regen, transient 401s, or any
  past `status='error'` state by simply restarting the process — no
  `db:reset`, no manual SQL. **Files, collections, users, reports,
  permissions, and audit logs are not touched.**

### Added

- `docs/SETUP.md` — Thai walkthrough that covers BotFather setup, encryption
  key generation, Mini App via ngrok/cloudflared, BotFather menu-button wiring,
  and the 409 / 401 / port-conflict recipes that come up during local testing.
- Mini App Vite dev server now proxies `/api` and `/healthz` to the bot's HTTP
  server on `127.0.0.1:8081` and whitelists `.ngrok-free.app`, `.ngrok.io`, and
  `.trycloudflare.com`, so a single tunnel on port 5173 covers both frontend
  and API without mixed-content errors.

### Changed

- `apps/mini-app/.env.example` now defaults `VITE_API_BASE_URL=/api/v1` so the
  same value works in localhost and behind any tunnel/proxy.

### Fixed

- `pnpm dev`, `pnpm start`, `pnpm db:migrate`, and `pnpm db:reset` now load
  `.env` via Node 20's built-in `--env-file` flag, matching the contract
  documented in `src/config/env.ts`. Without the flag the env schema rejected
  every run with a flood of "Required" issues.

## [0.1.0] - 2026-05-02

### Added

- Initial public release of VaultLink Bot.
- Telegram file uploads with share codes and deep links.
- Multi-bot support: add personal public or private bots via `/add_bot` and `/add_bot_open`.
- AES-256-GCM encryption for stored bot tokens.
- Per-user rate limits (upload, download, add_bot, report).
- Password-protected files (argon2id).
- Optional file expiry.
- Report and auto-lock at threshold.
- Admin commands: ban/unban, lock/unlock, delete file, broadcast (feature-flagged).
- Bilingual UX (th default, en).
- SQLite (WAL) storage with foreign keys; migration runner.
- Standalone and Docker runtimes.
- Auto build & release workflow on `v*` tags.

[Unreleased]: https://github.com/botnick/tg-vaultlink/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.4
[0.2.3]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.3
[0.2.2]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.2
[0.2.1]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.1
[0.2.0]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.0
[0.1.0]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.1.0
