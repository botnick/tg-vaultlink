/**
 * Tests for {@link FileService} — exercises the upload + decode lifecycle
 * end-to-end against an in-memory SQLite database. Every case starts from a
 * fresh schema so persistence assertions (`download_count`, access logs,
 * soft-delete visibility) reflect only the work performed inside the case.
 *
 * The service contract is locked at:
 *   `new FileService(filesRepo, botsRepo, audit, config)`
 * and the methods exercised here are `upload`, `decode`, `softDelete`,
 * `setPassword`, `removePassword`, `setExpiry`, `setLocked`, `listByOwner`,
 * and `countByOwner`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/services/audit.service.js';
import { FileService } from '../src/services/file.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

import type { ManagedBotRow, UserRow } from '../src/types/index.js';

interface UploadMeta {
  file_type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'sticker';
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
}

function uploadMeta(overrides: Partial<UploadMeta> = {}): UploadMeta {
  return {
    file_type: 'document',
    telegram_file_id: 'tg-file-id-1',
    telegram_file_unique_id: 'tg-unique-1',
    file_name: 'note.txt',
    mime_type: 'text/plain',
    size_bytes: 1024,
    caption: null,
    ...overrides,
  };
}

let env: TestEnv;
let audit: AuditService;
let svc: FileService;
let owner: UserRow;
let bot: ManagedBotRow;

beforeEach(() => {
  env = buildTestEnv({
    MAX_FILE_SIZE_MB: 1,
    BLOCKED_EXTENSIONS: ['.exe'],
    ENABLE_PASSWORD_PROTECTION: true,
    ENABLE_FILE_EXPIRY: true,
    DEFAULT_FILE_EXPIRY_DAYS: 0,
    CODE_LENGTH: 12,
    ENABLE_REPORTS: true,
  });
  audit = new AuditService(env.repos.audit);
  svc = new FileService(env.repos.files, env.repos.bots, audit, env.config);
  owner = seedUser(env.repos, '1001');
  bot = seedBot(env.repos, owner.id, 'personal_public', { username: 'alphabot' });
});

afterEach(() => {
  env.close();
});

/** Resolve the AppError that `op` is expected to throw. */
async function expectAppError(op: () => Promise<unknown> | unknown, code: ErrorCode): Promise<AppError> {
  try {
    await op();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const ae = err as AppError;
    expect(ae.code).toBe(code);
    return ae;
  }
  throw new Error(`expected AppError(${code}) but call returned cleanly`);
}

describe('file.service — upload happy path', () => {
  it('persists the file and returns a namespaced share code + deep link', async () => {
    const result = await svc.upload({
      user: owner,
      bot,
      meta: uploadMeta(),
      visibility: 'public',
      password: null,
      expiresInDays: null,
    });

    expect(result.file.owner_user_id).toBe(owner.id);
    expect(result.file.bot_id).toBe(bot.id);
    expect(result.shareCode).toMatch(new RegExp(`^${bot.username}:[A-Z2-9]{12}$`));
    expect(result.deepLink.startsWith('https://t.me/')).toBe(true);
    expect(result.deepLink).toContain(bot.username);

    const fetched = env.repos.files.findById(result.file.id);
    expect(fetched).toBeDefined();
    expect(fetched!.code).toBe(result.file.code);
  });
});

describe('file.service — upload validation', () => {
  it('rejects files larger than MAX_FILE_SIZE_MB with FILE_TOO_LARGE', async () => {
    await expectAppError(
      () =>
        svc.upload({
          user: owner,
          bot,
          meta: uploadMeta({ size_bytes: 2 * 1024 * 1024 }),
        }),
      ErrorCode.FILE_TOO_LARGE,
    );
  });

  it('rejects blocked extensions with FILE_TYPE_BLOCKED', async () => {
    await expectAppError(
      () =>
        svc.upload({
          user: owner,
          bot,
          meta: uploadMeta({ file_name: 'malware.exe', size_bytes: 100 }),
        }),
      ErrorCode.FILE_TYPE_BLOCKED,
    );
  });

  it('accepts allowed extensions', async () => {
    const result = await svc.upload({
      user: owner,
      bot,
      meta: uploadMeta({ file_name: 'hello.png', mime_type: 'image/png', size_bytes: 256 }),
    });
    expect(result.file.file_name).toBe('hello.png');
  });
});

describe('file.service — password protection', () => {
  it('uploads with a password, rejects wrong, accepts correct', async () => {
    const up = await svc.upload({
      user: owner,
      bot,
      meta: uploadMeta(),
      password: 'secret',
    });
    expect(up.file.password_hash).not.toBeNull();

    await expectAppError(
      () =>
        svc.decode({
          user: owner,
          rawCode: up.shareCode,
          password: 'wrong',
        }),
      ErrorCode.PASSWORD_INCORRECT,
    );

    const ok = await svc.decode({
      user: owner,
      rawCode: up.shareCode,
      password: 'secret',
    });
    expect(ok.file.id).toBe(up.file.id);
    expect(ok.bot.id).toBe(bot.id);
  });

  it('decode without password on a protected file throws PASSWORD_REQUIRED', async () => {
    const up = await svc.upload({
      user: owner,
      bot,
      meta: uploadMeta(),
      password: 'secret',
    });

    await expectAppError(
      () => svc.decode({ user: owner, rawCode: up.shareCode }),
      ErrorCode.PASSWORD_REQUIRED,
    );
  });
});

describe('file.service — expiry & lifecycle gates', () => {
  it('decode on an expired file throws FILE_EXPIRED', async () => {
    const up = await svc.upload({
      user: owner,
      bot,
      meta: uploadMeta(),
      expiresInDays: 1,
    });
    env.repos.files.setExpiresAt(up.file.id, '2020-01-01T00:00:00.000Z');

    await expectAppError(
      () => svc.decode({ user: owner, rawCode: up.shareCode }),
      ErrorCode.FILE_EXPIRED,
    );
  });

  it('decode on a locked file throws FILE_LOCKED', async () => {
    const up = await svc.upload({ user: owner, bot, meta: uploadMeta() });
    svc.setLocked(up.file, true, owner);

    await expectAppError(
      () => svc.decode({ user: owner, rawCode: up.shareCode }),
      ErrorCode.FILE_LOCKED,
    );
  });

  it('decode on a soft-deleted file throws FILE_NOT_AVAILABLE', async () => {
    const up = await svc.upload({ user: owner, bot, meta: uploadMeta() });
    svc.softDelete(up.file, owner);

    await expectAppError(
      () => svc.decode({ user: owner, rawCode: up.shareCode }),
      ErrorCode.FILE_NOT_AVAILABLE,
    );
  });
});

describe('file.service — code uniqueness scoping', () => {
  it('the same code can coexist across different bots', () => {
    const otherBot = seedBot(env.repos, owner.id, 'personal_public', {
      username: 'betabot',
    });

    // Insert two files sharing a code via the repo so we can prove the
    // (bot_id, code) UNIQUE constraint scopes rather than collides.
    env.repos.files.insert({
      code: 'SHAREDCODE12',
      bot_id: bot.id,
      owner_user_id: owner.id,
      telegram_file_id: 'tg-A',
      telegram_file_unique_id: null,
      file_type: 'document',
      file_name: 'a.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      caption: null,
      visibility: 'public',
      password_hash: null,
      expires_at: null,
    });
    env.repos.files.insert({
      code: 'SHAREDCODE12',
      bot_id: otherBot.id,
      owner_user_id: owner.id,
      telegram_file_id: 'tg-B',
      telegram_file_unique_id: null,
      file_type: 'document',
      file_name: 'b.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      caption: null,
      visibility: 'public',
      password_hash: null,
      expires_at: null,
    });

    const inA = env.repos.files.findByCode(bot.id, 'SHAREDCODE12');
    const inB = env.repos.files.findByCode(otherBot.id, 'SHAREDCODE12');
    expect(inA).toBeDefined();
    expect(inB).toBeDefined();
    expect(inA!.id).not.toBe(inB!.id);
  });
});

describe('file.service — ownership listing', () => {
  it('listByOwner / countByOwner reflect persistence', async () => {
    await svc.upload({ user: owner, bot, meta: uploadMeta({ telegram_file_id: 'a' }) });
    await svc.upload({ user: owner, bot, meta: uploadMeta({ telegram_file_id: 'b' }) });
    await svc.upload({ user: owner, bot, meta: uploadMeta({ telegram_file_id: 'c' }) });

    expect(svc.countByOwner(owner)).toBe(3);
    const listed = svc.listByOwner(owner);
    expect(listed.length).toBe(3);
  });

  it('soft-deleted files are excluded from listByOwner by default', async () => {
    const a = await svc.upload({ user: owner, bot, meta: uploadMeta({ telegram_file_id: 'x' }) });
    await svc.upload({ user: owner, bot, meta: uploadMeta({ telegram_file_id: 'y' }) });

    svc.softDelete(a.file, owner);

    const listed = svc.listByOwner(owner);
    expect(listed.length).toBe(1);
    expect(listed.find((f) => f.id === a.file.id)).toBeUndefined();
  });
});

describe('file.service — decode side effects', () => {
  it('increments download_count and writes an access log row', async () => {
    const up = await svc.upload({ user: owner, bot, meta: uploadMeta() });

    const before = env.repos.files.findById(up.file.id)!;
    expect(before.download_count).toBe(0);

    await svc.decode({ user: owner, rawCode: up.shareCode });

    const after = env.repos.files.findById(up.file.id)!;
    expect(after.download_count).toBe(1);

    const logs = env.repos.files.listAccessLogs(up.file.id, 10);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.file_id).toBe(up.file.id);
  });
});

describe('file.service — password mutation helpers', () => {
  it('setPassword + removePassword toggle the hash on disk', async () => {
    const up = await svc.upload({ user: owner, bot, meta: uploadMeta() });
    expect(up.file.password_hash).toBeNull();

    const withPw = await svc.setPassword(up.file, 'hunter22', owner);
    expect(withPw.password_hash).not.toBeNull();

    const cleared = svc.removePassword(withPw, owner);
    expect(cleared.password_hash).toBeNull();
  });
});

describe('file.service — expiry helper', () => {
  it('setExpiry(null) clears the expiry, numeric days sets a future ISO timestamp', async () => {
    const up = await svc.upload({ user: owner, bot, meta: uploadMeta() });

    const expires = svc.setExpiry(up.file, 7, owner);
    expect(expires.expires_at).not.toBeNull();
    expect(Date.parse(expires.expires_at!)).toBeGreaterThan(Date.now());

    const cleared = svc.setExpiry(expires, null, owner);
    expect(cleared.expires_at).toBeNull();
  });
});
