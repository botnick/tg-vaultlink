# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
