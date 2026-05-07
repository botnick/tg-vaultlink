/**
 * Tests for {@link ReportService} — the abuse / takedown queue. Auto-lock
 * behaviour, validation, and status transitions are exercised against the
 * shared in-memory DB so triggering the threshold actually flips
 * `files.is_locked` (or `collections.is_locked`) on the underlying row and
 * the audit log captures the synthetic actor entry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/services/audit.service.js';
import { FileService } from '../src/services/file.service.js';
import { ReportService } from '../src/services/report.service.js';
import { ShareService } from '../src/services/share.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import { REPORT_REASON_MAX_LENGTH } from '../src/config/constants.js';
import { buildTestEnv, seedBot, seedUser, type TestEnv } from './helpers/testDb.js';

import type { CollectionRow, FileRow, ManagedBotRow, UserRow } from '../src/types/index.js';

let env: TestEnv;
let audit: AuditService;
let files: FileService;
let share: ShareService;
let reports: ReportService;
let owner: UserRow;
let reporter: UserRow;
let bot: ManagedBotRow;
let file: FileRow;

async function freshEnv(overrides: Partial<Parameters<typeof buildTestEnv>[0]> = {}) {
  env = buildTestEnv({
    AUTO_LOCK_REPORT_THRESHOLD: 3,
    ENABLE_REPORTS: true,
    ENABLE_COLLECTIONS: true,
    MAX_FILE_SIZE_MB: 50,
    BLOCKED_EXTENSIONS: [],
    CODE_LENGTH: 12,
    ...overrides,
  });
  audit = new AuditService(env.repos.audit);
  files = new FileService(env.repos.files, env.repos.bots, audit, env.config);
  share = new ShareService({
    files: env.repos.files,
    bots: env.repos.bots,
    collections: env.repos.collections,
    drafts: env.repos.collectionDrafts,
    audit,
    config: env.config,
  });
  reports = new ReportService(
    env.repos.reports,
    env.repos.files,
    env.repos.collections,
    audit,
    env.config,
  );

  owner = seedUser(env.repos, '2001');
  reporter = seedUser(env.repos, '2002');
  bot = seedBot(env.repos, owner.id, 'main_public', { username: 'reportbot' });
  const upload = await files.upload({
    user: owner,
    bot,
    meta: {
      file_type: 'document',
      telegram_file_id: 'tg-rep-1',
      telegram_file_unique_id: 'tg-rep-1u',
      file_name: 'doc.txt',
      mime_type: 'text/plain',
      size_bytes: 64,
      caption: null,
    },
  });
  file = upload.file;
}

function fileTarget(f: FileRow) {
  return { type: 'file' as const, file: f };
}

function collectionTarget(c: CollectionRow) {
  return { type: 'collection' as const, collection: c };
}

async function seedCollection(): Promise<CollectionRow> {
  const draft = share.createCollectionDraft(owner, bot);
  share.addItemToDraft(draft, {
    file_type: 'photo',
    telegram_file_id: 'tg-coll-1',
    telegram_file_unique_id: 'tg-coll-1u',
    file_name: 'p.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 64,
    caption: null,
  });
  const finished = await share.finishCollection(draft, owner);
  return finished.collection;
}

beforeEach(async () => {
  await freshEnv();
});

afterEach(() => {
  env.close();
});

function expectAppError(op: () => unknown, code: ErrorCode): AppError {
  try {
    op();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const ae = err as AppError;
    expect(ae.code).toBe(code);
    return ae;
  }
  throw new Error(`expected AppError(${code}) but call returned cleanly`);
}

/**
 * Submit `n` reports against the seeded `file` from a rotating set of
 * fresh reporter users so the per-reporter rate limiter (if any) cannot
 * mask the auto-lock threshold under test.
 */
function submitN(n: number): Array<ReturnType<ReportService['submit']>> {
  const out: Array<ReturnType<ReportService['submit']>> = [];
  for (let i = 0; i < n; i++) {
    const r = seedUser(env.repos, `9${1000 + i}`);
    out.push(reports.submit({ reporter: r, target: fileTarget(file), reason: `abuse #${i + 1}` }));
  }
  return out;
}

describe('report.service — submit', () => {
  it('creates a pending report and returns autoLocked=false below the threshold', () => {
    const result = reports.submit({ reporter, target: fileTarget(file), reason: 'spam' });
    expect(result.report.status).toBe('pending');
    expect(result.report.target_type).toBe('file');
    expect(result.report.target_id).toBe(file.id);
    expect(result.autoLocked).toBe(false);
  });

  it('does not auto-lock at threshold-1 reports', () => {
    const results = submitN(env.config.AUTO_LOCK_REPORT_THRESHOLD - 1);
    expect(results.every((r) => r.autoLocked === false)).toBe(true);

    const fresh = env.repos.files.findById(file.id)!;
    expect(fresh.is_locked).toBe(0);
  });

  it('auto-locks the file once the report count reaches the threshold', () => {
    const results = submitN(env.config.AUTO_LOCK_REPORT_THRESHOLD);

    const last = results[results.length - 1]!;
    expect(last.autoLocked).toBe(true);

    const locked = env.repos.files.findById(file.id)!;
    expect(locked.is_locked).toBe(1);

    const auditRows = env.repos.audit.list({
      action: 'file.auto_locked',
      limit: 10,
      offset: 0,
    });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]!.target_id).toBe(String(file.id));
  });

  it('reports a collection target and persists target_type/target_id', async () => {
    const collection = await seedCollection();
    const result = reports.submit({
      reporter,
      target: collectionTarget(collection),
      reason: 'spam in collection',
    });
    expect(result.report.target_type).toBe('collection');
    expect(result.report.target_id).toBe(collection.id);
    expect(result.autoLocked).toBe(false);
  });

  it('auto-locks a collection once the report count reaches the threshold', async () => {
    const collection = await seedCollection();
    const threshold = env.config.AUTO_LOCK_REPORT_THRESHOLD;
    const results: Array<ReturnType<ReportService['submit']>> = [];
    for (let i = 0; i < threshold; i++) {
      const r = seedUser(env.repos, `7${1000 + i}`);
      results.push(
        reports.submit({
          reporter: r,
          target: collectionTarget(collection),
          reason: `bad #${i + 1}`,
        }),
      );
    }
    const last = results[results.length - 1]!;
    expect(last.autoLocked).toBe(true);

    const lockedCollection = env.repos.collections.findById(collection.id)!;
    expect(lockedCollection.is_locked).toBe(1);

    const auditRows = env.repos.audit.list({
      action: 'collection.auto_locked',
      limit: 10,
      offset: 0,
    });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]!.target_id).toBe(String(collection.id));
  });
});

describe('report.service — feature flag', () => {
  it('throws FEATURE_DISABLED when ENABLE_REPORTS=false', async () => {
    env.close();
    await freshEnv({ ENABLE_REPORTS: false });

    expectAppError(
      () => reports.submit({ reporter, target: fileTarget(file), reason: 'spam' }),
      ErrorCode.FEATURE_DISABLED,
    );
  });
});

describe('report.service — input validation', () => {
  it('rejects an empty reason with INVALID_INPUT', () => {
    expectAppError(
      () => reports.submit({ reporter, target: fileTarget(file), reason: '' }),
      ErrorCode.INVALID_INPUT,
    );
  });

  it('rejects whitespace-only reason with INVALID_INPUT', () => {
    expectAppError(
      () => reports.submit({ reporter, target: fileTarget(file), reason: '   ' }),
      ErrorCode.INVALID_INPUT,
    );
  });

  it('truncates reasons longer than REPORT_REASON_MAX_LENGTH to the cap', () => {
    // The service collapses + caps reason length in-place rather than rejecting
    // — keeping a moderator-supplied note from blowing past the column cap is
    // a UX win, and the truncation is one-shot so callers can't keep stuffing
    // longer prefixes through a retry loop.
    const oversize = 'x'.repeat(REPORT_REASON_MAX_LENGTH + 50);
    const result = reports.submit({ reporter, target: fileTarget(file), reason: oversize });
    expect(result.report.reason.length).toBeLessThanOrEqual(REPORT_REASON_MAX_LENGTH);
  });
});

describe('report.service — listing & status transitions', () => {
  it('listPending returns submitted reports and countPending tracks them', () => {
    reports.submit({ reporter, target: fileTarget(file), reason: 'r1' });
    reports.submit({
      reporter: seedUser(env.repos, '8001'),
      target: fileTarget(file),
      reason: 'r2',
    });

    const pending = reports.listPending(50, 0);
    expect(pending.length).toBe(2);
    expect(reports.countPending()).toBe(2);
  });

  it('setStatus transitions a report to "reviewed" and the row reflects it', () => {
    const submitted = reports.submit({ reporter, target: fileTarget(file), reason: 'r1' });

    const updated = reports.setStatus(submitted.report, 'reviewed', owner);
    expect(updated.status).toBe('reviewed');
    expect(updated.id).toBe(submitted.report.id);
  });

  it('countPending decrements when a report leaves the pending bucket', () => {
    const a = reports.submit({ reporter, target: fileTarget(file), reason: 'r1' });
    reports.submit({
      reporter: seedUser(env.repos, '8101'),
      target: fileTarget(file),
      reason: 'r2',
    });
    expect(reports.countPending()).toBe(2);

    reports.setStatus(a.report, 'dismissed', owner);
    expect(reports.countPending()).toBe(1);
  });

  it('listPendingForBots returns reports for files AND collections owned by the bots', async () => {
    const collection = await seedCollection();
    reports.submit({ reporter, target: fileTarget(file), reason: 'file abuse' });
    reports.submit({
      reporter: seedUser(env.repos, '8201'),
      target: collectionTarget(collection),
      reason: 'collection abuse',
    });

    const list = reports.listPendingForBots([bot.id], 50, 0);
    expect(list.length).toBe(2);
    expect(list.some((r) => r.target_type === 'file' && r.target_id === file.id)).toBe(true);
    expect(list.some((r) => r.target_type === 'collection' && r.target_id === collection.id)).toBe(
      true,
    );
    expect(reports.countPendingForBots([bot.id])).toBe(2);
  });
});
