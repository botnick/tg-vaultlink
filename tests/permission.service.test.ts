/**
 * Tests for {@link PermissionService} — the central authorization decision
 * engine. The matrix is driven against a real in-memory database via the
 * shared {@link buildTestEnv} helper so `repo.has(...)` actually queries
 * SQLite and the bot-permission table participates in every decision.
 *
 * `ManagedBotRow` and `FileRow` literals used to drive role/mode-only paths
 * are cast through `as` because those decisions never read more than a
 * handful of fields off the row; constructing the rest is unnecessary
 * ceremony that would distract from the case under test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PermissionService } from '../src/services/permission.service.js';
import { UserService } from '../src/services/user.service.js';
import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

import type { FileRow, ManagedBotRow } from '../src/types/index.js';

let env: TestEnv;
let users: UserService;
let perms: PermissionService;

beforeEach(() => {
  env = buildTestEnv();
  users = new UserService(env.repos.users, env.config);
  perms = new PermissionService(env.repos.permissions, users, env.config);
});

afterEach(() => {
  env.close();
});

/** Build a synthetic {@link FileRow} owned by `ownerUserId` on `botId`. */
function makeFile(ownerUserId: number, botId: number): FileRow {
  return {
    id: 1,
    code: 'ABCDE23456',
    bot_id: botId,
    owner_user_id: ownerUserId,
    telegram_file_id: 'tg-file-1',
    telegram_file_unique_id: null,
    file_type: 'document',
    file_name: 'x.bin',
    mime_type: null,
    size_bytes: 10,
    caption: null,
    visibility: 'public',
    password_hash: null,
    expires_at: null,
    is_locked: 0,
    is_deleted: 0,
    download_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('permission.service — banned users', () => {
  it("denies all four verbs with reason='banned'", () => {
    const owner = seedUser(env.repos, '100');
    const banned = seedUser(env.repos, '101', 'user', true);
    const bot = seedBot(env.repos, owner.id, 'main_public');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canUpload(banned, bot)).toEqual({ allowed: false, reason: 'banned' });
    expect(perms.canDownload(banned, bot, file)).toEqual({
      allowed: false,
      reason: 'banned',
    });
    expect(perms.canManageFile(banned, file)).toEqual({
      allowed: false,
      reason: 'banned',
    });
    expect(perms.canManageBot(banned, bot)).toEqual({
      allowed: false,
      reason: 'banned',
    });
  });
});

describe('permission.service — admin users', () => {
  it('allows all four verbs for super_admin role holders regardless of mode/ownership', () => {
    const owner = seedUser(env.repos, '200');
    const admin = seedUser(env.repos, '201', 'super_admin');
    const bot = seedBot(env.repos, owner.id, 'personal_private');
    const file = makeFile(owner.id, bot.id);

    expect(perms.isAdmin(admin)).toBe(true);
    expect(perms.canUpload(admin, bot).allowed).toBe(true);
    expect(perms.canDownload(admin, bot, file).allowed).toBe(true);
    expect(perms.canManageFile(admin, file).allowed).toBe(true);
    expect(perms.canManageBot(admin, bot).allowed).toBe(true);
  });
});

describe('permission.service — main_public mode', () => {
  it('lets any non-banned user upload and download', () => {
    const owner = seedUser(env.repos, '300');
    const stranger = seedUser(env.repos, '301');
    const bot = seedBot(env.repos, owner.id, 'main_public');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canUpload(stranger, bot).allowed).toBe(true);
    expect(perms.canDownload(stranger, bot, file).allowed).toBe(true);
  });
});

describe('permission.service — personal_public mode', () => {
  it('owner can upload', () => {
    const owner = seedUser(env.repos, '400');
    const bot = seedBot(env.repos, owner.id, 'personal_public');

    expect(perms.canUpload(owner, bot).allowed).toBe(true);
  });

  it('non-owner without allow_upload is mode_restricted on upload', () => {
    const owner = seedUser(env.repos, '410');
    const stranger = seedUser(env.repos, '411');
    const bot = seedBot(env.repos, owner.id, 'personal_public');

    expect(perms.canUpload(stranger, bot)).toEqual({
      allowed: false,
      reason: 'mode_restricted',
    });
  });

  it('non-owner with allow_upload can upload', () => {
    const owner = seedUser(env.repos, '420');
    const guest = seedUser(env.repos, '421');
    const bot = seedBot(env.repos, owner.id, 'personal_public');
    env.repos.permissions.grant(bot.id, guest.id, 'allow_upload');

    expect(perms.canUpload(guest, bot).allowed).toBe(true);
  });

  it('owner and non-owner can both download', () => {
    const owner = seedUser(env.repos, '430');
    const stranger = seedUser(env.repos, '431');
    const bot = seedBot(env.repos, owner.id, 'personal_public');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canDownload(owner, bot, file).allowed).toBe(true);
    expect(perms.canDownload(stranger, bot, file).allowed).toBe(true);
  });

  it("'deny' on a non-owner blocks download with reason='denied'", () => {
    const owner = seedUser(env.repos, '440');
    const blocked = seedUser(env.repos, '441');
    const bot = seedBot(env.repos, owner.id, 'personal_public');
    const file = makeFile(owner.id, bot.id);
    env.repos.permissions.grant(bot.id, blocked.id, 'deny');

    expect(perms.canDownload(blocked, bot, file)).toEqual({
      allowed: false,
      reason: 'denied',
    });
  });

  it("'deny_upload' on a non-owner blocks upload with reason='denied'", () => {
    const owner = seedUser(env.repos, '450');
    const blocked = seedUser(env.repos, '451');
    const bot = seedBot(env.repos, owner.id, 'personal_public');
    env.repos.permissions.grant(bot.id, blocked.id, 'deny_upload');

    expect(perms.canUpload(blocked, bot)).toEqual({
      allowed: false,
      reason: 'denied',
    });
  });
});

describe('permission.service — personal_private mode', () => {
  it('owner can upload and download', () => {
    const owner = seedUser(env.repos, '500');
    const bot = seedBot(env.repos, owner.id, 'personal_private');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canUpload(owner, bot).allowed).toBe(true);
    expect(perms.canDownload(owner, bot, file).allowed).toBe(true);
  });

  it('outsider without any grant is mode_restricted on both verbs', () => {
    const owner = seedUser(env.repos, '510');
    const outsider = seedUser(env.repos, '511');
    const bot = seedBot(env.repos, owner.id, 'personal_private');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canUpload(outsider, bot)).toEqual({
      allowed: false,
      reason: 'mode_restricted',
    });
    expect(perms.canDownload(outsider, bot, file)).toEqual({
      allowed: false,
      reason: 'mode_restricted',
    });
  });

  it("'allow' alone permits download but not upload", () => {
    const owner = seedUser(env.repos, '520');
    const guest = seedUser(env.repos, '521');
    const bot = seedBot(env.repos, owner.id, 'personal_private');
    const file = makeFile(owner.id, bot.id);
    env.repos.permissions.grant(bot.id, guest.id, 'allow');

    expect(perms.canDownload(guest, bot, file).allowed).toBe(true);
    expect(perms.canUpload(guest, bot)).toEqual({
      allowed: false,
      reason: 'mode_restricted',
    });
  });

  it("'allow_upload' alone permits both upload and download", () => {
    // The implementation treats allow_upload as a superset for download in the
    // private bucket, so the matrix does pass through; this test pins that
    // exact behavior so any future tightening forces a deliberate change.
    const owner = seedUser(env.repos, '530');
    const guest = seedUser(env.repos, '531');
    const bot = seedBot(env.repos, owner.id, 'personal_private');
    const file = makeFile(owner.id, bot.id);
    env.repos.permissions.grant(bot.id, guest.id, 'allow_upload');

    expect(perms.canUpload(guest, bot).allowed).toBe(true);
    expect(perms.canDownload(guest, bot, file).allowed).toBe(true);
  });
});

describe('permission.service — file management', () => {
  it('file owner is allowed', () => {
    const owner = seedUser(env.repos, '600');
    const bot = seedBot(env.repos, owner.id, 'main_public');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canManageFile(owner, file).allowed).toBe(true);
  });

  it("non-owner non-admin is denied with reason='not_owner'", () => {
    const owner = seedUser(env.repos, '610');
    const stranger = seedUser(env.repos, '611');
    const bot = seedBot(env.repos, owner.id, 'main_public');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canManageFile(stranger, file)).toEqual({
      allowed: false,
      reason: 'not_owner',
    });
  });

  it('admin can manage anyone’s file', () => {
    const owner = seedUser(env.repos, '620');
    const admin = seedUser(env.repos, '621', 'super_admin');
    const bot = seedBot(env.repos, owner.id, 'personal_private');
    const file = makeFile(owner.id, bot.id);

    expect(perms.canManageFile(admin, file).allowed).toBe(true);
  });
});

describe('permission.service — bot management', () => {
  it('bot owner is allowed', () => {
    const owner = seedUser(env.repos, '700');
    const bot = seedBot(env.repos, owner.id, 'personal_public');

    expect(perms.canManageBot(owner, bot).allowed).toBe(true);
  });

  it("non-owner is denied with reason='not_owner'", () => {
    const owner = seedUser(env.repos, '710');
    const stranger = seedUser(env.repos, '711');
    const bot = seedBot(env.repos, owner.id, 'personal_public');

    expect(perms.canManageBot(stranger, bot)).toEqual({
      allowed: false,
      reason: 'not_owner',
    });
  });

  it('admin can manage any bot', () => {
    const owner = seedUser(env.repos, '720');
    const admin = seedUser(env.repos, '721', 'super_admin');
    const bot = seedBot(env.repos, owner.id, 'personal_private');

    expect(perms.canManageBot(admin, bot).allowed).toBe(true);
  });
});

describe('permission.service — ManagedBotRow literal smoke', () => {
  it('accepts cast literals for cases that never touch the DB', () => {
    const owner = seedUser(env.repos, '800');
    const stub = {
      id: 999,
      owner_user_id: owner.id,
      mode: 'main_public',
      status: 'active',
    } as unknown as ManagedBotRow;
    expect(perms.canUpload(owner, stub).allowed).toBe(true);
  });
});
