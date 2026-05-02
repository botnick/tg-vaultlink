/**
 * VaultLink Bot — Mini App `/settings` + `/me` routes.
 *
 * `/me` returns the verified caller identity (id, telegram_user_id, locale,
 * role, is_admin) — the only place we expose `is_admin` so the frontend
 * can decide whether to render the admin shell.
 *
 * `/settings` exposes per-user UI state (currently just `locale`) plus the
 * read-only configuration the frontend needs to render its language
 * switcher (the default locale + the supported set).
 */

import { Hono } from 'hono';
import type { Config } from '../../config/env.js';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos, MeDto } from '../types.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

export interface SettingsRouteDeps {
  config: Config;
  services: AppServices;
  repos: AppRepos;
}

const SUPPORTED_LOCALES = ['th', 'en'] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function settingsRoutes(deps: SettingsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { config, services, repos } = deps;

  app.get('/me', (c) => {
    const u = c.var.user;
    const me: MeDto = {
      id: u.id,
      telegram_user_id: u.telegram_user_id,
      username: u.username,
      first_name: u.first_name,
      last_name: u.last_name,
      locale: u.locale,
      role: u.role,
      is_admin: c.var.isAdmin === true,
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ data: me });
  });

  app.get('/settings', (c) => {
    const u = c.var.user;
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        user: {
          telegram_user_id: u.telegram_user_id,
          locale: u.locale,
        },
        ui: {
          default_locale: config.DEFAULT_LOCALE,
          supported_locales: SUPPORTED_LOCALES,
        },
      },
    });
  });

  app.patch('/settings', async (c) => {
    const body = await c.req.json<{ locale?: unknown }>().catch(() => ({}) as { locale?: unknown });
    if (!isSupportedLocale(body.locale)) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `locale must be one of: ${SUPPORTED_LOCALES.join(', ')}`,
        { expose: true },
      );
    }
    const updated = repos.users.update(c.var.user.id, { locale: body.locale });
    services.audit.log('miniapp.locale_changed', {
      actorUserId: c.var.user.id,
      targetType: 'user',
      targetId: String(c.var.user.id),
      metadata: { locale: body.locale },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        user: {
          telegram_user_id: updated.telegram_user_id,
          locale: updated.locale,
        },
      },
    });
  });

  return app;
}
