/**
 * User-facing credit router.
 *
 * Handles every `credit:*` callback emitted by the user-side panels:
 *
 *   - `credit:balance`        — show balance + history shortcut
 *   - `credit:history`        — last N ledger rows
 *   - `credit:share_my_codes` — list user's recent codes for sharing
 *   - `credit:topup`          — open the package picker (no-op if disabled)
 *   - `credit:topup:pkg:<i>`  — send a Stars invoice for package i
 *
 * The admin-facing flows live in `admin_credits.router.ts`. The actual
 * `pre_checkout_query` and `successful_payment` handlers live in
 * `topup.router.ts` so payment plumbing stays separate from UI.
 *
 * Every panel re-checks `creditService.isEnabled()` so flipping the
 * master switch off makes the UI disappear immediately on next render.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { escapeHtml } from '../../utils/safeText.js';
import type { CreditTransactionRow } from '../../types/index.js';

const HISTORY_PAGE = 10;

/**
 * Build the main credits panel body. Used by both the inline button entry
 * and the `/settings → 💳 Credits` deep-link.
 */
function renderBalancePanel(ctx: AppContext): { text: string; keyboard: InlineKeyboard } {
  const credits = ctx.services.credits;
  const balance = credits.getBalance(ctx.user.id);
  const totals = credits.getLifetimeTotals(ctx.user.id);

  const lines: string[] = [];
  lines.push(ctx.t('credits.panel.title'));
  lines.push('');
  lines.push(ctx.t('credits.panel.balance', { balance }));
  lines.push(
    ctx.t('credits.panel.lifetime', { gained: totals.gained, spent: totals.spent }),
  );

  const kb = new InlineKeyboard();
  let added = false;
  if (credits.isTopupEnabled()) {
    kb.text(ctx.t('credits.button.topup'), 'credit:topup');
    added = true;
  }
  if (credits.isReferralEnabled() && credits.referralRewardAmount() > 0) {
    if (added) kb.row();
    kb.text(ctx.t('credits.button.share_my_codes'), 'credit:share_my_codes');
    added = true;
  }
  if (added) kb.row();
  kb.text(ctx.t('credits.button.history'), 'credit:history');

  return { text: lines.join('\n'), keyboard: kb };
}

function renderHistory(ctx: AppContext, rows: CreditTransactionRow[]): string {
  if (rows.length === 0) {
    return `${ctx.t('credits.history.title')}\n\n${ctx.t('credits.history.empty')}`;
  }
  const out: string[] = [ctx.t('credits.history.title'), ''];
  for (const r of rows) {
    const sign = r.delta >= 0 ? '+' : '−';
    const absDelta = Math.abs(r.delta);
    const date = r.created_at.replace('T', ' ').slice(0, 16);
    const reason = ctx.t(`credits.history.reason.${r.reason}`);
    out.push(
      ctx.t('credits.history.row', {
        date,
        sign,
        amount: absDelta,
        reason,
        balance: r.balance_after,
      }),
    );
  }
  return out.join('\n');
}

/** Send the panel as a fresh reply. */
export async function sendCreditsPanel(ctx: AppContext): Promise<void> {
  if (!ctx.services.credits.isEnabled()) {
    await ctx.reply(ctx.t('credits.disabled_notice'));
    return;
  }
  const { text, keyboard } = renderBalancePanel(ctx);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export function registerCreditsRouter(composer: Composer<AppContext>): void {
  // ─────────────────────────────────── direct slash-command entry ────
  // `/credits` is the canonical form (matches the Telegram-menu entry);
  // `/credit` is a singular alias for users who type the shorter form.
  // Both go to the same panel — when the system is disabled the panel
  // itself shows a friendly notice rather than a 404.
  composer.command('credits', async (ctx) => {
    await sendCreditsPanel(ctx);
  });
  composer.command('credit', async (ctx) => {
    await sendCreditsPanel(ctx);
  });

  // ──────────────────────────────────────────── balance / panel entry ─
  composer.callbackQuery('credit:balance', async (ctx) => {
    if (!ctx.services.credits.isEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.disabled_notice') });
      return;
    }
    await ctx.answerCallbackQuery();
    const { text, keyboard } = renderBalancePanel(ctx);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });

  // ──────────────────────────────────────────────────────── history ─
  composer.callbackQuery('credit:history', async (ctx) => {
    if (!ctx.services.credits.isEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.disabled_notice') });
      return;
    }
    await ctx.answerCallbackQuery();
    const rows = ctx.services.credits.getRecentHistory(ctx.user.id, HISTORY_PAGE);
    const text = renderHistory(ctx, rows);
    const kb = new InlineKeyboard().text(ctx.t('credits.button.back'), 'credit:balance');
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ──────────────────────────────────────────── share my codes (lite) ─
  // Fully populating "share my codes" with a multi-page picker is out of
  // scope for v0.4.0; the v1 of this button shows the user's most recent
  // share code with a copyable referral message. Power users can run
  // `/files` for the full list.
  composer.callbackQuery('credit:share_my_codes', async (ctx) => {
    if (!ctx.services.credits.isEnabled() || !ctx.services.credits.isReferralEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.disabled_notice') });
      return;
    }
    await ctx.answerCallbackQuery();
    const reward = ctx.services.credits.referralRewardAmount();
    const text = ctx.t('credits.share.intro', { reward });
    const kb = new InlineKeyboard()
      .text(ctx.t('credits.button.open_files'), 'menu:files')
      .row()
      .text(ctx.t('credits.button.back'), 'credit:balance');
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ──────────────────────────────────────────── topup package picker ─
  composer.callbackQuery('credit:topup', async (ctx) => {
    if (!ctx.services.credits.isEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.disabled_notice') });
      return;
    }
    if (!ctx.services.credits.isTopupEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.topup.disabled') });
      return;
    }
    await ctx.answerCallbackQuery();
    const packages = ctx.services.credits.topupPackages();
    const kb = new InlineKeyboard();
    for (let i = 0; i < packages.length; i++) {
      const p = packages[i];
      if (!p) continue;
      kb.text(
        ctx.t('credits.topup.package_label', { credits: p.credits, stars: p.stars }),
        `credit:topup:pkg:${i}`,
      ).row();
    }
    // Wave 9.1 — surface the Crypto path when the operator has it on.
    if (ctx.services.crypto.isEnabled() && ctx.services.crypto.listEnabledChains().length > 0) {
      kb.text(ctx.t('credits.crypto.button.entry'), 'credit:crypto').row();
    }
    kb.text(ctx.t('credits.button.back'), 'credit:balance');

    const text = ctx.t('credits.topup.choose_package');
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ─────────────────────────────────────── topup invoice — package N ─
  composer.callbackQuery(/^credit:topup:pkg:(\d+)$/, async (ctx) => {
    if (!ctx.services.credits.isEnabled() || !ctx.services.credits.isTopupEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.topup.disabled') });
      return;
    }
    const idx = Number.parseInt(ctx.match?.[1] ?? '-1', 10);
    const packages = ctx.services.credits.topupPackages();
    const pkg = packages[idx];
    if (!pkg) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.topup.invalid_package') });
      return;
    }
    await ctx.answerCallbackQuery();

    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Stars invoice: currency='XTR', no provider_token, single price line.
    // Payload encodes the package details so the successful_payment
    // handler can apply the right credit amount even if the package list
    // changes mid-flow (we trust the payload because it's authenticated
    // by Telegram's payment system).
    const payload = `credits:${pkg.stars}:${pkg.credits}:${ctx.user.id}`;
    try {
      await ctx.api.sendInvoice(
        chatId,
        ctx.t('credits.topup.invoice_title'),
        ctx.t('credits.topup.invoice_description', {
          credits: pkg.credits,
          stars: pkg.stars,
        }),
        payload,
        'XTR',
        [
          {
            label: ctx.t('credits.topup.package_label', {
              credits: pkg.credits,
              stars: pkg.stars,
            }),
            amount: pkg.stars,
          },
        ],
        { provider_token: '' },
      );
    } catch (err) {
      await ctx.reply(
        ctx.t('credits.topup.invoice_failed', {
          reason: escapeHtml(String((err as Error)?.message ?? err)),
        }),
        { parse_mode: 'HTML' },
      );
    }
  });
}
