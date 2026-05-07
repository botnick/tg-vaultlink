/**
 * Shared in-memory SQLite helper for service-level tests.
 *
 * The production migration runner relies on the singleton {@link getConfig}
 * to resolve the database path. Service tests need a clean schema per case
 * without coupling to that singleton, so this helper opens a fresh
 * `:memory:` connection, applies the same PRAGMAs the production factory
 * uses, and replays the migration SQL straight from disk. The exposed
 * {@link TestRepos} bundle is what real services consume in production —
 * the only thing tests choose to swap is *which* DB the repos point at.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { UserRepository } from '../../src/repositories/user.repository.js';
import { FileRepository } from '../../src/repositories/file.repository.js';
import { BotRepository } from '../../src/repositories/bot.repository.js';
import { PermissionRepository } from '../../src/repositories/permission.repository.js';
import { ReportRepository } from '../../src/repositories/report.repository.js';
import { AuditRepository } from '../../src/repositories/audit.repository.js';
import { SettingsRepository } from '../../src/repositories/settings.repository.js';
import { RateLimitRepository } from '../../src/repositories/rateLimit.repository.js';
import { CollectionRepository } from '../../src/repositories/collection.repository.js';
import { CollectionDraftRepository } from '../../src/repositories/collectionDraft.repository.js';
import { BroadcastRepository } from '../../src/repositories/broadcast.repository.js';
import { CreditRepository } from '../../src/repositories/credit.repository.js';
import { CryptoInvoiceRepository } from '../../src/repositories/cryptoInvoice.repository.js';

import type { Config } from '../../src/config/env.js';
import type { BotMode, ManagedBotRow, UserRole, UserRow } from '../../src/types/index.js';

/** All repositories wired against a shared in-memory DB handle. */
export interface TestRepos {
  users: UserRepository;
  files: FileRepository;
  bots: BotRepository;
  permissions: PermissionRepository;
  reports: ReportRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
  rateLimit: RateLimitRepository;
  collections: CollectionRepository;
  collectionDrafts: CollectionDraftRepository;
  broadcasts: BroadcastRepository;
  credits: CreditRepository;
  cryptoInvoices: CryptoInvoiceRepository;
}

export interface TestEnv {
  db: Database.Database;
  repos: TestRepos;
  close: () => void;
  config: Config;
}

/**
 * Fully-populated, frozen {@link Config} stub. All numeric limits are set to
 * non-zero so service-side guard rails actually fire when tests want to hit
 * them. The encryption key is a real 32-byte buffer (filled with `0x01`) so
 * any code path that touches the AES-GCM key shape is happy.
 */
function defaultConfig(): Config {
  const cfg: Config = {
    NODE_ENV: 'test',
    APP_NAME: 'vaultlink-bot',
    APP_PUBLIC_URL: 'https://example.test',
    TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
    TELEGRAM_DEEP_LINK_BASE: 'https://t.me',
    MAIN_BOT_TOKEN: '123456:AAAA-test-token-AAAA-test-token-AAAA',
    DATABASE_PATH: ':memory:',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1),
    ADMIN_IDS: Object.freeze(['9999999']) as readonly string[],
    DEFAULT_LOCALE: 'en',
    LOG_LEVEL: 'info',
    CODE_LENGTH: 12,
    MAX_FILE_SIZE_MB: 50,
    BLOCKED_EXTENSIONS: Object.freeze(['.exe']) as readonly string[],
    UPLOAD_LIMIT_PER_HOUR: 100,
    DOWNLOAD_LIMIT_PER_HOUR: 200,
    ADD_BOT_LIMIT_PER_DAY: 10,
    REPORT_LIMIT_PER_HOUR: 20,
    AUTO_LOCK_REPORT_THRESHOLD: 3,
    DEFAULT_FILE_EXPIRY_DAYS: 30,
    BOT_POLLING_ALLOWED_UPDATES: Object.freeze(['message', 'callback_query']) as readonly string[],
    TELEGRAM_UPDATE_MODE: 'long_poll',
    WEBHOOK_BASE_URL: '',
    WEBHOOK_PORT: 8443,
    WEBHOOK_SECRET_TOKEN: '',
    ENABLE_PASSWORD_PROTECTION: true,
    ENABLE_FILE_EXPIRY: true,
    ENABLE_REPORTS: true,
    ENABLE_CHILD_BOTS: true,
    ENABLE_ADMIN_BROADCAST: true,
    HEALTH_SERVER_ENABLED: false,
    HEALTH_SERVER_HOST: '127.0.0.1',
    HEALTH_SERVER_PORT: 0,
    ENABLE_MINI_APP: false,
    MINI_APP_URL: '',
    MINI_APP_API_BASE_URL: '',
    MINI_APP_ALLOWED_ORIGINS: Object.freeze([]) as readonly string[],
    MINI_APP_INITDATA_MAX_AGE_SECONDS: 86400,
    ENABLE_COLLECTIONS: true,
    COLLECTION_PAGE_SIZE: 10,
    COLLECTION_DRAFT_TTL_MINUTES: 60,
    COLLECTION_SEND_DELAY_MS: 700,
    MAX_COLLECTION_ITEMS: 100,
    MAX_BULK_SEND_ITEMS: 50,
    TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC: 30,
    TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC: 1,
    TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN: 20,
    TELEGRAM_MEDIA_GROUP_MAX_ITEMS: 10,
    TELEGRAM_MESSAGE_MAX_LENGTH: 4096,
    TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS: 100,
    TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH: 8,
    TELEGRAM_CALLBACK_DATA_MAX_BYTES: 64,
    TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: 50,
    TELEGRAM_AUTORETRY_MAX_ATTEMPTS: 5,
    TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS: 60,
    RUNNER_CONCURRENCY: 200,
    CHILD_BOT_MAX_PARALLEL_STARTS: 16,
    BROADCAST_DELAY_MS: 50,
    // Wave 9 — credit-system static defaults. Tests that exercise the
    // credit flow flip `ENABLE_CREDITS` via the overrides param.
    ENABLE_CREDITS: false,
    CREDITS_SIGNUP_BONUS: 10,
    CREDITS_COST_DECODE: 1,
    CREDITS_COST_COLLECTION_OPEN: 1,
    CREDITS_COST_COLLECTION_SEND: 1,
    CREDITS_REFERRAL_ENABLED: true,
    CREDITS_REFERRAL_REWARD: 1,
    CREDITS_REFERRAL_DAILY_CAP: 200,
    CREDITS_REFERRAL_PAIR_LIFETIME_CAP: 5,
    CREDITS_REFERRAL_PAIR_WINDOW_MINUTES: 15,
    CREDITS_REFERRAL_PAIR_WINDOW_MAX: 2,
    CREDITS_REFERRAL_REDEEMER_MIN_AGE_MINUTES: 0,
    CREDITS_TOPUP_ENABLED: false,
    CREDITS_BYPASS_FOR_OWNER: true,
    CREDITS_BYPASS_FOR_ADMIN: true,
    ENABLE_CRYPTO_TOPUP: false,
    CRYPTO_INVOICE_TTL_MINUTES: 60,
    CRYPTO_POLL_INTERVAL_SECONDS: 15,
    CRYPTO_AMOUNT_TOLERANCE_BPS: 0,
    CRYPTO_TRON_RPC_URL: '',
    CRYPTO_BSC_RPC_URL: '',
    CRYPTO_ETH_RPC_URL: '',
    CRYPTO_TON_RPC_URL: '',
    CRYPTO_TRON_USDT_CONFIRMATIONS: 1,
    CRYPTO_TRON_USDT_RATE: 100,
    CRYPTO_TRON_USDC_CONFIRMATIONS: 1,
    CRYPTO_TRON_USDC_RATE: 100,
    CRYPTO_BSC_USDT_CONFIRMATIONS: 15,
    CRYPTO_BSC_USDT_RATE: 100,
    CRYPTO_BSC_USDC_CONFIRMATIONS: 15,
    CRYPTO_BSC_USDC_RATE: 100,
    CRYPTO_ETH_USDT_CONFIRMATIONS: 12,
    CRYPTO_ETH_USDT_RATE: 100,
    CRYPTO_ETH_USDC_CONFIRMATIONS: 12,
    CRYPTO_ETH_USDC_RATE: 100,
    CRYPTO_TON_NATIVE_CONFIRMATIONS: 1,
    CRYPTO_TON_NATIVE_RATE: 30,
    CRYPTO_TON_USDT_CONFIRMATIONS: 1,
    CRYPTO_TON_USDT_RATE: 100,
    CRYPTO_TON_USDC_CONFIRMATIONS: 1,
    CRYPTO_TON_USDC_RATE: 100,
    CRYPTO_MAX_ACTIVE_INVOICES_PER_USER: 3,
    CRYPTO_INVOICE_RATELIMIT_PER_MIN: 5,
    CRYPTO_DUST_THRESHOLD_USD: 0,
    // Wave 9.2 — Stars refund defense. Defaults sized for tests: 60 s/Star
    // makes a 10-Star refund result in a 600 s lock — easy to exercise
    // without sleeping for hours.
    STARS_REFUND_LOCK_SECONDS_PER_STAR: 60,
    STARS_REFUND_LOCK_MAX_SECONDS: 30 * 24 * 3600,
    STARS_REFUND_HARD_BAN_THRESHOLD: 3,
    STARS_REFUND_HARD_BAN_WINDOW_DAYS: 30,
    MINI_APP_STARS_INVOICE_RATELIMIT_PER_MIN: 5,
  } as Config;
  return cfg;
}

/**
 * Open an in-memory DB, apply production PRAGMAs, run `001_init.sql`, and
 * return the wired-up repositories together with a typed config stub.
 *
 * `overrides` is shallow-merged on top of the defaults so individual tests
 * can flip a single feature flag or numeric tunable without rebuilding the
 * entire config object.
 */
export function buildTestEnv(overrides?: Partial<Config>): TestEnv {
  const db = new Database(':memory:');
  // `journal_mode = WAL` on `:memory:` silently maps to MEMORY internally —
  // setting it keeps parity with production and avoids surprising semantics.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(here, '../../src/db/migrations');
  // Apply every migration found on disk in lexicographic order so tests get
  // the same schema the runtime migration runner produces.
  const migrationFiles = [
    '001_init.sql',
    '002_collections.sql',
    '003_broadcasts.sql',
    '004_credits.sql',
    '005_crypto_invoices.sql',
    '006_crypto_payment_uri.sql',
    '007_topup_dedupe_index.sql',
    '008_stars_refunds.sql',
    '009_reports_polymorphic.sql',
    '010_reports_categories.sql',
  ];
  for (const name of migrationFiles) {
    const sql = readFileSync(path.resolve(migrationsDir, name), 'utf8');
    db.exec(sql);
  }

  const repos: TestRepos = {
    users: new UserRepository(db),
    files: new FileRepository(db),
    bots: new BotRepository(db),
    permissions: new PermissionRepository(db),
    reports: new ReportRepository(db),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
    rateLimit: new RateLimitRepository(db),
    collections: new CollectionRepository(db),
    collectionDrafts: new CollectionDraftRepository(db),
    broadcasts: new BroadcastRepository(db),
    credits: new CreditRepository(db),
    cryptoInvoices: new CryptoInvoiceRepository(db),
  };

  const config = Object.freeze({ ...defaultConfig(), ...(overrides ?? {}) }) as Config;

  return {
    db,
    repos,
    config,
    close: () => {
      db.close();
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Seeding helpers
 * -------------------------------------------------------------------------- */

let userSeq = 0;
let botSeq = 0;

/** Insert a fresh user row and return it. Each call generates a unique row. */
export function seedUser(
  repos: TestRepos,
  telegramUserId: string,
  role: UserRole = 'user',
  isBanned = false,
): UserRow {
  userSeq += 1;
  const inserted = repos.users.insert({
    telegram_user_id: telegramUserId,
    username: `user_${userSeq}`,
    first_name: 'Test',
    last_name: `User${userSeq}`,
    locale: 'en',
    role,
  });
  if (isBanned) {
    return repos.users.setBanned(inserted.id, true);
  }
  return inserted;
}

/**
 * Insert a managed bot owned by `ownerUserId` in `mode`. Telegram-shaped
 * fields (`telegram_bot_id`, `username`) are synthesized to be unique per
 * call so a single in-memory DB can host an arbitrary number of bots
 * without unique-constraint collisions.
 */
export function seedBot(
  repos: TestRepos,
  ownerUserId: number,
  mode: BotMode,
  opts?: { username?: string },
): ManagedBotRow {
  botSeq += 1;
  const username = opts?.username ?? `vaultbot_${botSeq}bot`;
  const telegramBotId = `${100000 + botSeq}`;
  const zero = Buffer.alloc(16, 0).toString('base64');
  return repos.bots.insert({
    owner_user_id: ownerUserId,
    telegram_bot_id: telegramBotId,
    username,
    display_name: 'Test Bot',
    encrypted_token: zero,
    token_nonce: zero,
    token_auth_tag: zero,
    mode,
  });
}
