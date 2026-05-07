/**
 * Payments service — Mini-App-side wrapper around the bot's Telegram Stars
 * payment API surface. Created after the main bot is bootstrapped (it needs
 * the live `bot.api` reference) and exposed through {@link AppServices} so
 * the Mini App routes can hand off to it without ever touching grammY
 * directly.
 *
 * Two responsibilities:
 *
 *   1. {@link createStarsInvoiceLink} — given a package index, build the
 *      same `credits:<stars>:<credits>:<userId>` payload the bot's
 *      `sendInvoice` flow uses today and call `bot.api.createInvoiceLink`
 *      so the Mini App can hand it to `Telegram.WebApp.openInvoice()`.
 *      The payload format is intentionally identical so a single
 *      `pre_checkout_query` validator covers both entry points.
 *
 *   2. {@link refundStarPayment} — admin-initiated refund. Calls Telegram's
 *      `refundStarPayment` API; Telegram then delivers a service message
 *      `refunded_payment` which the topup router's handler consumes to
 *      perform the actual ledger reversal. Single code path — the Mini App
 *      route does NOT touch the credit ledger directly.
 *
 * Per-user rate limit on the invoice-link path defends against a hostile
 * client spamming Telegram for invoice creations; the bot's global API
 * quota stays intact.
 */

import type { Api } from 'grammy';
import type { Config } from '../config/env.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { AuditService } from './audit.service.js';
import type { CreditService } from './credit.service.js';
import type { RateLimitRepository } from '../repositories/rateLimit.repository.js';

export interface PaymentsServiceDeps {
  /** Live `bot.api` from the bootstrapped main bot. */
  botApi: Api;
  config: Config;
  credits: CreditService;
  audit: AuditService;
  rateLimitRepo: RateLimitRepository;
}

export interface CreateStarsInvoiceLinkInput {
  /** Local user id (from initData-verified `c.var.user.id`). */
  userId: number;
  /** Index into `creditService.topupPackages()`. */
  packageIndex: number;
  /** Localized title (the same string the bot's `/credits` flow uses). */
  title: string;
  /** Localized description. */
  description: string;
  /** Localized line-item label. */
  lineLabel: string;
}

export interface CreateStarsInvoiceLinkResult {
  invoiceLink: string;
  stars: number;
  credits: number;
  packageIndex: number;
}

export interface RefundStarPaymentInput {
  /** Telegram numeric user id of the purchaser, as a string. */
  telegramUserId: string;
  /** The original `successful_payment.telegram_payment_charge_id`. */
  paymentChargeId: string;
  /** Admin's local user id, for audit. */
  actorUserId: number;
  /** Free-form note recorded in audit metadata. */
  note?: string;
}

export class PaymentsService {
  private readonly botApi: Api;
  private readonly config: Config;
  private readonly credits: CreditService;
  private readonly audit: AuditService;
  private readonly rateLimitRepo: RateLimitRepository;

  constructor(deps: PaymentsServiceDeps) {
    this.botApi = deps.botApi;
    this.config = deps.config;
    this.credits = deps.credits;
    this.audit = deps.audit;
    this.rateLimitRepo = deps.rateLimitRepo;
  }

  /**
   * Create a Telegram Stars invoice link the Mini App can pass to
   * `Telegram.WebApp.openInvoice()`. Validates the package server-side
   * (never trusts client-supplied stars/credits values) and reuses the
   * same payload format the bot's `sendInvoice` flow uses, so the
   * `pre_checkout_query` validator is a single code path.
   */
  async createStarsInvoiceLink(
    input: CreateStarsInvoiceLinkInput,
  ): Promise<CreateStarsInvoiceLinkResult> {
    if (!this.credits.isEnabled() || !this.credits.isTopupEnabled()) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'topup is disabled', { expose: true });
    }

    // Per-user rate limit so a hostile client can't spam createInvoiceLink.
    // Burning the bot's global API quota would degrade real users. We bypass
    // the typed RateLimitService (which is scope-enum'd to upload/download/
    // add_bot/report) and talk to the repo directly with a one-minute
    // sliding window keyed by local user id.
    const limit = this.config.MINI_APP_STARS_INVOICE_RATELIMIT_PER_MIN;
    const { row } = this.rateLimitRepo.hit(
      'mini_app_stars_invoice',
      String(input.userId),
      60_000,
    );
    if (row.count > limit) {
      const windowStartMs = Date.parse(row.window_start);
      const retryAt = Number.isFinite(windowStartMs) ? windowStartMs + 60_000 : Date.now() + 60_000;
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        `too many invoice requests (limit ${limit}/min)`,
        { expose: true, meta: { retryAtMs: retryAt } },
      );
    }

    const packages = this.credits.topupPackages();
    const pkg = packages[input.packageIndex];
    if (!pkg) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid package index', { expose: true });
    }

    // Same payload format as src/bot/routers/credits.router.ts so the
    // pre_checkout_query handler in topup.router.ts validates both flows
    // identically. Telegram echoes it back authenticated.
    const payload = `credits:${pkg.stars}:${pkg.credits}:${input.userId}`;

    let invoiceLink: string;
    try {
      invoiceLink = await this.botApi.createInvoiceLink(
        input.title,
        input.description,
        payload,
        '', // provider_token is empty for Stars (XTR)
        'XTR',
        [{ label: input.lineLabel, amount: pkg.stars }],
      );
    } catch (err) {
      this.audit.log('credits.stars_invoice_link_failed', {
        actorUserId: input.userId,
        targetType: 'user',
        targetId: String(input.userId),
        metadata: {
          packageIndex: input.packageIndex,
          stars: pkg.stars,
          credits: pkg.credits,
          error: String((err as Error)?.message ?? err),
        },
      });
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'failed to create invoice link',
        {
          expose: true,
          cause: err,
          meta: { packageIndex: input.packageIndex },
        },
      );
    }

    this.audit.log('credits.stars_invoice_link_created', {
      actorUserId: input.userId,
      targetType: 'user',
      targetId: String(input.userId),
      metadata: {
        packageIndex: input.packageIndex,
        stars: pkg.stars,
        credits: pkg.credits,
      },
    });

    return {
      invoiceLink,
      stars: pkg.stars,
      credits: pkg.credits,
      packageIndex: input.packageIndex,
    };
  }

  /**
   * Admin-triggered Stars refund. Telegram performs the refund and then
   * delivers a `refunded_payment` service message that the bot's topup
   * router converts into a ledger reversal — so this method does NOT
   * touch the ledger itself; it only kicks the API call.
   *
   * Returns a success flag; the actual ledger update lands a moment later
   * via the service message. The Mini App polls or refetches summary to
   * see the new balance.
   */
  async refundStarPayment(input: RefundStarPaymentInput): Promise<{ requested: true }> {
    const tgUserId = Number.parseInt(input.telegramUserId, 10);
    if (!Number.isFinite(tgUserId) || tgUserId <= 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid telegram_user_id', { expose: true });
    }
    try {
      await this.botApi.refundStarPayment(tgUserId, input.paymentChargeId);
    } catch (err) {
      this.audit.log('credits.stars_refund_request_failed', {
        actorUserId: input.actorUserId,
        targetType: 'payment',
        targetId: input.paymentChargeId,
        metadata: {
          telegramUserId: input.telegramUserId,
          error: String((err as Error)?.message ?? err),
          note: input.note ?? null,
        },
      });
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Telegram refused the refund',
        {
          expose: true,
          cause: err,
          meta: { paymentChargeId: input.paymentChargeId },
        },
      );
    }
    this.audit.log('credits.stars_refund_requested', {
      actorUserId: input.actorUserId,
      targetType: 'payment',
      targetId: input.paymentChargeId,
      metadata: {
        telegramUserId: input.telegramUserId,
        note: input.note ?? null,
      },
    });
    return { requested: true };
  }
}
