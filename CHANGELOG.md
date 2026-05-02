# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/botnick/tg-vaultlink/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.1
[0.2.0]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.2.0
[0.1.0]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.1.0
