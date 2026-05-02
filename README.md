# VaultLink Bot

> Turn Telegram files into secure share codes you control.

[![CI](https://github.com/botnick/tg-vaultlink/actions/workflows/ci.yml/badge.svg)](https://github.com/botnick/tg-vaultlink/actions/workflows/ci.yml)
[![Docker](https://github.com/botnick/tg-vaultlink/actions/workflows/docker.yml/badge.svg)](https://github.com/botnick/tg-vaultlink/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Why VaultLink

VaultLink turns any file or media bundle uploaded through Telegram into a short, opaque share code that resolves through a deep link such as `https://t.me/<bot>?start=<code>`. A single code can resolve to one file or to a whole **collection** of media items, so creators can hand out one link instead of dumping a folder. Every operator-facing screen lives inside Telegram itself — power users get the chat UI and the optional Telegram Mini App for richer dashboards; there is no browser-side login surface to harden. Configuration is driven entirely from environment variables and a small SQLite settings table; the codebase enforces a strict no-hardcode discipline so you can re-tune limits, locales, and feature flags without recompiling.

## Features

- Single-file or **collection** share codes, with paginated previews and rate-limited bulk send
- Deep-link share via `https://t.me/<bot>?start=<code>`
- Personal child bots: `/add_bot <TOKEN>` (private) or `/add_bot_open <TOKEN>` (public)
- AES-256-GCM encrypted bot tokens at rest
- Per-user rate limits (upload, download, add_bot, report)
- Optional file passwords (argon2id) and file expiry
- Reports plus auto-lock at a configurable threshold
- Telegram Mini App: Files, Bots, Settings, Admin Dashboard, Reports, Audit Logs
- Bilingual UX (Thai default, English) — every user-visible string lives in locale JSON
- Production-grade concurrency: throttler + auto-retry transformer + grammY runner with per-user serialization
- **Two transport modes** — long polling (default, no public IP needed) or webhook (Telegram POSTs to a single Hono listener, optional `secret_token` header check); switch by editing `TELEGRAM_UPDATE_MODE` in `.env`
- **Self-healing main bot row** — on every successful boot the encrypted token is re-synced from `.env`, `status` is reset to `active`, and `last_error` is cleared, so token regen / past 401s recover with `pnpm dev` instead of `db:reset`
- **High-throughput SQLite tuning** out of the box (32 MB page cache, 128 MB mmap window, WAL auto-checkpoint at 1000 pages, `PRAGMA optimize` on close) — fits a 1 GB container while serving thousands of concurrent users

## Requirements

- **Node.js 20+** (the package declares `engines.node >= 20.0.0`)
- **pnpm 9** (the repo pins `packageManager: pnpm@9.12.0`)
- **SQLite** is bundled via `better-sqlite3` — nothing extra to install
- **Docker** (optional) for container deploys

## Quick start (standalone)

```powershell
pnpm install
Copy-Item .env.example .env
pnpm generate:key   # paste output into TOKEN_ENCRYPTION_KEY in .env
# fill MAIN_BOT_TOKEN and ADMIN_IDS in .env
pnpm db:migrate
pnpm dev
```

`pnpm dev` runs the bot under `tsx watch`. For production builds use `pnpm build` then `pnpm start`.

For a step-by-step walkthrough — BotFather, encryption keys, Mini App via ngrok, troubleshooting 409/401, port conflicts — see [`docs/SETUP.md`](./docs/SETUP.md) (Thai).

## Quick start (Docker)

```powershell
docker compose up -d --build
docker compose logs -f
```

The compose file mounts `./data` so the SQLite database survives container restarts. The image runs as a non-root `app` user behind `tini`.

## BotFather setup

1. In [@BotFather](https://t.me/BotFather), run `/newbot` to create your main bot. Paste the token into `MAIN_BOT_TOKEN`.
2. (Recommended) Tighten group behaviour: `/setjoingroups` → **Disable** and `/setprivacy` → **Enable**. The bot is designed for DMs.
3. (Optional, for Mini App UX) Run `/setmenubutton` and provide the public HTTPS Mini App URL — this surfaces the Mini App from the bot's menu. Skip `/setdomain`; VaultLink does not use Telegram's Login Widget.
4. **Do not** call `/setcommands` manually. The bot calls `setMyCommands` itself on every boot from `src/bot/commands.ts`, so a manual list would be overwritten.

For a step-by-step BotFather tour (`/newbot`, profile fields, behavior toggles, Mini App via `/newapp`, token revoke), see [`docs/SETUP.md`](./docs/SETUP.md).

## Environment variables

The variables below are the complete set declared in `src/config/env.ts` and mirrored in `.env.example`. A blank cell under **Default** means the variable has no fallback and must be supplied. All values are validated at startup; on any mismatch the process **fails fast** with a redacted error report.

### Runtime

| Name             | Default               | Required | Description                                                                                     |
| ---------------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`       | `production`          | yes      | One of `development`, `production`, `test`.                                                     |
| `APP_NAME`       | `VaultLink Bot`       | yes      | Display name used in startup logs and admin surfaces.                                           |
| `APP_PUBLIC_URL` | `https://example.com` | yes      | Canonical public URL for the deployment. Validated as `http(s)`; trailing slashes are stripped. |

### Telegram

| Name                      | Default                    | Required | Description                                                        |
| ------------------------- | -------------------------- | -------- | ------------------------------------------------------------------ |
| `TELEGRAM_API_BASE_URL`   | `https://api.telegram.org` | yes      | Bot API base URL. Override only if you run a local Bot API server. |
| `TELEGRAM_DEEP_LINK_BASE` | `https://t.me`             | yes      | Used to build deep links for share codes.                          |

### Main bot

| Name             | Default | Required | Description                                                                      |
| ---------------- | ------- | -------- | -------------------------------------------------------------------------------- |
| `MAIN_BOT_TOKEN` | —       | yes      | Telegram bot token from BotFather. Validated against `^\d+:[A-Za-z0-9_-]{30,}$`. |

### Database

| Name            | Default                   | Required | Description                                                                |
| --------------- | ------------------------- | -------- | -------------------------------------------------------------------------- |
| `DATABASE_PATH` | `./data/vaultlink.sqlite` | yes      | Path to the SQLite file. The directory must be writable. WAL mode is used. |

### Crypto

| Name                   | Default | Required | Description                                                                                                                     |
| ---------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEY` | —       | yes      | 32 bytes of entropy, base64-encoded. Generate with `pnpm generate:key`. Standard or url-safe base64 accepted; padding optional. |

### Admin

| Name        | Default | Required | Description                                                                                              |
| ----------- | ------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `ADMIN_IDS` | —       | yes      | Comma-separated Telegram numeric user IDs. The first entry is auto-seeded as `super_admin` on first run. |

### Localization and logging

| Name             | Default | Required | Description                                                |
| ---------------- | ------- | -------- | ---------------------------------------------------------- |
| `DEFAULT_LOCALE` | `th`    | yes      | One of `th`, `en`. Per-user locale overrides this.         |
| `LOG_LEVEL`      | `info`  | yes      | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |

### Limits and moderation

| Name                         | Default                              | Required | Description                                                                                          |
| ---------------------------- | ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `CODE_LENGTH`                | `12`                                 | yes      | Length of generated share codes; bounded `4..32`. The alphabet excludes `0/1/I/L/O` for readability. |
| `MAX_FILE_SIZE_MB`           | `50`                                 | yes      | Per-file upload ceiling in MiB; bounded `1..4096`.                                                   |
| `BLOCKED_EXTENSIONS`         | `.exe,.bat,.cmd,.scr,.ps1,.msi,.apk` | yes      | Comma-separated list. Lowercased; a leading dot is added if missing.                                 |
| `UPLOAD_LIMIT_PER_HOUR`      | `20`                                 | yes      | Per-user upload limit.                                                                               |
| `DOWNLOAD_LIMIT_PER_HOUR`    | `100`                                | yes      | Per-user decode limit.                                                                               |
| `ADD_BOT_LIMIT_PER_DAY`      | `5`                                  | yes      | Per-user `/add_bot*` limit.                                                                          |
| `REPORT_LIMIT_PER_HOUR`      | `10`                                 | yes      | Per-user `/report` limit.                                                                            |
| `AUTO_LOCK_REPORT_THRESHOLD` | `3`                                  | yes      | Number of pending reports that triggers auto-lock; bounded `>= 1`.                                   |
| `DEFAULT_FILE_EXPIRY_DAYS`   | `0`                                  | yes      | `0` disables expiry; otherwise the default lifetime in days.                                         |

### Update channel

| Name                          | Default                  | Required                                 | Description                                                                                                                                                                           |
| ----------------------------- | ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_UPDATE_MODE`        | `long_poll`              | yes                                      | One of `long_poll` (bot polls Telegram, works behind any NAT) or `webhook` (Telegram POSTs into our Hono listener; needs public HTTPS).                                               |
| `WEBHOOK_BASE_URL`            | —                        | only when `TELEGRAM_UPDATE_MODE=webhook` | Public `https://` URL that reaches this process (or its reverse proxy). Each managed bot is registered at `<WEBHOOK_BASE_URL>/webhook/<telegram_bot_id>`.                             |
| `WEBHOOK_PORT`                | `8443`                   | yes                                      | Local TCP port for the Hono listener; bounded `1..65535`. Telegram-allowed default ports are `80`, `88`, `443`, and `8443` (or any port if you reverse-proxy 443 down to it).         |
| `WEBHOOK_SECRET_TOKEN`        | —                        | optional                                 | Echoed back by Telegram in the `X-Telegram-Bot-Api-Secret-Token` header so the listener can reject forged calls. Alphabet `A-Za-z0-9_-`, length `1..256`. Highly recommended in prod. |
| `BOT_POLLING_ALLOWED_UPDATES` | `message,callback_query` | yes                                      | Comma-separated allowed update types. Permitted values: `message`, `callback_query`, `edited_message`, `inline_query`, `chosen_inline_result`.                                        |

### Feature flags

| Name                         | Default | Required | Description                         |
| ---------------------------- | ------- | -------- | ----------------------------------- |
| `ENABLE_PASSWORD_PROTECTION` | `true`  | yes      | Toggle file passwords.              |
| `ENABLE_FILE_EXPIRY`         | `true`  | yes      | Toggle file expiry.                 |
| `ENABLE_REPORTS`             | `true`  | yes      | Toggle the report flow.             |
| `ENABLE_CHILD_BOTS`          | `true`  | yes      | Toggle `/add_bot*`.                 |
| `ENABLE_ADMIN_BROADCAST`     | `false` | yes      | Toggle the broadcast admin command. |

### Health server

| Name                    | Default     | Required | Description                                 |
| ----------------------- | ----------- | -------- | ------------------------------------------- |
| `HEALTH_SERVER_ENABLED` | `false`     | yes      | Optional HTTP liveness server.              |
| `HEALTH_SERVER_HOST`    | `127.0.0.1` | yes      | Bind host when enabled.                     |
| `HEALTH_SERVER_PORT`    | `8080`      | yes      | Bind port when enabled; bounded `0..65535`. |

### Mini App

| Name                                | Default | Required                         | Description                                                                               |
| ----------------------------------- | ------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `ENABLE_MINI_APP`                   | `false` | yes                              | When true the Hono API server starts and Mini App entry buttons are rendered.             |
| `MINI_APP_URL`                      | —       | only when `ENABLE_MINI_APP=true` | Public URL of the Mini App frontend. Must be `http(s)`.                                   |
| `MINI_APP_API_BASE_URL`             | —       | only when `ENABLE_MINI_APP=true` | Public URL of the Hono API. The bind port is taken from this URL.                         |
| `MINI_APP_ALLOWED_ORIGINS`          | —       | only when `ENABLE_MINI_APP=true` | Comma-separated CORS allowlist. Never wildcarded.                                         |
| `MINI_APP_INITDATA_MAX_AGE_SECONDS` | `86400` | yes                              | Maximum acceptable `auth_date` age for `Telegram.WebApp.initData`. Bounded `60..2592000`. |

### Collections

| Name                           | Default | Required | Description                                                       |
| ------------------------------ | ------- | -------- | ----------------------------------------------------------------- |
| `ENABLE_COLLECTIONS`           | `true`  | yes      | Toggle multi-file share codes.                                    |
| `COLLECTION_PAGE_SIZE`         | `10`    | yes      | Items per preview page; bounded `1..100`.                         |
| `COLLECTION_DRAFT_TTL_MINUTES` | `60`    | yes      | Idle draft TTL; bounded `1..1440`.                                |
| `COLLECTION_SEND_DELAY_MS`     | `700`   | yes      | Pacing delay between bulk-send items; bounded `0..10000`.         |
| `MAX_COLLECTION_ITEMS`         | `100`   | yes      | Upper bound on items per collection; bounded `1..10000`.          |
| `MAX_BULK_SEND_ITEMS`          | `50`    | yes      | Upper bound on items per bulk-send invocation; bounded `1..1000`. |

### Telegram limits

| Name                                     | Default | Required | Description                                              |
| ---------------------------------------- | ------- | -------- | -------------------------------------------------------- |
| `TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC`     | `30`    | yes      | Throttler global ceiling.                                |
| `TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC`   | `1`     | yes      | Throttler per-chat ceiling.                              |
| `TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN`  | `20`    | yes      | Throttler per-group ceiling.                             |
| `TELEGRAM_MEDIA_GROUP_MAX_ITEMS`         | `10`    | yes      | Cap on media-group items; bounded `2..10`.               |
| `TELEGRAM_MESSAGE_MAX_LENGTH`            | `4096`  | yes      | Cap on outbound text length; bounded `1..4096`.          |
| `TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS`   | `100`   | yes      | Cap on inline keyboard buttons.                          |
| `TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH` | `8`     | yes      | Cap on buttons per row.                                  |
| `TELEGRAM_CALLBACK_DATA_MAX_BYTES`       | `64`    | yes      | Cap on callback-data payload size.                       |
| `TELEGRAM_LONG_POLL_TIMEOUT_SECONDS`     | `50`    | yes      | Long-poll timeout; bounded `1..50`.                      |
| `TELEGRAM_AUTORETRY_MAX_ATTEMPTS`        | `5`     | yes      | `@grammyjs/auto-retry` attempts on 429; bounded `0..10`. |
| `TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS`   | `60`    | yes      | Cap on the auto-retry sleep window; bounded `0..600`.    |

### Concurrency

| Name                            | Default | Required | Description                                                                                         |
| ------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------- |
| `RUNNER_CONCURRENCY`            | `200`   | yes      | Max in-flight handlers in the grammY runner. Per-user updates serialize regardless of this ceiling. |
| `CHILD_BOT_MAX_PARALLEL_STARTS` | `16`    | yes      | Fan-out cap when warming child bots on boot.                                                        |
| `BROADCAST_DELAY_MS`            | `50`    | yes      | Pacing delay between admin-broadcast messages; bounded `0..10000`.                                  |

## Commands

The advertised public command surface is intentionally small. Legacy commands (`/my_files`, `/add_bot`, `/add_bot_open`, `/lock_file`, `/del`, `/set_password`, `/report`, etc.) remain registered as hidden aliases for power users.

```
/start    เปิดเมนูหลัก / Open main menu
/help     วิธีใช้งาน / How to use
/new      สร้างรหัสแชร์ / Create a share
/files    ไฟล์ของฉัน / My files
/bots     บอทส่วนตัว / My bots
/settings ตั้งค่า / Settings
/cancel   ยกเลิก / Cancel
/admin    Admin dashboard (admins only — registered per-chat)
```

`/admin` is registered with a chat-scoped `setMyCommands` call against each `ADMIN_IDS` entry, so it appears in the client menu only for known administrators.

## Personal bot feature

VaultLink supports two flavours of "child bot":

- `/add_bot <TOKEN>` — **private** mode. The added bot serves the owner only.
- `/add_bot_open <TOKEN>` — **public** mode. The added bot accepts uploads from any Telegram user, subject to the same per-user rate limits and moderation rules as the main bot.

Tokens are encrypted at rest with AES-256-GCM keyed by `TOKEN_ENCRYPTION_KEY` (a fresh random 12-byte nonce is generated per row, stored alongside the ciphertext and auth tag in `managed_bots`). Tokens are never written to disk in plaintext and are redacted from log output.

## Collections

A share code can resolve to either a single file or a **collection** of media items. Collections are assembled in a transient `collection_drafts` row (TTL governed by `COLLECTION_DRAFT_TTL_MINUTES`); on finish, the draft is snapshotted into `collections` and `collection_items` and a unique code is minted. The decode flow shows a paginated preview (controlled by `COLLECTION_PAGE_SIZE`) before any media is sent. Bulk send is opt-in, capped by `MAX_BULK_SEND_ITEMS`, and paced by `COLLECTION_SEND_DELAY_MS` to stay friendly to the Telegram throttler.

Code uniqueness is enforced **per bot, across both `files` and `collections` tables**: a code cannot collide between the two shapes for the same bot.

## Telegram Mini App

When `ENABLE_MINI_APP=true`, the bot starts a Hono HTTP API server (port derived from `MINI_APP_API_BASE_URL`, defaulting to `8081`) and the in-bot commands `/dashboard`, `/files`, `/bots`, and `/admin_dashboard` render an inline keyboard with a `WebApp` button pointing at `MINI_APP_URL`. Authentication is **`Telegram.WebApp.initData` HMAC** verified server-side with constant-time compare and an `auth_date` freshness check; there are no browser cookies and no shared web sessions. CORS is allowlist-driven via `MINI_APP_ALLOWED_ORIGINS` — never `*`.

The frontend lives in `apps/mini-app/` with its own [README](apps/mini-app/README.md). It is a Vite + React + Tailwind app themed against `Telegram.WebApp.themeParams`.

## Security model

See [SECURITY.md](./SECURITY.md) for the full policy. In short:

- Bot tokens are encrypted at rest with AES-256-GCM.
- File passwords are hashed with argon2id.
- Mini App auth uses `initData` HMAC-SHA256 with constant-time compare and an `auth_date` freshness window (`MINI_APP_INITDATA_MAX_AGE_SECONDS`).
- The pino logger redacts `token`, `password`, `Authorization`, and other secret-shaped fields by default.
- Admin actions are gated by `ADMIN_IDS` membership and the `super_admin` role.

## Scaling and Telegram limits

Outbound Telegram traffic flows through three stacked layers: the `@grammyjs/transformer-throttler` (global, per-chat and per-group ceilings), `@grammyjs/auto-retry` (honors `retry_after` on 429), and the `@grammyjs/runner` (parallel update dispatch with per-user serialization). The relevant tuning knobs are:

- `TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC`, `TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC`, `TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN` — throttler ceilings.
- `TELEGRAM_AUTORETRY_MAX_ATTEMPTS`, `TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS` — retry behavior.
- `RUNNER_CONCURRENCY` — max in-flight update handlers across all users.
- `CHILD_BOT_MAX_PARALLEL_STARTS` — fan-out cap when warming child bots on boot.

A single Node process running with these defaults comfortably serves thousands of concurrent users on a small VPS.

The SQLite layer is also tuned for this profile out of the box — `cache_size=-32000` (32 MB page cache), `temp_store=MEMORY`, `mmap_size=128MB`, `wal_autocheckpoint=1000`, `journal_size_limit=64MB`, plus `PRAGMA optimize` on shutdown to keep query-planner stats fresh across restarts. These are conservative enough to fit a 1 GB container without swapping the planner under sustained load. Bump them in your own deployment fork if your host has spare RAM and you measure real win.

## Backup guide

The simplest backup is to **stop the bot** and copy the SQLite WAL set:

```powershell
docker compose stop
Copy-Item .\data\vaultlink.sqlite*  .\backup\
docker compose start
```

The `*` glob picks up the main file plus the `-wal` and `-shm` siblings.

For **hot** backups, use SQLite's online-backup API:

```powershell
sqlite3 .\data\vaultlink.sqlite ".backup .\backup\vaultlink-$(Get-Date -Format yyyyMMdd-HHmm).sqlite"
```

This runs while the bot is up and produces a consistent copy without the WAL files.

## Admin guide

- Add Telegram numeric user IDs to `ADMIN_IDS` in `.env`. The **first** entry is auto-seeded as `super_admin` on first run.
- `/admin` opens the admin surface. When `ENABLE_MINI_APP=true` it routes to the Mini App's Admin Dashboard; otherwise it falls back to a short inline-keyboard menu.
- Admins can lock/unlock files, soft-delete files, ban/unban users, and review pending reports.
- Set `ENABLE_ADMIN_BROADCAST=true` to surface the broadcast command. Broadcast pacing is controlled by `BROADCAST_DELAY_MS`.

## Update discipline

Whenever you change behaviour, run through this checklist before merging:

- [ ] `package.json` version bumped (when release-worthy)
- [ ] `CHANGELOG.md` entry under `[Unreleased]`
- [ ] `README.md` updated if commands, env vars, or features changed
- [ ] `.env.example` matches `src/config/env.ts` exactly (both directions)
- [ ] Both locale files (`src/locales/th.json` and `src/locales/en.json`) updated for any new user-visible string
- [ ] `Dockerfile` and `docker-compose.yml` updated if base image or runtime config changed
- [ ] Tests added or updated
- [ ] No hardcoded values introduced

The same checklist is enforced via `.github/PULL_REQUEST_TEMPLATE.md`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow.

## No-Hardcode Policy

VaultLink is designed so that **no operator-tunable value is baked into the source**. In particular:

- Bot tokens, admin IDs, database path, public URL, Telegram API URL, rate limits, file size limits, blocked extensions, locale text, feature flags, and the encryption key all come from environment variables validated by `src/config/env.ts`.
- Per-deployment switches that need to flip at runtime live in the SQLite `settings` table.
- All user-visible strings live in `src/locales/{th,en}.json`.

If a required value is missing or malformed, `loadConfig()` throws an `AppError(CONFIG_INVALID)` carrying the full issue list with secret fields replaced by `<redacted>`. There is no silent fallback.

## Auto build and release

Pushing a `v*` tag (for example `v0.2.0`) triggers `.github/workflows/release.yml`, which:

1. Installs dependencies with the frozen lockfile.
2. Runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
3. Extracts release notes for that version from `CHANGELOG.md`.
4. Packs a tarball containing `dist/`, `package.json`, `pnpm-lock.yaml`, `LICENSE`, the SQL migrations, and the locale JSON files.
5. Builds and pushes a multi-arch (`linux/amd64`, `linux/arm64`) Docker image to **GHCR** as `ghcr.io/botnick/tg-vaultlink:<version>` and `:latest`.
6. Creates a GitHub Release with the extracted notes and the tarball attached.

## Project structure

```
src/
  config/         # env loader and constants (single source of truth)
  logger/         # pino setup with redaction
  db/             # better-sqlite3 wrapper, migrations, schema
  repositories/   # SQL access (one repo per table family)
  services/       # domain logic (file, share, bot, audit, etc.)
  bot/            # grammY composer, routers, middlewares, child bot manager
  miniapp/        # Hono server, initData verification, route modules
  utils/          # crypto-free helpers
  locales/        # th.json + en.json
  types/          # shared TS types
apps/mini-app/    # Telegram Mini App frontend (Vite + React + Tailwind)
tests/            # vitest suite
.github/workflows # CI, Docker, Release workflows
```

## Troubleshooting

- **Bot won't start.** Re-check `MAIN_BOT_TOKEN` matches the Telegram regex (`<digits>:<30+ chars>`). Verify `TOKEN_ENCRYPTION_KEY` decodes to exactly 32 bytes; regenerate with `pnpm generate:key`. Confirm `DATABASE_PATH` resolves to a directory the process can write to.
- **`409 Conflict: terminated by other getUpdates request`.** Long-poll lock is held by another instance of this bot. The bootstrap calls `getUpdates(timeout=0, offset=-1)` and retries until the lock clears, and the shutdown path acks the latest offset to release the lock immediately — so a normal `Ctrl+C` → restart is sub-second. If the 409 sticks, you have **another deployment of the same token** somewhere (other host, container, cron); kill it or `/revoke` the token in BotFather. Switching to `TELEGRAM_UPDATE_MODE=webhook` sidesteps the polling lock entirely.
- **`401 Unauthorized` after token regen.** Update `MAIN_BOT_TOKEN` in `.env` and restart. The boot path self-heals the `managed_bots` row (re-encrypts the token, resets `status='active'`, clears `last_error`) — no `db:reset`, no manual SQL.
- **`429 Too Many Requests` in logs.** Raise the throttler ceilings (`TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC`, etc.). The auto-retry transformer already honors Telegram's `retry_after`, so most 429s self-heal — sustained 429s indicate a misconfigured ceiling.
- **Mini App says "Open inside Telegram".** Expected behaviour: the frontend guards against being opened in a regular browser. Open it from a `WebApp` button or the bot's menu-button entry inside Telegram.
- **Migrations fail.** In dev, `pnpm db:reset` drops and re-applies. The reset path **refuses to run in production** as a safety net — never `rm` the SQLite file in prod without a backup.

## Roadmap

- S3 / object-storage file proxy for very large media (currently capped at Telegram's 50 MB bot upload ceiling)
- Additional locales beyond Thai and English
- Optional Postgres backend for multi-instance deployments
- `TOKEN_ENCRYPTION_KEY` rotation tool (re-encrypts every `managed_bots` row)
- Configurable retention for `audit_logs` and `file_access_logs`

## License

MIT, Copyright (c) 2026 VaultLink Bot Contributors. See [LICENSE](./LICENSE).
