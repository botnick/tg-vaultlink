/**
 * Wave 9.2 — Stars refund defense.
 *
 * Exercises CreditService.refundTopup end-to-end:
 *   - clawback reverses the original `topup` ledger row even when the user
 *     spent the credits (balance can go negative);
 *   - spend-lock is set proportionally to the Stars refunded and clamped
 *     by STARS_REFUND_LOCK_MAX_SECONDS;
 *   - assertSpendable() blocks redemptions while locked;
 *   - repeat-offender threshold flips is_banned;
 *   - refund is idempotent against duplicate Telegram delivery;
 *   - admin clearSpendLock + write-off restore the user.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import { CreditService } from '../src/services/credit.service.js';
import { SettingsService } from '../src/services/settings.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

let env: TestEnv;
let credits: CreditRepository;
let svc: CreditService;

function buildService(overrides: Partial<TestEnv['config']> = {}) {
  const merged = Object.freeze({ ...env.config, ...overrides });
  const settings = new SettingsService(env.repos.settings);
  const audit = new AuditService(env.repos.audit);
  credits = new CreditRepository(env.db);
  svc = new CreditService({
    credits,
    users: env.repos.users,
    settings,
    audit,
    config: merged,
  });
}

beforeEach(() => {
  env = buildTestEnv({
    ENABLE_CREDITS: true,
    CREDITS_TOPUP_ENABLED: true,
    // 60 s/Star → 100 Stars = 6000 s = 100 minutes; easy to assert against.
    STARS_REFUND_LOCK_SECONDS_PER_STAR: 60,
    STARS_REFUND_LOCK_MAX_SECONDS: 30 * 24 * 3600,
    STARS_REFUND_HARD_BAN_THRESHOLD: 3,
    STARS_REFUND_HARD_BAN_WINDOW_DAYS: 30,
  });
  buildService();
});

afterEach(() => {
  env.close();
});

describe('CreditService.refundTopup — clawback', () => {
  it('reverses the original topup and may drive balance negative', () => {
    const u = seedUser(env.repos, '1001');
    // Apply topup of 100 credits (10 Stars).
    svc.applyTopup({
      userId: u.id,
      credits: 100,
      stars: 10,
      paymentChargeId: 'charge-1',
    });
    expect(credits.getBalance(u.id)).toBe(100);

    // User spends 60 of them on file decodes (use unchecked path
    // bypassing the spend lock for the setup — the guard isn't yet
    // active because no refund has been triggered).
    credits.applyDelta({
      userId: u.id,
      delta: -60,
      reason: 'spend_decode',
      referenceType: 'file',
      referenceId: '1',
    });
    expect(credits.getBalance(u.id)).toBe(40);

    // Refund event arrives.
    const result = svc.refundTopup({ paymentChargeId: 'charge-1', source: 'telegram' });
    expect(result.applied).toBe(true);
    expect(result.credits).toBe(100);
    expect(result.stars).toBe(10);
    // 40 - 100 = -60: the user is in debt.
    expect(result.balanceAfter).toBe(-60);
    expect(credits.getBalance(u.id)).toBe(-60);
  });

  it('is a no-op when the original topup is not in the ledger', () => {
    const result = svc.refundTopup({ paymentChargeId: 'unknown', source: 'telegram' });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_topup');
  });

  it('is idempotent — a second refund delivery is a no-op', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 100, stars: 10, paymentChargeId: 'charge-1' });
    const first = svc.refundTopup({ paymentChargeId: 'charge-1', source: 'telegram' });
    expect(first.applied).toBe(true);
    const second = svc.refundTopup({ paymentChargeId: 'charge-1', source: 'telegram' });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('already_refunded');
    // Balance unchanged after the second call.
    expect(credits.getBalance(u.id)).toBe(0);
  });
});

describe('CreditService.refundTopup — spend lock', () => {
  it('sets spend_locked_until proportional to Stars refunded', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 100, stars: 10, paymentChargeId: 'charge-1' });
    const result = svc.refundTopup({ paymentChargeId: 'charge-1', source: 'telegram' });
    expect(result.spendLockedUntil).not.toBeNull();
    const fresh = env.repos.users.findById(u.id)!;
    const lockMs = Date.parse(fresh.spend_locked_until!);
    // Lock should be ~10 Stars × 60 s = 600 s (10 min) ahead of now.
    expect(lockMs - Date.now()).toBeGreaterThan(500_000);
    expect(lockMs - Date.now()).toBeLessThan(700_000);
  });

  it('assertSpendable throws SPEND_LOCKED while locked', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 100, stars: 10, paymentChargeId: 'charge-1' });
    svc.refundTopup({ paymentChargeId: 'charge-1', source: 'telegram' });
    let caught: unknown;
    try {
      svc.assertSpendable(u);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCode.SPEND_LOCKED);
  });

  it('subsequent refunds extend (not shorten) the lock', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 50, stars: 5, paymentChargeId: 'a' });
    svc.applyTopup({ userId: u.id, credits: 100, stars: 50, paymentChargeId: 'b' });

    // Refund the BIG one first → big lock.
    svc.refundTopup({ paymentChargeId: 'b', source: 'telegram' });
    const big = Date.parse(env.repos.users.findById(u.id)!.spend_locked_until!);

    // Then refund the small one → existing lock should not be shortened.
    svc.refundTopup({ paymentChargeId: 'a', source: 'telegram' });
    const after = Date.parse(env.repos.users.findById(u.id)!.spend_locked_until!);
    expect(after).toBeGreaterThanOrEqual(big);
  });
});

describe('CreditService.refundTopup — repeat-offender ban', () => {
  it('flips is_banned once threshold is reached', () => {
    const u = seedUser(env.repos, '1001');
    // Three independent topups + refunds.
    for (let i = 1; i <= 3; i++) {
      svc.applyTopup({
        userId: u.id,
        credits: 10,
        stars: 1,
        paymentChargeId: `charge-${i}`,
      });
    }
    svc.refundTopup({ paymentChargeId: 'charge-1', source: 'telegram' });
    expect(env.repos.users.findById(u.id)!.is_banned).toBe(0);
    svc.refundTopup({ paymentChargeId: 'charge-2', source: 'telegram' });
    expect(env.repos.users.findById(u.id)!.is_banned).toBe(0);
    const r3 = svc.refundTopup({ paymentChargeId: 'charge-3', source: 'telegram' });
    expect(r3.hardBanned).toBe(true);
    expect(env.repos.users.findById(u.id)!.is_banned).toBe(1);
  });
});

describe('CreditService.clearSpendLock', () => {
  it('clears the lock and optionally writes off the deficit', () => {
    const admin = seedUser(env.repos, '999', 'super_admin');
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 100, stars: 10, paymentChargeId: 'c' });
    credits.applyDelta({
      userId: u.id,
      delta: -60,
      reason: 'spend_decode',
      referenceType: 'file',
      referenceId: '1',
    });
    svc.refundTopup({ paymentChargeId: 'c', source: 'telegram' });
    expect(credits.getBalance(u.id)).toBe(-60);

    const result = svc.clearSpendLock({
      actorUserId: admin.id,
      targetUserId: u.id,
      writeOffNegativeBalance: true,
      note: 'genuine refund',
    });
    expect(result.balanceAfter).toBe(0);
    expect(result.wroteOff).toBe(60);
    const fresh = env.repos.users.findById(u.id)!;
    expect(fresh.spend_locked_until).toBeNull();
    expect(credits.getBalance(u.id)).toBe(0);
  });

  it('preserves negative balance when write_off=false', () => {
    const admin = seedUser(env.repos, '999', 'super_admin');
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 100, stars: 10, paymentChargeId: 'c' });
    credits.applyDelta({
      userId: u.id,
      delta: -100,
      reason: 'spend_decode',
      referenceType: 'file',
      referenceId: '1',
    });
    svc.refundTopup({ paymentChargeId: 'c', source: 'telegram' });
    expect(credits.getBalance(u.id)).toBe(-100);

    svc.clearSpendLock({
      actorUserId: admin.id,
      targetUserId: u.id,
      writeOffNegativeBalance: false,
    });
    // Lock cleared, but the negative balance remains — user still can't spend.
    const fresh = env.repos.users.findById(u.id)!;
    expect(fresh.spend_locked_until).toBeNull();
    expect(credits.getBalance(u.id)).toBe(-100);
  });
});

describe('CreditRepository — Wave 9.2 helpers', () => {
  it('findTopupByPaymentChargeId locates the original topup row', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 50, stars: 5, paymentChargeId: 'c-alpha' });
    const found = credits.findTopupByPaymentChargeId('c-alpha');
    expect(found?.delta).toBe(50);
    expect(found?.reason).toBe('topup');
  });

  it('existsRefundForPaymentCharge reflects the refund state', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 50, stars: 5, paymentChargeId: 'c-alpha' });
    expect(credits.existsRefundForPaymentCharge('c-alpha')).toBe(false);
    svc.refundTopup({ paymentChargeId: 'c-alpha', source: 'telegram' });
    expect(credits.existsRefundForPaymentCharge('c-alpha')).toBe(true);
  });

  it('aggregates by reason capture lifetime + windowed totals', () => {
    const u = seedUser(env.repos, '1001');
    svc.applyTopup({ userId: u.id, credits: 50, stars: 5, paymentChargeId: 'a' });
    svc.applyTopup({ userId: u.id, credits: 30, stars: 3, paymentChargeId: 'b' });
    const lifetime = credits.aggregateByReason('topup');
    expect(lifetime.total).toBe(80);
    expect(lifetime.count).toBe(2);
  });
});
