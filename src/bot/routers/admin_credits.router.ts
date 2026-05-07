/**
 * Admin-side credit router.
 *
 * Two surfaces:
 *
 *   1. `/admin_credits` opens an inline panel showing every dynamic toggle
 *      and number setting, with one-tap buttons to flip booleans and
 *      hyperlinks to the matching `/admin_credit_set <key> <value>` command
 *      for numeric edits. We deliberately do NOT implement a multi-step
 *      "send the new value" prompt state machine — the Telegram-only UI
 *      memo prefers a single-screen flow, and an admin running these
 *      sparingly is happy typing the command form.
 *
 *   2. Founder-only commands for the actual mutations:
 *
 *        /admin_credit_set <key> <value>
 *        /admin_credit_clear <key>
 *        /admin_credit_grant <telegram_user_id> <amount> [note...]
 *        /admin_credit_revoke <telegram_user_id> <amount> [note...]
 *        /admin_credit_setbal <telegram_user_id> <new_balance> [note...]
 *        /admin_credit_packages_set <json>
 *        /admin_credit_packages_reset
 *        /admin_credit_stats
 *
 * Every action audit-logs through `CreditService` (settings_changed,
 * admin_adjust, admin_set, etc.) so the panel and stats accurately reflect
 * the current state.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { adminOnlyMiddleware } from '../middlewares/adminOnly.middleware.js';
import { founderOnlyMiddleware } from '../middlewares/founderOnly.middleware.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { CREDIT_SETTING_KEYS } from '../../services/credit.service.js';
import { escapeHtml } from '../../utils/safeText.js';
import type { CreditTopupPackage } from '../../types/index.js';

const numberKeys: readonly string[] = [
  CREDIT_SETTING_KEYS.signupBonus,
  CREDIT_SETTING_KEYS.costDecode,
  CREDIT_SETTING_KEYS.costCollectionOpen,
  CREDIT_SETTING_KEYS.costCollectionSend,
  CREDIT_SETTING_KEYS.costCollectionPerItem,
  CREDIT_SETTING_KEYS.referralReward,
  CREDIT_SETTING_KEYS.referralDailyCap,
];

const boolKeys = new Set<string>([
  CREDIT_SETTING_KEYS.enabled,
  CREDIT_SETTING_KEYS.referralEnabled,
  CREDIT_SETTING_KEYS.topupEnabled,
  CREDIT_SETTING_KEYS.bypassForOwner,
  CREDIT_SETTING_KEYS.bypassForAdmin,
]);

function statusEmoji(on: boolean): string {
  return on ? '🟢' : '🔴';
}

/** Render the admin panel body + keyboard. */
function renderAdminPanel(ctx: AppContext): { text: string; keyboard: InlineKeyboard } {
  const credits = ctx.services.credits;

  const enabled = credits.isEnabled();
  const referral = credits.isReferralEnabled();
  const topup = credits.isTopupEnabled();
  const bypassOwner = credits.bypassForOwner();
  const bypassAdmin = credits.bypassForAdmin();

  const lines: string[] = [];
  lines.push(ctx.t('admin.credits.menu_title'));
  lines.push('');
  lines.push(ctx.t('admin.credits.row.system', { status: statusEmoji(enabled) }));
  lines.push(ctx.t('admin.credits.row.topup', { status: statusEmoji(topup) }));
  lines.push(ctx.t('admin.credits.row.referral', { status: statusEmoji(referral) }));
  lines.push(ctx.t('admin.credits.row.bypass_owner', { status: statusEmoji(bypassOwner) }));
  lines.push(ctx.t('admin.credits.row.bypass_admin', { status: statusEmoji(bypassAdmin) }));
  lines.push('');
  lines.push(
    ctx.t('admin.credits.row.signup_bonus', { value: credits.signupBonusAmount() }),
  );
  lines.push(ctx.t('admin.credits.row.cost_decode', { value: credits.costFor('decode') }));
  lines.push(
    ctx.t('admin.credits.row.cost_collection_open', { value: credits.costFor('collection_open') }),
  );
  lines.push(
    ctx.t('admin.credits.row.cost_collection_send', {
      value: credits.costFor('collection_send', { itemCount: 0 }),
    }),
  );
  lines.push(
    ctx.t('admin.credits.row.referral_reward', { value: credits.referralRewardAmount() }),
  );
  lines.push(ctx.t('admin.credits.row.referral_daily_cap', { value: credits.referralDailyCap() }));
  lines.push('');
  lines.push(ctx.t('admin.credits.help_set'));
  lines.push(ctx.t('admin.credits.help_grant'));

  const kb = new InlineKeyboard()
    .text(ctx.t('admin.credits.button.toggle_system'), 'admin:credits:toggle:enabled')
    .row()
    .text(ctx.t('admin.credits.button.toggle_topup'), 'admin:credits:toggle:topup')
    .row()
    .text(ctx.t('admin.credits.button.toggle_referral'), 'admin:credits:toggle:referral')
    .row()
    .text(ctx.t('admin.credits.button.toggle_bypass_owner'), 'admin:credits:toggle:bypass_owner')
    .row()
    .text(ctx.t('admin.credits.button.toggle_bypass_admin'), 'admin:credits:toggle:bypass_admin')
    .row()
    .text(ctx.t('admin.credits.button.refresh'), 'admin:credits:refresh');

  return { text: lines.join('\n'), keyboard: kb };
}

/** Resolve a target user from a numeric telegram_user_id string. */
function findTargetUser(ctx: AppContext, telegramId: string) {
  const user = ctx.repos.users.findByTelegramId(telegramId);
  if (!user) {
    throw new AppError(ErrorCode.USER_NOT_FOUND, `user ${telegramId} not found`, {
      meta: { telegramId },
    });
  }
  return user;
}

/** Parse a positive integer, throws INVALID_INPUT on failure. */
function parsePositiveInt(raw: string, label: string): number {
  const v = Number.parseInt(raw, 10);
  if (!Number.isInteger(v) || v < 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, `${label} must be a non-negative integer`, {
      meta: { raw, label },
    });
  }
  return v;
}

function parsePositiveNonZeroInt(raw: string, label: string): number {
  const v = Number.parseInt(raw, 10);
  if (!Number.isInteger(v) || v < 1) {
    throw new AppError(ErrorCode.INVALID_INPUT, `${label} must be a positive integer`, {
      meta: { raw, label },
    });
  }
  return v;
}

export function registerAdminCreditsRouter(composer: Composer<AppContext>): void {
  const superAdmin = adminOnlyMiddleware();
  const founder = founderOnlyMiddleware();

  // ─── Panel entry: super admin can view, founder can flip ─────────────
  composer.command('admin_credits', superAdmin, async (ctx) => {
    const { text, keyboard } = renderAdminPanel(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  composer.callbackQuery('admin:credits:refresh', superAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, keyboard } = renderAdminPanel(ctx);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });

  // Toggles — founder-only because they materially affect economics.
  composer.callbackQuery(
    /^admin:credits:toggle:(enabled|topup|referral|bypass_owner|bypass_admin)$/,
    founder,
    async (ctx) => {
      const which = ctx.match?.[1];
      const credits = ctx.services.credits;
      let key: string;
      let current: boolean;
      switch (which) {
        case 'enabled':
          key = CREDIT_SETTING_KEYS.enabled;
          current = credits.isEnabled();
          break;
        case 'topup':
          key = CREDIT_SETTING_KEYS.topupEnabled;
          current = credits.isTopupEnabled();
          break;
        case 'referral':
          key = CREDIT_SETTING_KEYS.referralEnabled;
          current = credits.isReferralEnabled();
          break;
        case 'bypass_owner':
          key = CREDIT_SETTING_KEYS.bypassForOwner;
          current = credits.bypassForOwner();
          break;
        case 'bypass_admin':
          key = CREDIT_SETTING_KEYS.bypassForAdmin;
          current = credits.bypassForAdmin();
          break;
        default:
          await ctx.answerCallbackQuery();
          return;
      }
      const next = !current;
      credits.setSetting(key, { kind: 'bool', value: next }, ctx.user.id);
      await ctx.answerCallbackQuery({
        text: ctx.t('admin.credits.toggle_ok', { key, value: next ? 'on' : 'off' }),
      });
      const { text, keyboard } = renderAdminPanel(ctx);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch {
        // ignore — user may have navigated away
      }
    },
  );

  // ─── Numeric edits via founder-only command ───────────────────────────
  composer.command('admin_credit_set', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const key = args[0];
    const valueRaw = args[1];
    if (!key || !valueRaw) {
      await ctx.reply(ctx.t('admin.credits.set.usage'), { parse_mode: 'HTML' });
      return;
    }

    const credits = ctx.services.credits;
    if (boolKeys.has(key)) {
      const v = valueRaw.toLowerCase();
      if (v !== 'true' && v !== 'false' && v !== 'on' && v !== 'off' && v !== '1' && v !== '0') {
        await ctx.reply(ctx.t('admin.credits.set.bool_required'));
        return;
      }
      const boolVal = v === 'true' || v === 'on' || v === '1';
      credits.setSetting(key, { kind: 'bool', value: boolVal }, ctx.user.id);
      await ctx.reply(ctx.t('admin.credits.set.ok', { key, value: String(boolVal) }));
      return;
    }

    // Allow per-file-type override keys (`credits.cost_decode.<filetype>`)
    // alongside the canonical numeric keys.
    const allowsNumber =
      numberKeys.includes(key) || key.startsWith(`${CREDIT_SETTING_KEYS.costDecode}.`);
    if (!allowsNumber) {
      await ctx.reply(ctx.t('admin.credits.set.unknown_key', { key: escapeHtml(key) }), {
        parse_mode: 'HTML',
      });
      return;
    }

    const n = parsePositiveInt(valueRaw, key);
    credits.setSetting(key, { kind: 'number', value: n }, ctx.user.id);
    await ctx.reply(ctx.t('admin.credits.set.ok', { key, value: String(n) }));
  });

  composer.command('admin_credit_clear', founder, async (ctx) => {
    const key = (ctx.match ?? '').toString().trim();
    if (!key) {
      await ctx.reply(ctx.t('admin.credits.clear.usage'), { parse_mode: 'HTML' });
      return;
    }
    ctx.services.credits.clearSetting(key, ctx.user.id);
    await ctx.reply(ctx.t('admin.credits.clear.ok', { key }));
  });

  // ─── User balance edits ───────────────────────────────────────────────
  composer.command('admin_credit_grant', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const tg = args[0];
    const amountRaw = args[1];
    const note = args.slice(2).join(' ').trim();
    if (!tg || !amountRaw) {
      await ctx.reply(ctx.t('admin.credits.grant.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = findTargetUser(ctx, tg);
    const amount = parsePositiveNonZeroInt(amountRaw, 'amount');
    const result = ctx.services.credits.adminAdjust({
      actorUserId: ctx.user.id,
      targetUserId: target.id,
      delta: amount,
      ...(note.length > 0 ? { note } : {}),
    });
    await ctx.reply(
      ctx.t('admin.credits.grant.ok', {
        telegram_id: tg,
        amount,
        balance: result.balanceAfter,
      }),
    );
  });

  composer.command('admin_credit_revoke', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const tg = args[0];
    const amountRaw = args[1];
    const note = args.slice(2).join(' ').trim();
    if (!tg || !amountRaw) {
      await ctx.reply(ctx.t('admin.credits.revoke.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = findTargetUser(ctx, tg);
    const amount = parsePositiveNonZeroInt(amountRaw, 'amount');
    try {
      const result = ctx.services.credits.adminAdjust({
        actorUserId: ctx.user.id,
        targetUserId: target.id,
        delta: -amount,
        ...(note.length > 0 ? { note } : {}),
      });
      await ctx.reply(
        ctx.t('admin.credits.revoke.ok', {
          telegram_id: tg,
          amount,
          balance: result.balanceAfter,
        }),
      );
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_CREDITS) {
        await ctx.reply(
          ctx.t('admin.credits.revoke.would_overdraft', {
            telegram_id: tg,
            balance: ctx.services.credits.getBalance(target.id),
          }),
        );
        return;
      }
      throw err;
    }
  });

  composer.command('admin_credit_setbal', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const tg = args[0];
    const balRaw = args[1];
    const note = args.slice(2).join(' ').trim();
    if (!tg || !balRaw) {
      await ctx.reply(ctx.t('admin.credits.setbal.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = findTargetUser(ctx, tg);
    const newBal = parsePositiveInt(balRaw, 'balance');
    const result = ctx.services.credits.adminSet({
      actorUserId: ctx.user.id,
      targetUserId: target.id,
      targetBalance: newBal,
      ...(note.length > 0 ? { note } : {}),
    });
    await ctx.reply(
      ctx.t('admin.credits.setbal.ok', {
        telegram_id: tg,
        balance: result.balanceAfter,
        delta: result.delta,
      }),
    );
  });

  // ─── Topup packages JSON edit ─────────────────────────────────────────
  composer.command('admin_credit_packages_set', founder, async (ctx) => {
    const json = (ctx.match ?? '').toString().trim();
    if (!json) {
      await ctx.reply(ctx.t('admin.credits.packages.usage'), { parse_mode: 'HTML' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      await ctx.reply(ctx.t('admin.credits.packages.bad_json'));
      return;
    }
    if (!Array.isArray(parsed)) {
      await ctx.reply(ctx.t('admin.credits.packages.bad_json'));
      return;
    }
    const packages: CreditTopupPackage[] = [];
    for (const entry of parsed) {
      const stars = Number((entry as { stars?: unknown })?.stars);
      const credits = Number((entry as { credits?: unknown })?.credits);
      if (!Number.isInteger(stars) || !Number.isInteger(credits) || stars < 1 || credits < 1) {
        await ctx.reply(ctx.t('admin.credits.packages.bad_entry'));
        return;
      }
      packages.push({ stars, credits });
    }
    ctx.services.credits.setTopupPackages(packages, ctx.user.id);
    await ctx.reply(ctx.t('admin.credits.packages.ok', { count: packages.length }));
  });

  composer.command('admin_credit_packages_reset', founder, async (ctx) => {
    ctx.services.credits.clearSetting(CREDIT_SETTING_KEYS.topupPackages, ctx.user.id);
    await ctx.reply(ctx.t('admin.credits.packages.reset_ok'));
  });

  // ─── Stats ────────────────────────────────────────────────────────────
  // ─── Anti-farming pair stats ──────────────────────────────────────────
  // Investigation tool: when a creator's earnings spike, paste the two
  // telegram_user_ids and get back lifetime / today / window counts plus
  // the active caps. If any number is ≥ its cap, the pair is currently
  // throttled (the user just won't earn more from this redeemer).
  composer.command('admin_credit_referral_stats', superAdmin, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const creatorTg = args[0];
    const redeemerTg = args[1];
    if (!creatorTg || !redeemerTg) {
      await ctx.reply(
        'Usage: <code>/admin_credit_referral_stats [creator_tg_id] [redeemer_tg_id]</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }
    const creator = ctx.repos.users.findByTelegramId(creatorTg);
    const redeemer = ctx.repos.users.findByTelegramId(redeemerTg);
    if (!creator || !redeemer) {
      await ctx.reply(
        `Not found: ${!creator ? `creator=${escapeHtml(creatorTg)} ` : ''}${!redeemer ? `redeemer=${escapeHtml(redeemerTg)}` : ''}`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    const stats = ctx.services.credits.referralPairStats(creator.id, redeemer.id);
    const lifeFlag = stats.pairLifetimeCap > 0 && stats.lifetime >= stats.pairLifetimeCap ? '🔴' : '🟢';
    const windowFlag =
      stats.pairWindowMax > 0 && stats.inWindow >= stats.pairWindowMax ? '🔴' : '🟢';
    await ctx.reply(
      [
        `<b>Referral pair stats</b>`,
        `creator: <code>${escapeHtml(creatorTg)}</code> (id ${creator.id})`,
        `redeemer: <code>${escapeHtml(redeemerTg)}</code> (id ${redeemer.id})`,
        ``,
        `${lifeFlag} lifetime: <b>${stats.lifetime}</b> / cap ${stats.pairLifetimeCap || '∞'}`,
        `${windowFlag} window (last ${stats.pairWindowMinutes}m): <b>${stats.inWindow}</b> / max ${stats.pairWindowMax || '∞'}`,
        `   today: <b>${stats.today}</b>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  composer.command('admin_credit_stats', superAdmin, async (ctx) => {
    const start = '1970-01-01T00:00:00.000Z';
    const credits = ctx.repos.credits;
    const totalsBy = (reason: Parameters<typeof credits.globalTotalsByReason>[0]) =>
      credits.globalTotalsByReason(reason, start);

    const stats = {
      signup: totalsBy('signup_bonus'),
      referral: totalsBy('referral_reward'),
      topup: totalsBy('topup'),
      adminAdjust: totalsBy('admin_adjust'),
      adminSet: totalsBy('admin_set'),
      spendDecode: totalsBy('spend_decode'),
      spendCollOpen: totalsBy('spend_collection_open'),
      spendCollSend: totalsBy('spend_collection_send'),
      refund: totalsBy('refund'),
    };
    const totalSpent = -(stats.spendDecode + stats.spendCollOpen + stats.spendCollSend);
    const totalGranted =
      stats.signup + stats.referral + stats.topup + stats.adminAdjust + stats.refund;

    await ctx.reply(
      ctx.t('admin.credits.stats', {
        signup: stats.signup,
        referral: stats.referral,
        topup: stats.topup,
        admin_adjust: stats.adminAdjust,
        admin_set: stats.adminSet,
        refund: stats.refund,
        spend_decode: -stats.spendDecode,
        spend_collection_open: -stats.spendCollOpen,
        spend_collection_send: -stats.spendCollSend,
        total_granted: totalGranted,
        total_spent: totalSpent,
      }),
      { parse_mode: 'HTML' },
    );
  });
}
