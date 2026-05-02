# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
