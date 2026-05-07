/**
 * VaultLink Bot — typed grammY context flavor.
 *
 * Every middleware and router talks to this widened {@link AppContext}, which
 * carries the resolved local user row, the parent managed-bot record, the
 * effective locale + bound `t()` helper, plus pre-wired service and repository
 * collections so handlers never reach into module-level singletons. Middleware
 * runs before routers and is responsible for populating these fields; the
 * properties are typed as required even though they are attached at runtime so
 * that handler bodies can use them without redundant non-null assertions.
 */

import type { Context } from 'grammy';
import type { Config } from '../config/env.js';
import type { Locale, ManagedBotRow, UserRow } from '../types/index.js';
import type { FileService } from '../services/file.service.js';
import type { BotService } from '../services/bot.service.js';
import type { ReportService } from '../services/report.service.js';
import type { PermissionService } from '../services/permission.service.js';
import type { UserService } from '../services/user.service.js';
import type { RateLimitService } from '../services/rateLimit.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { AuditService } from '../services/audit.service.js';
import type { ShareService } from '../services/share.service.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { BotRepository } from '../repositories/bot.repository.js';
import type { PermissionRepository } from '../repositories/permission.repository.js';
import type { ReportRepository } from '../repositories/report.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { SettingsRepository } from '../repositories/settings.repository.js';
import type { RateLimitRepository } from '../repositories/rateLimit.repository.js';
import type { CollectionRepository } from '../repositories/collection.repository.js';
import type { CollectionDraftRepository } from '../repositories/collectionDraft.repository.js';
import type { BroadcastRepository } from '../repositories/broadcast.repository.js';
import type { BroadcastService } from '../services/broadcast.service.js';
import type { CreditRepository } from '../repositories/credit.repository.js';
import type { CreditService } from '../services/credit.service.js';
import type { CryptoInvoiceRepository } from '../repositories/cryptoInvoice.repository.js';
import type { CryptoTopupService } from '../services/crypto/cryptoTopup.service.js';
import type { PaymentsService } from '../services/payments.service.js';

/** Domain services available to every handler. */
export interface AppServices {
  file: FileService;
  bot: BotService;
  report: ReportService;
  permission: PermissionService;
  user: UserService;
  rateLimit: RateLimitService;
  settings: SettingsService;
  audit: AuditService;
  /** Wave 7 — unified shares (single files + collections). */
  share: ShareService;
  /** Wave 8 — announcement broadcasts. */
  broadcast: BroadcastService;
  /** Wave 9 — dynamic credit system (charge/refund/referral/topup). */
  credits: CreditService;
  /** Wave 9.1 — self-custodial crypto top-up. */
  crypto: CryptoTopupService;
  /** Wave 9.2 — Stars invoice link + admin Stars refund. */
  payments: PaymentsService;
}

/** Repositories available to every handler. */
export interface AppRepos {
  users: UserRepository;
  files: FileRepository;
  bots: BotRepository;
  permissions: PermissionRepository;
  reports: ReportRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
  rateLimit: RateLimitRepository;
  /** Wave 7 — collections + drafts. */
  collections: CollectionRepository;
  collectionDrafts: CollectionDraftRepository;
  /** Wave 8 — broadcasts + per-recipient delivery rows. */
  broadcasts: BroadcastRepository;
  /** Wave 9 — credit ledger. */
  credits: CreditRepository;
  /** Wave 9.1 — crypto invoices. */
  cryptoInvoices: CryptoInvoiceRepository;
}

/**
 * Custom properties attached to every {@link AppContext}.
 *
 * `user` and `bot` are guaranteed populated by the `attachUser` middleware
 * before any router sees the context. They are typed required to keep handler
 * bodies clean; the middleware short-circuits anything that would violate that
 * invariant (anonymous updates, banned users) before downstream code runs.
 */
export interface AppContextProps {
  /** Local users row resolved for `ctx.from`. Attached by `attachUserMiddleware`. */
  user: UserRow;
  /** The managed-bot record this update belongs to. Attached by `createBot`. */
  bot: ManagedBotRow;
  /** Effective locale: user preference if supported, else `config.DEFAULT_LOCALE`. */
  locale: Locale;
  /** Bound translation helper for the current locale. */
  t: (key: string, params?: Record<string, string | number>) => string;
  services: AppServices;
  repos: AppRepos;
  config: Config;
}

/** Public, fully-flavored grammY context type. */
export type AppContext = Context & AppContextProps;

/**
 * Resolve the effective locale for a user row. Falls back to the configured
 * default when the stored value is missing or unsupported.
 */
export function resolveUserLocale(user: UserRow, fallback: Locale): Locale {
  const stored = user.locale;
  if (stored === 'th' || stored === 'en') return stored;
  return fallback;
}
