/**
 * Shared charge/refund helper for redemption routers.
 *
 * The credit deduction lives in the routers (not in `FileService.decode`)
 * so the service layer stays reusable for admin tools and tests that
 * shouldn't pay. Three call sites use this helper today:
 *
 *   - start.router    — deep-link redemption (single-file + collection page-1)
 *   - decode.router   — pasted `botname:CODE` lines (single-file + collection page-1)
 *   - collection.router — `coll:send_remaining` bulk delivery
 *
 * Pattern at every call site:
 *
 *     const charge = await chargeRedemption(ctx, { ... });
 *     if (!charge) return;        // user-friendly error already replied
 *     try {
 *       await deliver(...);
 *       ctx.services.credits.rewardReferral({...});
 *     } catch (err) {
 *       ctx.services.credits.refund(charge, String(err));
 *       throw err;
 *     }
 *
 * The "refund on failure" wrapper is critical: if Telegram throws when
 * sending the file the user shouldn't lose credits.
 */

import { InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import type { ChargeKind, ChargeReceipt } from '../../services/credit.service.js';
import type { FileType } from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

export interface ChargeRedemptionInput {
  kind: ChargeKind;
  referenceType: 'file' | 'collection';
  referenceId: number;
  /** When known, lets owner-bypass take effect. */
  ownerUserId?: number | null;
  /** When `kind === 'decode'`, used for the per-type cost override. */
  fileType?: FileType;
  /** When `kind === 'collection_send'`, used for the per-item surcharge. */
  itemCount?: number;
  /**
   * Suppress the friendly reply on insufficient credits. Used by the
   * batch path in decode.router (one summary at the end) and the
   * `answerCallbackQuery` path in collection.router.
   */
  silent?: boolean;
}

/**
 * Build the inline keyboard offered with the insufficient-credits message.
 * Topup button only appears when topup is enabled at runtime.
 */
function insufficientKeyboard(ctx: AppContext): InlineKeyboard | undefined {
  const credits = ctx.services.credits;
  const kb = new InlineKeyboard();
  let any = false;
  if (credits.isTopupEnabled()) {
    kb.text(ctx.t('credits.button.topup'), 'credit:topup');
    any = true;
  }
  if (credits.isReferralEnabled() && credits.referralRewardAmount() > 0) {
    if (any) kb.row();
    kb.text(ctx.t('credits.button.share_my_codes'), 'credit:share_my_codes');
    any = true;
  }
  return any ? kb : undefined;
}

/**
 * Try to charge the user. On success returns the {@link ChargeReceipt}.
 * On insufficient credits replies (unless `silent`) and returns `null`.
 * Re-throws anything else.
 */
export async function chargeRedemption(
  ctx: AppContext,
  input: ChargeRedemptionInput,
): Promise<ChargeReceipt | null> {
  const isAdmin = ctx.services.permission.isAdmin(ctx.user);

  try {
    const req: Parameters<typeof ctx.services.credits.chargeForRedemption>[0] = {
      user: ctx.user,
      kind: input.kind,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      isAdmin,
    };
    if (input.ownerUserId !== undefined) req.ownerUserId = input.ownerUserId;
    if (input.fileType !== undefined) req.fileType = input.fileType;
    if (input.itemCount !== undefined) req.itemCount = input.itemCount;
    return ctx.services.credits.chargeForRedemption(req);
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_CREDITS) {
      if (!input.silent) {
        const meta = err.meta as { needed?: number; balance?: number } | undefined;
        const needed = meta?.needed ?? 1;
        const balance = meta?.balance ?? 0;
        const kb = insufficientKeyboard(ctx);
        await ctx.reply(ctx.t('credits.error.insufficient', { needed, balance }), {
          parse_mode: 'HTML',
          ...(kb ? { reply_markup: kb } : {}),
        });
      }
      return null;
    }
    throw err;
  }
}

/**
 * Convenience wrapper for the callback_query path: shorter "not enough
 * credits" toast + same keyboard sent as a reply. Use when answering a
 * callback_query.
 */
export async function chargeRedemptionForCallback(
  ctx: AppContext,
  input: ChargeRedemptionInput,
): Promise<ChargeReceipt | null> {
  const isAdmin = ctx.services.permission.isAdmin(ctx.user);
  try {
    const req: Parameters<typeof ctx.services.credits.chargeForRedemption>[0] = {
      user: ctx.user,
      kind: input.kind,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      isAdmin,
    };
    if (input.ownerUserId !== undefined) req.ownerUserId = input.ownerUserId;
    if (input.fileType !== undefined) req.fileType = input.fileType;
    if (input.itemCount !== undefined) req.itemCount = input.itemCount;
    return ctx.services.credits.chargeForRedemption(req);
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_CREDITS) {
      const meta = err.meta as { needed?: number; balance?: number } | undefined;
      const needed = meta?.needed ?? 1;
      const balance = meta?.balance ?? 0;
      try {
        await ctx.answerCallbackQuery({
          text: ctx.t('credits.error.insufficient_short', { needed, balance }),
          show_alert: true,
        });
      } catch {
        // best-effort
      }
      const kb = insufficientKeyboard(ctx);
      if (kb) {
        await ctx.reply(ctx.t('credits.error.insufficient', { needed, balance }), {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      }
      return null;
    }
    throw err;
  }
}
