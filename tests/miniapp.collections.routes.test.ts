/**
 * Integration tests for the Mini App `/collections` HTTP routes.
 *
 * The Hono app is exercised entirely in-process via `app.fetch(...)`. Each
 * test seeds an in-memory SQLite DB, wires the production services on top
 * (including {@link ShareService} so collections can be created), and asks
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
import { BroadcastService } from '../src/services/broadcast.service.js';
import { CreditService } from '../src/services/credit.service.js';
import { CryptoTopupService } from '../src/services/crypto/cryptoTopup.service.js';

import { createMiniAppServer } from '../src/miniapp/server.js';
import type { MiniAppServer } from '../src/miniapp/server.js';
import type { AppRepos, AppServices } from '../src/miniapp/types.js';
import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

import type { Config } from '../src/config/env.js';
import type { CollectionRow, ManagedBotRow, UserRow } from '../src/types/index.js';

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
    ENABLE_COLLECTIONS: true,
    DEFAULT_FILE_EXPIRY_DAYS: 0,
  });

  const audit = new AuditService(env.repos.audit);
  const userSvc = new UserService(env.repos.users, env.config);
  const fileSvc = new FileService(env.repos.files, env.repos.bots, audit, env.config);
  const botSvc = new BotService(env.repos.bots, audit, env.config, async () => ({
    id: '0',
    username: 'unused',
    firstName: 'unused',
  }));
  const permission = new PermissionService(
    env.repos.permissions,
    userSvc,
    env.config,
    env.repos.bots,
  );
  const rateLimit = new RateLimitService(env.repos.rateLimit, env.config);
  const settings = new SettingsService(env.repos.settings);
  const report = new ReportService(
    env.repos.reports,
    env.repos.files,
    env.repos.collections,
    audit,
    env.config,
  );
  const share = new ShareService({
    files: env.repos.files,
    bots: env.repos.bots,
    collections: env.repos.collections,
    drafts: env.repos.collectionDrafts,
    audit,
    config: env.config,
  });

  const broadcast = new BroadcastService(
    env.repos.broadcasts,
    env.repos.bots,
    permission,
    audit,
    env.config,
  );

  const credits = new CreditService({
    credits: env.repos.credits,
    users: env.repos.users,
    settings,
    audit,
    config: env.config,
  });
  const crypto = new CryptoTopupService({
    invoices: env.repos.cryptoInvoices,
    settings,
    audit,
    credits,
    config: env.config,
    adapters: new Map(),
  });

  // Stubbed in tests — see miniapp.routes.test for rationale.
  const paymentsStub = {
    createStarsInvoiceLink: () => {
      throw new Error('payments stubbed in tests');
    },
    refundStarPayment: () => {
      throw new Error('payments stubbed in tests');
    },
  } as unknown as AppServices['payments'];

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
    broadcast,
    credits,
    crypto,
    payments: paymentsStub,
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
    broadcasts: env.repos.broadcasts,
    credits: env.repos.credits,
    cryptoInvoices: env.repos.cryptoInvoices,
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

/**
 * Build a real collection from scratch via {@link ShareService}. Returns
 * the fresh row plus the bot it lives under so callers can assert on
 * cross-table state.
 */
async function seedCollection(
  user: UserRow,
  bot: ManagedBotRow,
  itemCount = 2,
): Promise<CollectionRow> {
  const draft = w.services.share.createCollectionDraft(user, bot);
  for (let i = 0; i < itemCount; i++) {
    w.services.share.addItemToDraft(draft, {
      file_type: 'photo',
      telegram_file_id: `tg-${user.id}-${i}-${Date.now()}-${Math.random()}`,
      telegram_file_unique_id: null,
      file_name: `item-${i}.jpg`,
      mime_type: 'image/jpeg',
      size_bytes: 1234 * (i + 1),
      caption: null,
    });
  }
  const result = await w.services.share.finishCollection(draft, user);
  return result.collection;
}

describe('Mini App /collections HTTP API', () => {
  it('returns an empty list for users with no collections', async () => {
    seedUser(w.env.repos, '7000');
    const res = await w.fetch(
      new Request('http://localhost/api/v1/collections', {
        headers: { Authorization: authHeader({ telegramUserId: '7000' }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: unknown[]; total: number } };
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it('lists owner collections without leaking password_hash', async () => {
    const owner = seedUser(w.env.repos, '7001');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    await seedCollection(owner, bot, 2);

    const res = await w.fetch(
      new Request('http://localhost/api/v1/collections', {
        headers: { Authorization: authHeader({ telegramUserId: '7001' }) },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('password_hash');

    const body = JSON.parse(text) as {
      data: {
        items: Array<{ id: number; total_items: number; has_password: boolean }>;
        total: number;
      };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.total_items).toBe(2);
    expect(body.data.items[0]?.has_password).toBe(false);
  });

  it('owner can fetch detail; non-owner non-admin gets 404-shape', async () => {
    const owner = seedUser(w.env.repos, '7002');
    const intruder = seedUser(w.env.repos, '7003');
    expect(intruder.id).not.toBe(owner.id);
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    const coll = await seedCollection(owner, bot, 1);

    const okRes = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        headers: { Authorization: authHeader({ telegramUserId: '7002' }) },
      }),
    );
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as {
      data: { id: number; items: Array<{ id: number }>; counts_by_type: Record<string, number> };
    };
    expect(body.data.id).toBe(coll.id);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.counts_by_type.photo).toBe(1);

    const denyRes = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        headers: { Authorization: authHeader({ telegramUserId: '7003' }) },
      }),
    );
    expect(denyRes.status).toBe(400);
    const denyBody = (await denyRes.json()) as { error?: { code?: string } };
    expect(denyBody.error?.code).toBe('FILE_NOT_AVAILABLE');
  });

  it('admin can fetch any collection detail', async () => {
    const owner = seedUser(w.env.repos, '7004');
    seedUser(w.env.repos, '6001', 'super_admin');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    const coll = await seedCollection(owner, bot, 1);

    const res = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        headers: { Authorization: authHeader({ telegramUserId: '6001' }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: number } };
    expect(body.data.id).toBe(coll.id);
  });

  it('PATCH updates title/description', async () => {
    const owner = seedUser(w.env.repos, '7005');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    const coll = await seedCollection(owner, bot, 1);

    const res = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: authHeader({ telegramUserId: '7005' }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'My Trip', description: 'photos from May' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { title: string | null; description: string | null };
    };
    expect(body.data.title).toBe('My Trip');
    expect(body.data.description).toBe('photos from May');
  });

  it('DELETE soft-deletes; subsequent GET returns FILE_NOT_AVAILABLE', async () => {
    const owner = seedUser(w.env.repos, '7006');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    const coll = await seedCollection(owner, bot, 1);

    const delRes = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader({ telegramUserId: '7006' }) },
      }),
    );
    expect(delRes.status).toBe(200);

    const getRes = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        headers: { Authorization: authHeader({ telegramUserId: '7006' }) },
      }),
    );
    expect(getRes.status).toBe(400);
    const body = (await getRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('FILE_NOT_AVAILABLE');

    const listRes = await w.fetch(
      new Request('http://localhost/api/v1/collections', {
        headers: { Authorization: authHeader({ telegramUserId: '7006' }) },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { total: number } };
    expect(listBody.data.total).toBe(0);
  });

  it('reorder with valid IDs reorders items; bogus IDs return 400', async () => {
    const owner = seedUser(w.env.repos, '7007');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    const coll = await seedCollection(owner, bot, 3);

    const items = w.repos.collections.listItems(coll.id);
    const ids = items.map((it) => it.id);
    expect(ids).toHaveLength(3);
    const reversed = [...ids].reverse();

    const okRes = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}/items/reorder`, {
        method: 'POST',
        headers: {
          Authorization: authHeader({ telegramUserId: '7007' }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ordered_ids: reversed }),
      }),
    );
    expect(okRes.status).toBe(200);

    const after = w.repos.collections.listItems(coll.id);
    expect(after.map((it) => it.id)).toEqual(reversed);

    const bogus = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}/items/reorder`, {
        method: 'POST',
        headers: {
          Authorization: authHeader({ telegramUserId: '7007' }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ordered_ids: [9_999_001, 9_999_002, 9_999_003] }),
      }),
    );
    expect(bogus.status).toBe(400);
  });

  it('detail response never carries password_hash even when set', async () => {
    const owner = seedUser(w.env.repos, '7008');
    const bot = seedBot(w.env.repos, owner.id, 'personal_public');
    const coll = await seedCollection(owner, bot, 1);
    await w.services.share.setPassword(coll, 'topsecret', owner);

    const res = await w.fetch(
      new Request(`http://localhost/api/v1/collections/${coll.id}`, {
        headers: { Authorization: authHeader({ telegramUserId: '7008' }) },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('topsecret');
    const body = JSON.parse(text) as { data: { has_password: boolean } };
    expect(body.data.has_password).toBe(true);
  });

  it('admin GET /admin/collections lists all collections', async () => {
    seedUser(w.env.repos, '6001', 'super_admin');
    const ownerA = seedUser(w.env.repos, '7100');
    const ownerB = seedUser(w.env.repos, '7101');
    const botA = seedBot(w.env.repos, ownerA.id, 'personal_public');
    const botB = seedBot(w.env.repos, ownerB.id, 'personal_public');
    await seedCollection(ownerA, botA, 1);
    await seedCollection(ownerB, botB, 1);

    const res = await w.fetch(
      new Request('http://localhost/api/v1/admin/collections', {
        headers: { Authorization: authHeader({ telegramUserId: '6001' }) },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('password_hash');
    const body = JSON.parse(text) as { data: { items: unknown[]; total: number } };
    expect(body.data.total).toBe(2);
    expect(body.data.items).toHaveLength(2);
  });
});
