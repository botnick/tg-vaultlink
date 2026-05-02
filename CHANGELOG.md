# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (UX)

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

[Unreleased]: https://github.com/botnick/tg-vaultlink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.1.0
