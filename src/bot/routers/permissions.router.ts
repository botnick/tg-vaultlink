/**
 * Permissions router — owner-side allow/deny + mode toggles for personal
 * bots. Every command guards on "this is a personal bot AND the caller owns
 * (or admins) it"; running the same command on the main bot replies with the
 * `permission.only_personal` notice instead of mutating anything.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import type { BotPermissionType } from '../../types/index.js';

const NUMERIC_RE = /^\d+$/;

function ensureOwnerOnPersonalBot(ctx: AppContext): boolean {
  if (ctx.bot.mode === 'main_public') {
    void ctx.reply(ctx.t('permission.only_personal')).catch(() => undefined);
    return false;
  }
  const decision = ctx.services.permission.canManageBot(ctx.user, ctx.bot);
  if (!decision.allowed) {
    void ctx.reply(ctx.t('common.error.permission_denied')).catch(() => undefined);
    return false;
  }
  return true;
}

function parseUserId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, '');
  if (NUMERIC_RE.test(trimmed)) return trimmed;
  return null;
}

export function registerPermissionsRouter(composer: Composer<AppContext>): void {
  async function applyPermission(
    ctx: AppContext,
    rawArg: string,
    perm: BotPermissionType,
    successKey: string,
    usageKey: string,
  ): Promise<void> {
    if (!ensureOwnerOnPersonalBot(ctx)) return;

    const id = parseUserId(rawArg);
    if (!id) {
      await ctx.reply(ctx.t(usageKey), { parse_mode: 'HTML' });
      return;
    }
    const target = ctx.repos.users.findByTelegramId(id);
    if (!target) {
      await ctx.reply(ctx.t('common.error.user_not_found'));
      return;
    }
    if (perm === 'allow' || perm === 'allow_upload') {
      ctx.repos.permissions.grant(ctx.bot.id, target.id, perm);
    } else {
      ctx.repos.permissions.revoke(
        ctx.bot.id,
        target.id,
        perm === 'deny' ? 'allow' : 'allow_upload',
      );
      ctx.repos.permissions.grant(ctx.bot.id, target.id, perm);
    }
    ctx.services.audit.log(`bot.permission.${perm}`, {
      actorUserId: ctx.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: { bot_id: ctx.bot.id, perm },
    });
    await ctx.reply(ctx.t(successKey, { userId: id }), { parse_mode: 'HTML' });
  }

  composer.command('allow', async (ctx) => {
    await applyPermission(
      ctx,
      (ctx.match ?? '').toString(),
      'allow',
      'permission.allow.success',
      'permission.allow.usage',
    );
  });

  composer.command('deny', async (ctx) => {
    await applyPermission(
      ctx,
      (ctx.match ?? '').toString(),
      'deny',
      'permission.deny.success',
      'permission.deny.usage',
    );
  });

  composer.command('allow_upload', async (ctx) => {
    await applyPermission(
      ctx,
      (ctx.match ?? '').toString(),
      'allow_upload',
      'permission.allow_upload.user_success',
      'permission.allow_upload.usage',
    );
  });

  composer.command('deny_upload', async (ctx) => {
    await applyPermission(
      ctx,
      (ctx.match ?? '').toString(),
      'deny_upload',
      'permission.deny_upload.user_success',
      'permission.deny_upload.usage',
    );
  });

  composer.command('mode_public', async (ctx) => {
    if (!ensureOwnerOnPersonalBot(ctx)) return;
    ctx.services.bot.setMode(ctx.bot, 'personal_public', ctx.user);
    await ctx.reply(ctx.t('permission.mode_changed', { mode: ctx.t('permission.mode_public') }), {
      parse_mode: 'HTML',
    });
  });

  composer.command('mode_private', async (ctx) => {
    if (!ensureOwnerOnPersonalBot(ctx)) return;
    ctx.services.bot.setMode(ctx.bot, 'personal_private', ctx.user);
    await ctx.reply(ctx.t('permission.mode_changed', { mode: ctx.t('permission.mode_private') }), {
      parse_mode: 'HTML',
    });
  });

  composer.command('stats', async (ctx) => {
    if (!ensureOwnerOnPersonalBot(ctx)) return;
    const count = ctx.repos.permissions.count(ctx.bot.id);
    await ctx.reply(ctx.t('permission.stats', { count }), { parse_mode: 'HTML' });
  });
}
