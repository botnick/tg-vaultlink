/**
 * CreditService — policy + cost resolution + signup bonus + referral cap
 * + admin adjust + topup. Tests at the service layer go through the
 * settings table (so cost overrides actually flow through) but stub
 * AuditService since audit-log row contents are checked indirectly via
 * the ledger inspection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import {
  CREDIT_SETTING_KEYS,
  CreditService,
  costDecodeKeyForType,
} from '../src/services/credit.service.js';
import { SettingsService } from '../src/services/settings.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

let env: TestEnv;
let credits: CreditRepository;
let svc: CreditService;
let settings: SettingsService;

function buildService(overrides: Partial<TestEnv['config']> = {}) {
  const merged = Object.freeze({ ...env.config, ...overrides });
  settings = new SettingsService(env.repos.settings);
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
  env = buildTestEnv({ ENABLE_CREDITS: true });
  buildService();
});

afterEach(() => {
  env.close();
});

describe('CreditService — feature toggles', () => {
  it('reads enabled flag from settings, falling back to env', () => {
    expect(svc.isEnabled()).toBe(true);
    settings.setBoolean(CREDIT_SETTING_KEYS.enabled, false);
    expect(svc.isEnabled()).toBe(false);
    settings.delete(CREDIT_SETTING_KEYS.enabled);
    expect(svc.isEnabled()).toBe(true); // back to env default
  });
});

describe('CreditService — costFor', () => {
  it('falls back to env defaults when nothing is configured', () => {
    expect(svc.costFor('decode')).toBe(1);
    expect(svc.costFor('collection_open')).toBe(1);
    expect(svc.costFor('collection_send', { itemCount: 0 })).toBe(1);
  });

  it('honors per-action overrides', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.costDecode, 3);
    settings.setNumber(CREDIT_SETTING_KEYS.costCollectionOpen, 5);
    expect(svc.costFor('decode')).toBe(3);
    expect(svc.costFor('collection_open')).toBe(5);
  });

  it('honors per-file-type overrides over the base cost', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.costDecode, 1);
    settings.setNumber(costDecodeKeyForType('video'), 5);
    expect(svc.costFor('decode', { fileType: 'video' })).toBe(5);
    expect(svc.costFor('decode', { fileType: 'photo' })).toBe(1);
  });

  it('per-item bulk surcharge adds to the base send cost', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.costCollectionSend, 2);
    settings.setNumber(CREDIT_SETTING_KEYS.costCollectionPerItem, 1);
    expect(svc.costFor('collection_send', { itemCount: 0 })).toBe(2);
    expect(svc.costFor('collection_send', { itemCount: 5 })).toBe(7);
  });
});

describe('CreditService — ensureSignupBonus', () => {
  it('grants the bonus exactly once', () => {
    const user = seedUser(env.repos, '1001');
    const after1 = svc.ensureSignupBonus(user);
    expect(after1.credits_initialized).toBe(1);
    expect(credits.getBalance(user.id)).toBe(10);

    // Spend down to zero.
    credits.applyDelta({ userId: user.id, delta: -10, reason: 'spend_decode' });
    expect(credits.getBalance(user.id)).toBe(0);

    // Second call must not regrant.
    const after2 = svc.ensureSignupBonus(after1);
    expect(after2.credits_initialized).toBe(1);
    expect(credits.getBalance(user.id)).toBe(0);
  });

  it('is a no-op when the system is disabled', () => {
    settings.setBoolean(CREDIT_SETTING_KEYS.enabled, false);
    const user = seedUser(env.repos, '1001');
    svc.ensureSignupBonus(user);
    expect(credits.getBalance(user.id)).toBe(0);
    expect(env.repos.users.findById(user.id)?.credits_initialized).toBe(0);
  });

  it('marks initialized but grants nothing when bonus amount is 0', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.signupBonus, 0);
    const user = seedUser(env.repos, '1001');
    const updated = svc.ensureSignupBonus(user);
    expect(updated.credits_initialized).toBe(1);
    expect(credits.getBalance(user.id)).toBe(0);
  });
});

describe('CreditService — chargeForRedemption', () => {
  function setupUser(initialCredits = 5) {
    const user = seedUser(env.repos, '1001');
    if (initialCredits > 0) {
      credits.applyDelta({
        userId: user.id,
        delta: initialCredits,
        reason: 'signup_bonus',
      });
    }
    return env.repos.users.findById(user.id)!;
  }

  it('returns a no-op receipt when the system is disabled', () => {
    settings.setBoolean(CREDIT_SETTING_KEYS.enabled, false);
    const user = setupUser();
    const receipt = svc.chargeForRedemption({
      user,
      kind: 'decode',
      referenceType: 'file',
      referenceId: 1,
    });
    expect(receipt.charged).toBe(false);
    expect(receipt.reason).toBe('disabled');
    expect(credits.getBalance(user.id)).toBe(5);
  });

  it('owner-bypass returns a no-op receipt without touching the ledger', () => {
    const user = setupUser();
    const receipt = svc.chargeForRedemption({
      user,
      kind: 'decode',
      referenceType: 'file',
      referenceId: 99,
      ownerUserId: user.id,
    });
    expect(receipt.charged).toBe(false);
    expect(receipt.reason).toBe('owner_bypass');
    expect(credits.getBalance(user.id)).toBe(5);
  });

  it('admin-bypass returns a no-op receipt', () => {
    const user = setupUser();
    const receipt = svc.chargeForRedemption({
      user,
      kind: 'decode',
      referenceType: 'file',
      referenceId: 99,
      isAdmin: true,
    });
    expect(receipt.charged).toBe(false);
    expect(receipt.reason).toBe('admin_bypass');
  });

  it('charges the user and writes a ledger row on a normal redemption', () => {
    const user = setupUser();
    const receipt = svc.chargeForRedemption({
      user,
      kind: 'decode',
      referenceType: 'file',
      referenceId: 99,
      ownerUserId: 222, // someone else owns it
    });
    expect(receipt.charged).toBe(true);
    expect(receipt.amount).toBe(1);
    expect(receipt.balanceAfter).toBe(4);
    expect(credits.getBalance(user.id)).toBe(4);
  });

  it('throws INSUFFICIENT_CREDITS when balance is too low', () => {
    const user = setupUser(0);
    let caught: unknown;
    try {
      svc.chargeForRedemption({
        user,
        kind: 'decode',
        referenceType: 'file',
        referenceId: 99,
        ownerUserId: 222,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCode.INSUFFICIENT_CREDITS);
  });

  it('refund() restores the balance and writes a refund ledger row', () => {
    const user = setupUser();
    const receipt = svc.chargeForRedemption({
      user,
      kind: 'decode',
      referenceType: 'file',
      referenceId: 99,
      ownerUserId: 222,
    });
    svc.refund(receipt, 'simulated delivery failure');
    expect(credits.getBalance(user.id)).toBe(5);
    const tx = credits.listByUser(user.id, 50, 0);
    // newest-first: refund, spend, signup
    expect(tx.map((r) => r.reason)).toEqual([
      'refund',
      'spend_decode',
      'signup_bonus',
    ]);
  });

  it('refund() is a no-op for un-charged receipts', () => {
    const user = setupUser();
    settings.setBoolean(CREDIT_SETTING_KEYS.enabled, false);
    const receipt = svc.chargeForRedemption({
      user,
      kind: 'decode',
      referenceType: 'file',
      referenceId: 99,
    });
    svc.refund(receipt);
    expect(credits.getBalance(user.id)).toBe(5);
  });
});

describe('CreditService — rewardReferral', () => {
  it('credits the creator when redeemer is a different user', () => {
    const creator = seedUser(env.repos, '1001');
    const redeemer = seedUser(env.repos, '1002');
    const r = svc.rewardReferral({
      creatorUserId: creator.id,
      redeemerUserId: redeemer.id,
      referenceType: 'file',
      referenceId: 7,
    });
    expect(r.granted).toBe(true);
    expect(r.amount).toBe(1);
    expect(credits.getBalance(creator.id)).toBe(1);
  });

  it('skips when reward amount is zero (still counted as disabled)', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralReward, 0);
    const creator = seedUser(env.repos, '1001');
    const redeemer = seedUser(env.repos, '1002');
    const r = svc.rewardReferral({
      creatorUserId: creator.id,
      redeemerUserId: redeemer.id,
      referenceType: 'file',
      referenceId: 7,
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toBe('zero');
  });

  it('skips when creator === redeemer (own-code redemption)', () => {
    const user = seedUser(env.repos, '1001');
    const r = svc.rewardReferral({
      creatorUserId: user.id,
      redeemerUserId: user.id,
      referenceType: 'file',
      referenceId: 7,
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toBe('self');
  });

  it('skips when referral is disabled', () => {
    settings.setBoolean(CREDIT_SETTING_KEYS.referralEnabled, false);
    const creator = seedUser(env.repos, '1001');
    const redeemer = seedUser(env.repos, '1002');
    const r = svc.rewardReferral({
      creatorUserId: creator.id,
      redeemerUserId: redeemer.id,
      referenceType: 'file',
      referenceId: 7,
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(credits.getBalance(creator.id)).toBe(0);
  });

  it('honors the daily cap', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralDailyCap, 2);
    // Isolate the daily cap from the anti-farming layers added later.
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);
    const creator = seedUser(env.repos, '1001');
    const redeemer = seedUser(env.repos, '2001');
    const r1 = svc.rewardReferral({
      creatorUserId: creator.id,
      redeemerUserId: redeemer.id,
      referenceType: 'file',
      referenceId: 1,
    });
    const r2 = svc.rewardReferral({
      creatorUserId: creator.id,
      redeemerUserId: redeemer.id,
      referenceType: 'file',
      referenceId: 2,
    });
    const r3 = svc.rewardReferral({
      creatorUserId: creator.id,
      redeemerUserId: redeemer.id,
      referenceType: 'file',
      referenceId: 3,
    });
    expect(r1.granted).toBe(true);
    expect(r2.granted).toBe(true);
    expect(r3.granted).toBe(false);
    expect(r3.reason).toBe('capped');
    expect(credits.getBalance(creator.id)).toBe(2);
  });

  it('cap=0 means unlimited', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralDailyCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);
    const creator = seedUser(env.repos, '1001');
    const redeemer = seedUser(env.repos, '2001');
    for (let i = 0; i < 5; i++) {
      svc.rewardReferral({
        creatorUserId: creator.id,
        redeemerUserId: redeemer.id,
        referenceType: 'file',
        referenceId: i,
      });
    }
    expect(credits.getBalance(creator.id)).toBe(5);
  });
});

describe('CreditService — adminAdjust + adminSet', () => {
  it('adminAdjust grants positive deltas', () => {
    const admin = seedUser(env.repos, '9999', 'super_admin');
    const user = seedUser(env.repos, '1001');
    svc.adminAdjust({
      actorUserId: admin.id,
      targetUserId: user.id,
      delta: 50,
      note: 'event reward',
    });
    expect(credits.getBalance(user.id)).toBe(50);
  });

  it('adminAdjust refuses overdraft revoke', () => {
    const admin = seedUser(env.repos, '9999', 'super_admin');
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 5, reason: 'topup' });
    expect(() =>
      svc.adminAdjust({
        actorUserId: admin.id,
        targetUserId: user.id,
        delta: -10,
      }),
    ).toThrow(AppError);
    expect(credits.getBalance(user.id)).toBe(5);
  });

  it('adminSet sets an absolute value with the right delta', () => {
    const admin = seedUser(env.repos, '9999', 'super_admin');
    const user = seedUser(env.repos, '1001');
    credits.applyDelta({ userId: user.id, delta: 20, reason: 'topup' });
    const r = svc.adminSet({
      actorUserId: admin.id,
      targetUserId: user.id,
      targetBalance: 5,
    });
    expect(r.delta).toBe(-15);
    expect(r.balanceAfter).toBe(5);
    expect(credits.getBalance(user.id)).toBe(5);
  });
});

describe('CreditService — topup', () => {
  it('applies the topup amount and writes the right ledger row', () => {
    const user = seedUser(env.repos, '1001');
    const r = svc.applyTopup({
      userId: user.id,
      credits: 100,
      stars: 10,
      paymentChargeId: 'charge_abc',
    });
    expect(r.balanceAfter).toBe(100);
    expect(r.transaction.reason).toBe('topup');
    expect(r.transaction.reference_id).toBe('charge_abc');
  });

  it('rejects non-positive credits', () => {
    const user = seedUser(env.repos, '1001');
    expect(() =>
      svc.applyTopup({ userId: user.id, credits: 0, stars: 1, paymentChargeId: 'x' }),
    ).toThrow(AppError);
  });
});

describe('CreditService — topupPackages', () => {
  it('falls back to defaults when nothing is configured', () => {
    const pkgs = svc.topupPackages();
    expect(pkgs).toHaveLength(3);
    expect(pkgs[0]).toEqual({ stars: 10, credits: 100 });
  });

  it('returns admin-configured packages', () => {
    const admin = seedUser(env.repos, '9999', 'super_admin');
    svc.setTopupPackages([{ stars: 1, credits: 1 }, { stars: 2, credits: 3 }], admin.id);
    const pkgs = svc.topupPackages();
    expect(pkgs).toEqual([
      { stars: 1, credits: 1 },
      { stars: 2, credits: 3 },
    ]);
  });

  it('rejects malformed packages on save', () => {
    const admin = seedUser(env.repos, '9999', 'super_admin');
    expect(() => svc.setTopupPackages([], admin.id)).toThrow(AppError);
    expect(() =>
      svc.setTopupPackages([{ stars: 0, credits: 1 }], admin.id),
    ).toThrow(AppError);
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    settings.setString(CREDIT_SETTING_KEYS.topupPackages, '{not json');
    const pkgs = svc.topupPackages();
    expect(pkgs).toHaveLength(3);
  });
});
