/**
 * CreditRepository — atomicity + ledger correctness.
 *
 * The repository is the lowest layer of the credit system: every higher
 * layer (CreditService, the routers) trusts that `applyDelta` is atomic
 * and that overdrafts are refused. These tests poke at those invariants
 * directly without going through CreditService so a regression there is
 * easy to localize.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

let env: TestEnv;
let credits: CreditRepository;

beforeEach(() => {
  env = buildTestEnv();
  credits = new CreditRepository(env.db);
});

afterEach(() => {
  env.close();
});

describe('CreditRepository', () => {
  it('starts users with a zero balance', () => {
    const user = seedUser(env.repos, '1001');
    expect(credits.getBalance(user.id)).toBe(0);
  });

  it('applies a positive delta and writes a ledger row', () => {
    const user = seedUser(env.repos, '1001');
    const result = credits.applyDelta({
      userId: user.id,
      delta: 5,
      reason: 'signup_bonus',
      metadata: { amount: 5 },
    });
    expect(result.balanceAfter).toBe(5);
    expect(credits.getBalance(user.id)).toBe(5);
    expect(result.transaction.delta).toBe(5);
    expect(result.transaction.reason).toBe('signup_bonus');
    expect(result.transaction.balance_after).toBe(5);
    expect(result.transaction.metadata_json).toBe(JSON.stringify({ amount: 5 }));
  });

  it('refuses an overdraft and writes nothing', () => {
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 3, reason: 'topup' });
    expect(() =>
      credits.applyDelta({
        userId: user.id,
        delta: -10,
        reason: 'spend_decode',
      }),
    ).toThrow(AppError);
    expect(credits.getBalance(user.id)).toBe(3);
    // Only the topup row should exist — the failed spend never wrote.
    const tx = credits.listByUser(user.id, 50, 0);
    expect(tx).toHaveLength(1);
    expect(tx[0]?.reason).toBe('topup');
  });

  it('throws INSUFFICIENT_CREDITS specifically on overdraft', () => {
    const user = seedUser(env.repos, '1001');
    let caught: unknown;
    try {
      credits.applyDelta({ userId: user.id, delta: -1, reason: 'spend_decode' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCode.INSUFFICIENT_CREDITS);
  });

  it('balance_after snapshots are monotonic with the running total', () => {
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 10, reason: 'signup_bonus' });
    credits.applyDelta({ userId: user.id, delta: -2, reason: 'spend_decode' });
    credits.applyDelta({ userId: user.id, delta: -1, reason: 'spend_collection_open' });
    credits.applyDelta({ userId: user.id, delta: 5, reason: 'topup' });
    const list = credits.listByUser(user.id, 50, 0);
    // listByUser is newest-first
    expect(list.map((r) => r.balance_after)).toEqual([12, 7, 8, 10]);
    expect(credits.getBalance(user.id)).toBe(12);
  });

  it('totals split positive grants from negative spends', () => {
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 10, reason: 'signup_bonus' });
    credits.applyDelta({ userId: user.id, delta: -3, reason: 'spend_decode' });
    credits.applyDelta({ userId: user.id, delta: 2, reason: 'referral_reward' });
    const t = credits.totals(user.id);
    expect(t.gained).toBe(12);
    expect(t.spent).toBe(3);
  });

  it('sumByUserAndReasonSince filters by reason and time window', () => {
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 1, reason: 'referral_reward' });
    credits.applyDelta({ userId: user.id, delta: 1, reason: 'referral_reward' });
    credits.applyDelta({ userId: user.id, delta: 5, reason: 'topup' });
    // Window starts before everything — sums all referral rows.
    expect(credits.sumByUserAndReasonSince(user.id, 'referral_reward', '1970-01-01T00:00:00.000Z')).toBe(2);
    // Topups don't show up under the referral filter.
    expect(credits.sumByUserAndReasonSince(user.id, 'topup', '1970-01-01T00:00:00.000Z')).toBe(5);
    // Window in the future — nothing matches.
    expect(credits.sumByUserAndReasonSince(user.id, 'referral_reward', '9999-01-01T00:00:00.000Z')).toBe(0);
  });

  it('setAbsoluteBalance writes one ledger row reflecting the delta', () => {
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 7, reason: 'signup_bonus' });
    const { delta, transaction } = credits.setAbsoluteBalance({
      userId: user.id,
      targetBalance: 20,
      actorUserId: 9999,
      note: 'gift',
    });
    expect(delta).toBe(13);
    expect(transaction.reason).toBe('admin_set');
    expect(transaction.balance_after).toBe(20);
    expect(credits.getBalance(user.id)).toBe(20);
  });

  it('setAbsoluteBalance refuses negative target balance', () => {
    const user = seedUser(env.repos, '1001');
    expect(() =>
      credits.setAbsoluteBalance({
        userId: user.id,
        targetBalance: -1,
        actorUserId: 9999,
      }),
    ).toThrow(AppError);
  });

  it('rejects non-integer deltas', () => {
    const user = seedUser(env.repos, '1001');
    expect(() =>
      credits.applyDelta({ userId: user.id, delta: 1.5, reason: 'topup' }),
    ).toThrow(AppError);
  });

  it('better-sqlite3 transaction serializes a sequence of debits without overdraft', () => {
    // Better-sqlite3 is synchronous, so "concurrent" really means a tight
    // loop; the writer-lock + transaction wrap ensures every step sees a
    // consistent balance. This is the core invariant the runner's
    // sequentialize() also depends on.
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 5, reason: 'signup_bonus' });

    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < 10; i++) {
      try {
        credits.applyDelta({ userId: user.id, delta: -1, reason: 'spend_decode' });
        succeeded++;
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_CREDITS) {
          failed++;
        } else {
          throw err;
        }
      }
    }
    expect(succeeded).toBe(5);
    expect(failed).toBe(5);
    expect(credits.getBalance(user.id)).toBe(0);
  });
});
