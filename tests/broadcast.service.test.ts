/**
 * Tests for {@link BroadcastService} — exercises the public surface that
 * the Mini App routes call: createDraft, updateDraft, audiencePreview,
 * send, schedule, cancel, plus the founder-or-bot-owner permission gate.
 *
 * All tests run against a real in-memory SQLite via `buildTestEnv` so
 * the `users.broadcast_unsubscribed` filter, audience materialization,
 * and recipient counts are exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/services/audit.service.js';
import { PermissionService } from '../src/services/permission.service.js';
import { UserService } from '../src/services/user.service.js';
import { BroadcastService } from '../src/services/broadcast.service.js';

import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

import type { Config } from '../src/config/env.js';
import { AppError } from '../src/utils/errors.js';

let env: TestEnv;
let svc: BroadcastService;
let founder: ReturnType<typeof seedUser>;
let owner: ReturnType<typeof seedUser>;
let bot: ReturnType<typeof seedBot>;

beforeEach(() => {
  env = buildTestEnv({ ADMIN_IDS: Object.freeze(['9999999']) as readonly string[] });
  // Founder = ADMIN_IDS member.
  founder = seedUser(env.repos, '9999999', 'super_admin');
  owner = seedUser(env.repos, '1000', 'user');
  bot = seedBot(env.repos, owner.id, 'personal_public');
  const audit = new AuditService(env.repos.audit);
  const userSvc = new UserService(env.repos.users, env.config);
  const permission = new PermissionService(
    env.repos.permissions,
    userSvc,
    env.config,
    env.repos.bots,
  );
  svc = new BroadcastService(env.repos.broadcasts, env.repos.bots, permission, audit, env.config as Config);
});

afterEach(() => {
  env.close();
});

describe('BroadcastService.createDraft', () => {
  it('lets the bot owner create a draft on their bot', () => {
    const row = svc.createDraft(owner, { bot_id: bot.id, text: 'hello world' });
    expect(row.status).toBe('draft');
    expect(row.bot_id).toBe(bot.id);
    expect(row.text).toBe('hello world');
  });

  it('lets a founder create a draft on any bot', () => {
    const row = svc.createDraft(founder, { bot_id: bot.id, text: 'hi' });
    expect(row.status).toBe('draft');
  });

  it('rejects a non-owner non-founder', () => {
    const stranger = seedUser(env.repos, '2000');
    expect(() => svc.createDraft(stranger, { bot_id: bot.id, text: 'no' })).toThrow(AppError);
  });

  it('rejects empty text', () => {
    expect(() => svc.createDraft(owner, { bot_id: bot.id, text: '   ' })).toThrow(AppError);
  });

  it('rejects an invalid button URL scheme', () => {
    expect(() =>
      svc.createDraft(owner, {
        bot_id: bot.id,
        text: 'hi',
        buttons: [[{ text: 'click', url: 'javascript:alert(1)' }]],
      }),
    ).toThrow(AppError);
  });

  it('accepts https URLs in inline buttons', () => {
    const row = svc.createDraft(owner, {
      bot_id: bot.id,
      text: 'hi',
      buttons: [[{ text: 'go', url: 'https://example.com' }]],
    });
    expect(row.buttons_json).toContain('example.com');
  });
});

describe('BroadcastService.audiencePreview', () => {
  it('counts users matching the audience filter', () => {
    seedUser(env.repos, '3001');
    seedUser(env.repos, '3002');
    seedUser(env.repos, '3003');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    const preview = svc.audiencePreview(owner, draft.id);
    // founder (9999999) + owner (1000) + 3 fresh = 5 unbanned active users
    expect(preview.count).toBe(5);
    expect(preview.sample.length).toBeGreaterThan(0);
  });

  it('respects the broadcast_unsubscribed flag', () => {
    const u = seedUser(env.repos, '3010');
    env.repos.users.setBroadcastUnsubscribed(u.id, true);
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    const preview = svc.audiencePreview(owner, draft.id);
    // founder + owner — opted-out user excluded
    expect(preview.count).toBe(2);
  });

  it('honors explicit user_ids override', () => {
    const u1 = seedUser(env.repos, '4001');
    seedUser(env.repos, '4002');
    seedUser(env.repos, '4003');
    const draft = svc.createDraft(owner, {
      bot_id: bot.id,
      text: 'hi',
      audience: {
        locale: 'all',
        role: 'all',
        exclude_banned: true,
        exclude_unsubscribed: true,
        registered_within_days: null,
        user_ids: [u1.telegram_user_id],
      },
    });
    const preview = svc.audiencePreview(owner, draft.id);
    expect(preview.count).toBe(1);
  });
});

describe('BroadcastService.send', () => {
  it('requires the literal "SEND" confirmation', () => {
    seedUser(env.repos, '5001');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    expect(() => svc.send(owner, draft.id, 'send')).toThrow(AppError);
    expect(() => svc.send(owner, draft.id, '')).toThrow(AppError);
  });

  it('flips status to sending and materializes recipients', () => {
    seedUser(env.repos, '5101');
    seedUser(env.repos, '5102');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    const sent = svc.send(owner, draft.id, 'SEND');
    expect(sent.status).toBe('sending');
    expect(sent.audience_count).toBeGreaterThan(0);
    const recipients = env.repos.broadcasts.listRecipients({
      broadcast_id: draft.id,
      limit: 100,
      offset: 0,
    });
    expect(recipients.length).toBe(sent.audience_count);
    expect(recipients.every((r) => r.status === 'pending')).toBe(true);
  });

  it('refuses to send when audience is empty', () => {
    // Audience with explicit user_ids that don't exist
    const draft = svc.createDraft(owner, {
      bot_id: bot.id,
      text: 'hi',
      audience: {
        locale: 'all',
        role: 'all',
        exclude_banned: true,
        exclude_unsubscribed: true,
        registered_within_days: null,
        user_ids: ['nonexistent'],
      },
    });
    expect(() => svc.send(owner, draft.id, 'SEND')).toThrow(AppError);
  });
});

describe('BroadcastService.cancel', () => {
  it('marks pending recipients as cancelled', () => {
    seedUser(env.repos, '6001');
    seedUser(env.repos, '6002');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');
    const cancelled = svc.cancel(owner, draft.id);
    expect(cancelled.status).toBe('cancelled');
    const remaining = env.repos.broadcasts.listRecipients({
      broadcast_id: draft.id,
      status: 'pending',
      limit: 100,
      offset: 0,
    });
    expect(remaining.length).toBe(0);
  });

  it('is idempotent on already-completed broadcasts', () => {
    seedUser(env.repos, '6101');
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    svc.send(owner, draft.id, 'SEND');
    svc.cancel(owner, draft.id);
    expect(() => svc.cancel(owner, draft.id)).not.toThrow();
  });
});

describe('BroadcastService.schedule', () => {
  it('rejects non-ISO dates', () => {
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    expect(() => svc.schedule(owner, draft.id, 'tomorrow')).toThrow(AppError);
  });

  it('stores the scheduled_at as an ISO string', () => {
    const draft = svc.createDraft(owner, { bot_id: bot.id, text: 'hi' });
    const when = '2030-06-15T09:00:00Z';
    const row = svc.schedule(owner, draft.id, when);
    expect(row.scheduled_at).toContain('2030-06-15');
  });
});
