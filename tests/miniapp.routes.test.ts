/**
 * Integration tests for the Mini App HTTP API.
 *
 * The Hono app is exercised entirely in-process via `app.fetch(...)` — no
 * real socket bind, no real HTTP. Each test seeds an in-memory SQLite DB
 * via {@link buildTestEnv}, wires the production services on top, and asks
 * the resulting Mini App backend to respond to synthetic requests carrying
 * a freshly-signed `initData` header.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import { AuditService } from '../src/services/audit.service.js';
import { BotService } from '../src/services/bot.service.js';
import { FileService } from '../src/services/file.service.js';
import { PermissionService } from '../src/services/permission.service.js';
import { RateLimitService } from '../src/services/rateLimit.service.js';
import { ReportService } from '../src/services/report.service.js';
import { SettingsService } from '../src/services/settings.service.js';
import { UserService } from '../src/services/user.service.js';
import { ShareService } from '../src/services/share.service.js';

import { createMiniAppServer } from '../src/miniapp/server.js';
import type { MiniAppServer } from '../src/miniapp/server.js';
import type { AppRepos, AppServices } from '../src/miniapp/types.js';
import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

import type { Config } from '../src/config/env.js';
import type { ManagedBotRow } from '../src/types/index.js';

const TOKEN = '123456:AAAA-test-token-AAAA-test-token-AAAA';

function buildInitData(payload: Record<string, string>, token: string = TOKEN): string {
  const sorted = Object.keys(payload)
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join('\n');
  const secret = createHmac('sha256', Buffer.from('WebAppData'))
    .update(Buffer.from(token))
    .digest();
  const hash = createHmac('sha256', secret).update(sorted).digest('hex');
  const params = new URLSearchParams({ ...payload, hash });
  return params.toString();
}

function authHeader(opts: {
  telegramUserId: string;
  firstName?: string;
  username?: string;
  authDate?: number;
}): string {
  const authDate = opts.authDate ?? Math.floor(Date.now() / 1000);
  const user: Record<string, unknown> = {
    id: Number(opts.telegramUserId),
    first_name: opts.firstName ?? 'Test',
  };
  if (opts.username !== undefined) user.username = opts.username;
  return (
    'tma ' +
    buildInitData({
      auth_date: String(authDate),
      user: JSON.stringify(user),
    })
  );
}

interface Wired {
  env: TestEnv;
  services: AppServices;
  repos: AppRepos;
  config: Config;
  server: MiniAppServer;
  fetch: (req: Request) => Promise<Response>;
}

function wire(): Wired {
  const env = buildTestEnv({
    ENABLE_MINI_APP: true,
    MAIN_BOT_TOKEN: TOKEN,
    MINI_APP_URL: 'https://miniapp.example/',
    MINI_APP_API_BASE_URL: 'https://miniapp.example/api',
    MINI_APP_ALLOWED_ORIGINS: ['https://miniapp.example'] as readonly string[],
    MINI_APP_INITDATA_MAX_AGE_SECONDS: 86_400,
  });

  const audit = new AuditService(env.repos.audit);
  const userSvc = new UserService(env.repos.users, env.config);
  const fileSvc = new FileService(env.repos.files, env.repos.bots, audit, env.config);
  // Test-only getMe: never invoked by the routes we exercise here, but the
  // BotService constructor still requires a callable.
  const botSvc = new BotService(env.repos.bots, audit, env.config, async () => ({
    id: '0',
    username: 'unused',
    firstName: 'unused',
  }));
  const permission = new PermissionService(env.repos.permissions, userSvc, env.config);
  const rateLimit = new RateLimitService(env.repos.rateLimit, env.config);
  const settings = new SettingsService(env.repos.settings);
  const report = new ReportService(env.repos.reports, env.repos.files, audit, env.config);
  const share = new ShareService({
    files: env.repos.files,
    bots: env.repos.bots,
    collections: env.repos.collections,
    drafts: env.repos.collectionDrafts,
    audit,
    config: env.config,
  });

  const services: AppServices = {
    file: fileSvc,
    bot: botSvc,
    permission,
    user: userSvc,
    rateLimit,
    settings,
    report,
    audit,
    share,
  };

  const repos: AppRepos = {
    users: env.repos.users,
    files: env.repos.files,
    bots: env.repos.bots,
    permissions: env.repos.permissions,
    reports: env.repos.reports,
    audit: env.repos.audit,
    settings: env.repos.settings,
    rateLimit: env.repos.rateLimit,
    collections: env.repos.collections,
    collectionDrafts: env.repos.collectionDrafts,
  };

  const server = createMiniAppServer({ config: env.config, services, repos });

  return {
    env,
    services,
    repos,
    config: env.config,
    server,
    fetch: (req: Request) => Promise.resolve(server.app.fetch(req)) as Promise<Response>,
  };
}

let w: Wired;

beforeEach(() => {
  w = wire();
});

afterEach(() => {
  w.env.close();
});

describe('Mini App HTTP API', () => {
  it('GET /healthz is unauthenticated and returns ok', async () => {
    const res = await w.fetch(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /api/v1/me without auth returns 401', async () => {
    const res = await w.fetch(new Request('http://localhost/api/v1/me'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
  });

  it('GET /api/v1/me with valid initData returns the user', async () => {
    const res = await w.fetch(
      new Request('http://localhost/api/v1/me', {
        headers: { Authorization: authHeader({ telegramUserId: '777', firstName: 'Ada' }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { telegram_user_id: string; is_admin: boolean } };
    expect(body.data.telegram_user_id).toBe('777');
    expect(body.data.is_admin).toBe(false);
  });

  it("GET /api/v1/files only lists the caller's files", async () => {
    // Pre-create both users in the DB *with the IDs that match the headers*
    // so the file rows we seed below carry the right owner_user_id.
    const userA = seedUser(w.env.repos, '1001');
    const userB = seedUser(w.env.repos, '1002');
    const ownerBot: ManagedBotRow = seedBot(w.env.repos, userA.id, 'personal_public');
    const otherBot: ManagedBotRow = seedBot(w.env.repos, userB.id, 'personal_public');

    await w.services.file.upload({
      user: userA,
      bot: ownerBot,
      meta: {
        file_type: 'document',
        telegram_file_id: 'tg-A-1',
        telegram_file_unique_id: 'u-A-1',
        file_name: 'a.txt',
        mime_type: 'text/plain',
        size_bytes: 10,
        caption: null,
      },
    });
    await w.services.file.upload({
      user: userB,
      bot: otherBot,
      meta: {
        file_type: 'document',
        telegram_file_id: 'tg-B-1',
        telegram_file_unique_id: 'u-B-1',
        file_name: 'b.txt',
        mime_type: 'text/plain',
        size_bytes: 20,
        caption: null,
      },
    });

    const res = await w.fetch(
      new Request('http://localhost/api/v1/files', {
        headers: { Authorization: authHeader({ telegramUserId: '1001' }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ file_name: string }>; total: number };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.file_name).toBe('a.txt');
  });

  it('GET /api/v1/admin/stats returns 403 for non-admin callers', async () => {
    const res = await w.fetch(
      new Request('http://localhost/api/v1/admin/stats', {
        headers: { Authorization: authHeader({ telegramUserId: '5555' }) },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('GET /api/v1/admin/stats returns 200 for super_admin role', async () => {
    seedUser(w.env.repos, '6001', 'super_admin');
    const res = await w.fetch(
      new Request('http://localhost/api/v1/admin/stats', {
        headers: { Authorization: authHeader({ telegramUserId: '6001' }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { users: number; bots: number; files: number; pendingReports: number };
    };
    expect(typeof body.data.users).toBe('number');
    expect(typeof body.data.bots).toBe('number');
    expect(typeof body.data.files).toBe('number');
    expect(typeof body.data.pendingReports).toBe('number');
  });

  it('GET /api/v1/admin/stats returns 200 for ADMIN_IDS bootstrap', async () => {
    // testDb defaults ADMIN_IDS to ['9999999'].
    const res = await w.fetch(
      new Request('http://localhost/api/v1/admin/stats', {
        headers: { Authorization: authHeader({ telegramUserId: '9999999' }) },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/bots/:id never exposes the encrypted token tuple', async () => {
    const owner = seedUser(w.env.repos, '4242');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public', { username: 'leakcheckbot' });

    const res = await w.fetch(
      new Request(`http://localhost/api/v1/bots/${bot.id}`, {
        headers: { Authorization: authHeader({ telegramUserId: '4242' }) },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('encrypted_token');
    expect(text).not.toContain('token_nonce');
    expect(text).not.toContain('token_auth_tag');
    const body = JSON.parse(text) as { data: { username: string } };
    expect(body.data.username).toBe('leakcheckbot');
  });

  it('expired initData is rejected with 401', async () => {
    const oldAuthDate = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const res = await w.fetch(
      new Request('http://localhost/api/v1/me', {
        headers: {
          Authorization: authHeader({ telegramUserId: '777', authDate: oldAuthDate }),
        },
      }),
    );
    expect(res.status).toBe(401);
  });
});
