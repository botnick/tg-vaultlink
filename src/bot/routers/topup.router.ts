/**
 * Telegram Stars topup — payment plumbing.
 *
 * Three handlers:
 *
 *   1. `pre_checkout_query` — Telegram asks "is this invoice still valid?"
 *      We re-validate the payload (`credits:<stars>:<credits>:<userId>`),
 *      bail with `ok=false` on tamper, otherwise approve. The payload format
 *      is identical for invoices created via `bot.api.sendInvoice` (the
 *      original chat-side flow) and `bot.api.createInvoiceLink` (the new
 *      Mini App `openInvoice` flow), so this single validator covers both.
 *
 *   2. `message:successful_payment` — the user paid. We credit the user via
 *      `CreditService.applyTopup()`. Wave 9.2 added a UNIQUE index on
 *      (reason='topup', reference_id) so a duplicate `applyTopup` for the
 *      same `telegram_payment_charge_id` raises a constraint violation
 *      that we log + drop, instead of silently double-crediting.
 *
 *   3. `message:refunded_payment` (Wave 9.2) — Telegram approved a refund
 *      (or admin called `bot.api.refundStarPayment`). We hand off to
 *      `CreditService.refundTopup()` which atomically reverses the original
 *      ledger row, sets a proportional spend-lock, bumps refund counters,
 *      and (if the threshold trips) flips `is_banned`. The user receives a
 *      friendly explanation message with the unlock ETA.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { getLogger } from '../../logger/logger.js';

interface ParsedPayload {
  stars: number;
  credits: number;
  userId: number;
}

function parsePayload(raw: string | undefined): ParsedPayload | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'credits') return null;
  const stars = Number.parseInt(parts[1] ?? '', 10);
  const credits = Number.parseInt(parts[2] ?? '', 10);
  const userId = Number.parseInt(parts[3] ?? '', 10);
  if (
    !Number.isInteger(stars) ||
    !Number.isInteger(credits) ||
    !Number.isInteger(userId) ||
    stars < 1 ||
    credits < 1 ||
    userId < 1
  ) {
    return null;
  }
  return { stars, credits, userId };
}

export function registerTopupRouter(composer: Composer<AppContext>): void {
  // ─────────────────────────────────────── pre_checkout_query ───
  composer.on('pre_checkout_query', async (ctx) => {
    const log = getLogger();
    const q = ctx.preCheckoutQuery;

    // Master kill switch — if topup got disabled mid-flow, refuse the payment.
    if (!ctx.services.credits.isEnabled() || !ctx.services.credits.isTopupEnabled()) {
      try {
        await ctx.answerPreCheckoutQuery(false, ctx.t('credits.topup.disabled'));
      } catch (err) {
        log.warn({ err }, 'failed to answerPreCheckoutQuery (disabled)');
      }
      return;
    }

    const parsed = parsePayload(q.invoice_payload);
    if (!parsed) {
      try {
        await ctx.answerPreCheckoutQuery(false, ctx.t('credits.topup.invalid_payload'));
      } catch (err) {
        log.warn({ err }, 'failed to answerPreCheckoutQuery (invalid payload)');
      }
      return;
    }

    // Cross-check: total_amount must match the payload's `stars`. Telegram
    // controls the total_amount based on the invoice we sent, so a mismatch
    // here means someone tampered with the payload.
    if (q.total_amount !== parsed.stars || q.currency !== 'XTR') {
      try {
        await ctx.answerPreCheckoutQuery(false, ctx.t('credits.topup.invalid_payload'));
      } catch (err) {
        log.warn({ err }, 'failed to answerPreCheckoutQuery (mismatch)');
      }
      return;
    }

    // Verify the package still exists in the current settings — if an admin
    // removed the package between sendInvoice and pre_checkout_query, refuse.
    const packages = ctx.services.credits.topupPackages();
    const matched = packages.find(
      (p) => p.stars === parsed.stars && p.credits === parsed.credits,
    );
    if (!matched) {
      try {
        await ctx.answerPreCheckoutQuery(false, ctx.t('credits.topup.invalid_package'));
      } catch (err) {
        log.warn({ err }, 'failed to answerPreCheckoutQuery (package gone)');
      }
      return;
    }

    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      log.warn({ err }, 'failed to answerPreCheckoutQuery (ok)');
    }
  });

  // ─────────────────────────────────────── successful_payment ───
  composer.on('message:successful_payment', async (ctx) => {
    const log = getLogger();
    const sp = ctx.message.successful_payment;
    const parsed = parsePayload(sp.invoice_payload);
    if (!parsed) {
      log.warn({ payload: sp.invoice_payload }, 'successful_payment with unparseable payload');
      return;
    }

    // The payload's userId pin is informational — we always credit the
    // current sender (which Telegram authenticated). They should match
    // because the invoice was sent to that exact chat, but log the
    // mismatch defensively.
    if (parsed.userId !== ctx.user.id) {
      log.warn(
        { payloadUserId: parsed.userId, ctxUserId: ctx.user.id },
        'successful_payment user mismatch — crediting current sender',
      );
    }

    try {
      const result = ctx.services.credits.applyTopup({
        userId: ctx.user.id,
        credits: parsed.credits,
        stars: parsed.stars,
        paymentChargeId: sp.telegram_payment_charge_id,
      });
      await ctx.reply(
        ctx.t('credits.topup.success', {
          credits: parsed.credits,
          balance: result.balanceAfter,
        }),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      // The DB-level UNIQUE index on (reason='topup', reference_id) means
      // a duplicate Stars top-up will throw an SQLITE_CONSTRAINT here. That's
      // the expected behavior — log it once at warn-level and drop the
      // attempt rather than answering the user (they already saw the success
      // message on the first delivery).
      const message = (err as { message?: string }).message ?? '';
      const isDuplicate = message.includes('UNIQUE') || message.includes('constraint');
      if (isDuplicate) {
        log.warn(
          {
            paymentChargeId: sp.telegram_payment_charge_id,
            payload: sp.invoice_payload,
          },
          'duplicate successful_payment ignored (UNIQUE topup constraint)',
        );
        return;
      }
      log.error({ err, payload: sp.invoice_payload }, 'failed to apply topup');
      await ctx.reply(ctx.t('credits.topup.apply_failed'));
    }
  });

  // ───────────────────────────────────── refunded_payment (Wave 9.2) ───
  composer.on('message:refunded_payment', async (ctx) => {
    const log = getLogger();
    // Bot API 7.4+: `refunded_payment` is delivered as a service message in
    // the chat where the original payment landed. The shape mirrors
    // `successful_payment` enough that we can pull the charge id off the
    // same field. Cast through `unknown` because grammY's typings may not
    // yet declare the union member depending on the version installed —
    // the Bot API contract guarantees the field is present.
    const rp = (ctx.message as unknown as {
      refunded_payment?: {
        telegram_payment_charge_id?: string;
        provider_payment_charge_id?: string;
        invoice_payload?: string;
        currency?: string;
        total_amount?: number;
      };
    }).refunded_payment;
    if (!rp || typeof rp.telegram_payment_charge_id !== 'string') {
      log.warn(
        { update: ctx.update.update_id },
        'refunded_payment message missing telegram_payment_charge_id',
      );
      return;
    }

    try {
      const result = ctx.services.credits.refundTopup({
        paymentChargeId: rp.telegram_payment_charge_id,
        source: 'telegram',
      });
      // Reply tailored to outcome. Honest users (refund before any spending)
      // see a neutral "we received the refund" message; abusers in debt
      // get a heads-up about the lock + (when applicable) the hard ban.
      if (!result.applied) {
        if (result.reason === 'no_topup') {
          // Refund without a matching topup — could be an out-of-band test
          // refund or a refund of a Stars purchase outside our system.
          // We log it but don't surface to the user.
          log.warn(
            { paymentChargeId: rp.telegram_payment_charge_id },
            'refunded_payment without matching topup ledger',
          );
          return;
        }
        // already_refunded — single retry from Telegram.
        return;
      }
      const messageKey = result.hardBanned
        ? 'credits.refund.received_hard_banned'
        : result.spendLockedUntil
          ? 'credits.refund.received_locked'
          : 'credits.refund.received';
      await ctx.reply(
        ctx.t(messageKey, {
          credits: result.credits,
          stars: result.stars,
          balance: result.balanceAfter,
          unlock: result.spendLockedUntil ?? '',
        }),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      log.error(
        { err, paymentChargeId: rp.telegram_payment_charge_id },
        'failed to apply refund clawback',
      );
    }
  });
}
