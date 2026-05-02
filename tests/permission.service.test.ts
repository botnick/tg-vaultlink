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
  perms = new PermissionService(env.repos.permissions, users, env.config, env.repos.bots);
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

  it('non-owner can upload by default (personal_public is fully open)', () => {
    // Policy update: personal_public bots match main_public — anyone who
    // isn't explicitly denied can upload. Bot owners can still ban
    // specific abusers via /deny or /deny_upload.
    const owner = seedUser(env.repos, '410');
    const stranger = seedUser(env.repos, '411');
    const bot = seedBot(env.repos, owner.id, 'personal_public');

    expect(perms.canUpload(stranger, bot).allowed).toBe(true);
  });

  it('non-owner with deny_upload is denied even on personal_public', () => {
    const owner = seedUser(env.repos, '412');
    const blocked = seedUser(env.repos, '413');
    const bot = seedBot(env.repos, owner.id, 'personal_public');
    env.repos.permissions.grant(bot.id, blocked.id, 'deny_upload');

    expect(perms.canUpload(blocked, bot)).toEqual({
      allowed: false,
      reason: 'denied',
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

/* -------------------------------------------------------------------------- *
 * Bot-scoped moderation: a bot owner is an "admin of their own bot" but
 * cannot reach across to other bots, and cannot escalate to system admin.
 * -------------------------------------------------------------------------- */
describe('permission.service — canModerateFile (cross-bot isolation)', () => {
  it('allows the bot owner to moderate any file ON THEIR BOT', () => {
    const ownerA = seedUser(env.repos, '900');
    const stranger = seedUser(env.repos, '901');
    const botA = seedBot(env.repos, ownerA.id, 'main_public');
    // File on botA uploaded by `stranger` (not the bot owner).
    const file = env.repos.files.insert({
      code: 'AAABBB23456X',
      bot_id: botA.id,
      owner_user_id: stranger.id,
      telegram_file_id: 'tg-1',
      telegram_file_unique_id: null,
      file_type: 'document',
      file_name: null,
      mime_type: null,
      size_bytes: 1,
      caption: null,
      visibility: 'public',
      password_hash: null,
      expires_at: null,
    });
    expect(perms.canModerateFile(ownerA, file).allowed).toBe(true);
  });

  it('REFUSES a bot owner trying to moderate a file on a DIFFERENT bot', () => {
    const ownerA = seedUser(env.repos, '910');
    const ownerB = seedUser(env.repos, '911');
    const botB = seedBot(env.repos, ownerB.id, 'personal_public', { username: 'bbbbbbbot' });
    const fileOnB = env.repos.files.insert({
      code: 'CCCDDD23456X',
      bot_id: botB.id,
      owner_user_id: ownerB.id,
      telegram_file_id: 'tg-2',
      telegram_file_unique_id: null,
      file_type: 'document',
      file_name: null,
      mime_type: null,
      size_bytes: 1,
      caption: null,
      visibility: 'public',
      password_hash: null,
      expires_at: null,
    });
    // ownerA owns no relevant bot here; the gate must say 'not_owner'.
    const decision = perms.canModerateFile(ownerA, fileOnB);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('not_owner');
  });

  it('always allows a super_admin regardless of which bot the file lives on', () => {
    const ownerB = seedUser(env.repos, '920');
    const sysAdmin = seedUser(env.repos, '921', 'super_admin');
    const botB = seedBot(env.repos, ownerB.id, 'personal_private', { username: 'aaaaaabot' });
    const file = env.repos.files.insert({
      code: 'EEEFFF23456X',
      bot_id: botB.id,
      owner_user_id: ownerB.id,
      telegram_file_id: 'tg-3',
      telegram_file_unique_id: null,
      file_type: 'document',
      file_name: null,
      mime_type: null,
      size_bytes: 1,
      caption: null,
      visibility: 'public',
      password_hash: null,
      expires_at: null,
    });
    expect(perms.canModerateFile(sysAdmin, file).allowed).toBe(true);
  });

  it('denies banned users even when they own the bot the file lives on', () => {
    const banned = seedUser(env.repos, '930', 'user', true);
    const bot = seedBot(env.repos, banned.id, 'main_public');
    const file = env.repos.files.insert({
      code: 'GGGHHH23456X',
      bot_id: bot.id,
      owner_user_id: banned.id,
      telegram_file_id: 'tg-4',
      telegram_file_unique_id: null,
      file_type: 'document',
      file_name: null,
      mime_type: null,
      size_bytes: 1,
      caption: null,
      visibility: 'public',
      password_hash: null,
      expires_at: null,
    });
    const decision = perms.canModerateFile(banned, file);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('banned');
  });
});

describe('permission.service — isFounder', () => {
  // The default `buildTestEnv` config has `ADMIN_IDS=['9999999']`. Tests
  // that need a different list should construct their own env locally
  // (see user.service.setRole.test.ts for the pattern).
  it('returns true when the user is in env ADMIN_IDS', () => {
    const founder = seedUser(env.repos, '9999999');
    expect(perms.isFounder(founder)).toBe(true);
  });

  it('returns false when the user is super_admin BUT not in ADMIN_IDS', () => {
    const promoted = seedUser(env.repos, '999001', 'super_admin');
    expect(perms.isFounder(promoted)).toBe(false);
  });

  it('returns false for plain users', () => {
    const plain = seedUser(env.repos, '999002');
    expect(perms.isFounder(plain)).toBe(false);
  });

  it('returns false for banned users even if their id is in ADMIN_IDS', () => {
    const banned = seedUser(env.repos, '9999999', 'super_admin', true);
    expect(perms.isFounder(banned)).toBe(false);
  });
});

describe('permission.service — isModerator', () => {
  it('returns true for super_admin', () => {
    const sysAdmin = seedUser(env.repos, '940', 'super_admin');
    expect(perms.isModerator(sysAdmin)).toBe(true);
  });

  it('returns true for users who own at least one managed bot', () => {
    const owner = seedUser(env.repos, '950');
    seedBot(env.repos, owner.id, 'personal_public');
    expect(perms.isModerator(owner)).toBe(true);
  });

  it('returns false for plain users with no bots', () => {
    const plain = seedUser(env.repos, '960');
    expect(perms.isModerator(plain)).toBe(false);
  });

  it('returns false for banned users even if they own a bot', () => {
    const banned = seedUser(env.repos, '970', 'user', true);
    seedBot(env.repos, banned.id, 'personal_public');
    expect(perms.isModerator(banned)).toBe(false);
  });

  it('does NOT mutate the caller into super_admin', () => {
    // Sanity check: nothing in the moderator gate should escalate role.
    const owner = seedUser(env.repos, '980');
    seedBot(env.repos, owner.id, 'personal_public');
    perms.isModerator(owner);
    const refreshed = env.repos.users.findById(owner.id);
    expect(refreshed?.role).toBe('user');
  });
});
