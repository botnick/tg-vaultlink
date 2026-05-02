# Security Policy

VaultLink Bot stores access tokens and user-uploaded media on behalf of operators and end users. We take that seriously. This document describes which versions are supported, how to report a vulnerability, and what is and isn't in scope.

## Supported versions

| Version                | Status                                           |
| ---------------------- | ------------------------------------------------ |
| Latest minor on `main` | Supported. Receives security and bug fixes.      |
| Previous minor         | Critical fixes only, until the next minor lands. |
| Older minors           | End of life. Please upgrade.                     |

The project follows [Semantic Versioning](https://semver.org/). A "minor" here means the `0.X` segment until the project reaches `1.0`, and the `X.Y` segment thereafter.

## Reporting a vulnerability

**Please do not open public issues for security problems.** Instead, choose one of:

1. **Private GitHub security advisory** (preferred): open one at <https://github.com/botnick/tg-vaultlink/security/advisories>. This keeps the discussion attached to the repository and lets us collaborate on a patch in a private fork.
2. **Email**: write to `security@<your-domain>` (operators of this bot — replace this placeholder with your actual security contact before publishing the repo). Please encrypt sensitive details if you can.

Include enough detail to reproduce: affected version, environment, exact steps, and the impact you have already verified. Proof-of-concept code is welcome but not required.

We acknowledge reports within **3 business days** and aim to provide an initial assessment within **7 days**.

## Disclosure timeline

Our default disclosure window is **90 days** from the first acknowledged report. Within that window we will:

1. Confirm the issue and assign a severity.
2. Develop and review a patch in a private branch.
3. Cut a fixed release and publish a coordinated advisory crediting the reporter (unless they request anonymity).

If a fix is not feasible inside 90 days, we will reach out to extend the embargo with the reporter rather than letting it lapse silently. We may issue an early advisory if a vulnerability is being actively exploited.

## Threat model — what is covered

- **Bot tokens at rest.** Stored bot tokens (main and child) are encrypted with **AES-256-GCM** using a key supplied only via the `TOKEN_ENCRYPTION_KEY` environment variable. A fresh random 12-byte nonce is generated per record and stored alongside the ciphertext and auth tag in `managed_bots`.
- **Mini App authentication.** The Hono API authenticates exclusively via Telegram `initData`: `secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)`, `signature = HMAC-SHA256(secret_key, data_check_string)`. Comparison is constant-time and the `auth_date` field must be within `MINI_APP_INITDATA_MAX_AGE_SECONDS`. There are no browser cookies, no shared sessions, and no fall-through paths.
- **Webhook authentication (when `TELEGRAM_UPDATE_MODE=webhook`).** The Hono webhook listener verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header against `WEBHOOK_SECRET_TOKEN` via grammY's `webhookCallback`. Requests missing the header (or carrying a stale value) are rejected with 401 before the bot dispatcher ever sees them. Routing is by numeric `telegram_bot_id` to keep the URL space opaque, and the listener returns 404 for unknown ids without distinguishing them from "id never existed" responses.
- **Admin gate.** Admin endpoints and commands check both the `super_admin` role (persisted in `users.role`) and membership in `ADMIN_IDS` from the env. Either alone is sufficient; neither bypasses logging.
- **Logger redaction.** The pino logger is configured with redaction patterns that strip `token`, `password`, `Authorization`, and other secret-shaped fields before any log line leaves the process.
- **Strict env validation.** The startup config loader (`src/config/env.ts`) validates every variable with zod; missing or malformed values cause a fail-fast `AppError(CONFIG_INVALID)` whose message replaces secret fields with `<redacted>`. Webhook-mode validation also enforces `https://` for `WEBHOOK_BASE_URL` and Telegram's secret-token alphabet (`[A-Za-z0-9_-]{1,256}`) for `WEBHOOK_SECRET_TOKEN`.

## Threat model — what is NOT covered

- **SQLite file-level encryption.** The SQLite database is stored as plain WAL files on disk. We rely on the host's disk-level encryption for at-rest protection of file metadata and rate-limit state. **Use full-disk encryption** on production hosts and mount `./data` from a dedicated encrypted volume.
- **Telegram-side compromise.** A compromise of the Telegram Bot API or a stolen-token-via-Telegram scenario is out of scope. Rotate `MAIN_BOT_TOKEN` and re-encrypt child tokens if you suspect Telegram-side leakage.
- **Malicious bot owner uploading illegal content.** VaultLink does not perform content scanning. Abuse is mitigated through the report flow, the `AUTO_LOCK_REPORT_THRESHOLD` auto-lock, and admin moderation — not prevented at upload time.
- **Side-channel timing on argon2 verification.** argon2id provides constant-time comparison internally; we do not add additional padding around it.

## Operational security recommendations

- Treat `.env` as a **secret**. Never commit it; never paste it into logs or chats.
- **Rotate `TOKEN_ENCRYPTION_KEY` carefully.** Rotation requires re-encrypting every `managed_bots.encrypted_token` row with the new key. **No migration helper exists yet**; until one ships, plan rotations as a maintenance window: stop the bot, re-encrypt offline, restart with the new key. The main bot's row self-heals from `.env` on every boot, so only child-bot rows need offline re-encryption.
- **Always set `WEBHOOK_SECRET_TOKEN`** when running in webhook mode. Without it, anyone who learns your `WEBHOOK_BASE_URL` can POST forged updates straight to your handler. Generate ≥ 32 random bytes (`openssl rand -base64 32` then strip `=` `+` `/` to fit Telegram's alphabet, or just pull characters from `[A-Za-z0-9_-]`).
- **Terminate TLS in front of the webhook listener.** The bundled Hono server speaks plain HTTP on `WEBHOOK_PORT`; put it behind nginx / Caddy / Cloudflare to handle the certificate. Telegram requires HTTPS — `setWebhook` will reject anything else.
- Run as a **non-root** user. The provided Docker image already does this (`USER app`).
- Mount the `./data` volume from a **dedicated, encrypted** disk or volume.
- **Restrict `ADMIN_IDS`** to operators you trust. The first entry becomes `super_admin` on first run.
- Keep `MINI_APP_ALLOWED_ORIGINS` to the **minimum** set of origins you actually serve. Never use a wildcard.
- Subscribe to GitHub release notifications so security fixes reach you promptly.

## Abuse reporting

End users can flag content via `/report <code> <reason>` inside the bot. Once a file accumulates `AUTO_LOCK_REPORT_THRESHOLD` pending reports, it is **auto-locked** and becomes invisible to decoders pending operator review. Operators triage reports through `/admin` (or the Mini App's Reports page when `ENABLE_MINI_APP=true`).

Report submission itself is rate-limited per user via `REPORT_LIMIT_PER_HOUR` to prevent denial-of-service against legitimate creators.

## Cryptography

| Use                | Algorithm       | Notes                                                                                                                                                                        |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot tokens at rest | **AES-256-GCM** | 32-byte key from `TOKEN_ENCRYPTION_KEY`. Random 12-byte nonce per record. Auth tag stored alongside ciphertext.                                                              |
| File passwords     | **argon2id**    | Library defaults via `argon2`. Salt and parameters are encoded into the stored hash.                                                                                         |
| Mini App initData  | **HMAC-SHA256** | `secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)`; signature = `HMAC-SHA256(secret_key, data_check_string)`. Constant-time compare; `auth_date` freshness window from env. |

If you spot a deviation from any of the above in the codebase, please report it as a vulnerability — that itself is a bug we want to fix.
