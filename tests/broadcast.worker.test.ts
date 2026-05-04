/**
 * Tests for {@link BroadcastWorker} — the dispatch loop.
 *
 * The worker talks to Telegram via the bot's `api`, which would normally
 * mean spinning up a real grammY instance and mocking the network. Here
 * we instead pass a hand-rolled fake bot that exposes a minimal `api`
 * surface — `sendMessage` is the only method the worker calls in the
 * text-only path — and have it throw the relevant `GrammyError`s to
 * exercise each branch of the error classifier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GrammyError } from 'grammy';

import { BroadcastWorker } from '../src/services/broadcast.worker.js';
import { BroadcastService } from '../src/services/broadcast.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { PermissionService } from '../src/services/permission.service.js';
import { UserService } from '../src/services/user.service.js';

import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

let env: TestEnv;
let svc: BroadcastService;
let owner: ReturnType<typeof seedUser>;
let bot: ReturnType<typeof seedBot>;

beforeEach(() => {
  env = buildTestEnv();
  seedUser(env.repos, '9999999', 'super_admin'); // founder
  owner = seedUser(env.repos, '1000');
  bot = seedBot(env.repos, owner.id, 'personal_public');
  const audit = new AuditService(env.repos.audit);
  const userSvc = new UserService(env.repos.users, env.config);
  const permission = new PermissionService(
    env.repos.permissions,
    userSvc,
    env.config,
    env.repos.bots,
  );
  svc = new BroadcastService(env.repos.broadcasts, env.repos.bots, permission, audit, env.config);
});

afterEach(() => {
  env.close();
});

/** Build a Telegram-like fake bot whose `sendMessage` is driven by a
 * caller-supplied function. The shape mirrors what the worker uses. */
function makeFakeBot(send: (chatId: number) => Promise<{ message_id: number }>): unknown {
  return {
    api: {
      sendMessage: async (chatId: number) => send(chatId),
    },
  };
}

/** Construct a GrammyError from raw fields — the constructor is private-ish
 * but allocating via Object.assign over a stub gives the worker enough to
 * branch on (`error_code`, `description`, `parameters`). */
function makeGrammyError(code: number, description: string, retryAfter?: number): GrammyError {
  const e = new GrammyError(description, {} as never, 'sendMessage', {});
  Object.defineProperty(e, 'error_code', { value: code });
  Object.defineProperty(e, 'description', { value: description });
  if (retryAfter !== undefined) {
    Object.defineProperty(e, 'parameters', { value: { retry_after: retryAfter } });
  }
  return e;
}

describe('BroadcastWorker.tick', () => {
  it('marks every recipient sent on a clean dispatch', async () => {
    seedUser(env.repos, '8001');
    seedUser(env.repos, '8002');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');

    let n = 0;
    const fakeBot = makeFakeBot(async () => ({ message_id: ++n }));
    const worker = new BroadcastWorker({
      repo: env.repos.broadcasts,
      users: env.repos.users,
      resolveBot: () => fakeBot as never,
    });

    await worker.tick();

    const after = env.repos.broadcasts.findById(draft.id);
    expect(after?.status).toBe('completed');
    expect(after?.count_sent).toBeGreaterThan(0);
    expect(after?.count_pending).toBe(0);
  });

  it('marks a recipient blocked when sendMessage throws 403', async () => {
    seedUser(env.repos, '8101');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');

    const fakeBot = makeFakeBot(async () => {
      throw makeGrammyError(403, 'Forbidden: bot was blocked by the user');
    });
    const worker = new BroadcastWorker({
      repo: env.repos.broadcasts,
      users: env.repos.users,
      resolveBot: () => fakeBot as never,
    });

    await worker.tick();
    const after = env.repos.broadcasts.findById(draft.id);
    expect(after?.count_blocked).toBeGreaterThan(0);
    expect(after?.status).toBe('completed');
  });

  it('reschedules on 429 with retry_after', async () => {
    seedUser(env.repos, '8201');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');

    const fakeBot = makeFakeBot(async () => {
      throw makeGrammyError(429, 'Too Many Requests: retry after 5', 5);
    });
    const worker = new BroadcastWorker({
      repo: env.repos.broadcasts,
      users: env.repos.users,
      resolveBot: () => fakeBot as never,
    });

    await worker.tick();
    const after = env.repos.broadcasts.findById(draft.id);
    // Status stays sending; recipients bounced back to pending with retry_count.
    expect(after?.status).toBe('sending');
    const recipients = env.repos.broadcasts.listRecipients({
      broadcast_id: draft.id,
      limit: 100,
      offset: 0,
    });
    const r = recipients[0];
    expect(r).toBeDefined();
    expect(r?.status).toBe('pending');
    expect(r?.retry_count).toBe(1);
    expect(r?.next_attempt_at).toBeTruthy();
  });

  it('marks recipient failed with non-recoverable Telegram error', async () => {
    seedUser(env.repos, '8301');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');

    const fakeBot = makeFakeBot(async () => {
      throw makeGrammyError(400, "Bad Request: can't parse entities");
    });
    const worker = new BroadcastWorker({
      repo: env.repos.broadcasts,
      users: env.repos.users,
      resolveBot: () => fakeBot as never,
    });

    await worker.tick();
    const after = env.repos.broadcasts.findById(draft.id);
    expect(after?.count_failed).toBeGreaterThan(0);
  });

  it('skips entirely when the resolver returns null', async () => {
    seedUser(env.repos, '8401');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');

    const worker = new BroadcastWorker({
      repo: env.repos.broadcasts,
      users: env.repos.users,
      resolveBot: () => null,
    });
    await worker.tick();
    const after = env.repos.broadcasts.findById(draft.id);
    // Still sending — bot offline, will retry next tick.
    expect(after?.status).toBe('sending');
  });
});
