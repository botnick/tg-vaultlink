/**
 * Anti-farming defense — exercises the 4 layers in CreditService.rewardReferral.
 *
 * Scenarios mirror the canonical attack: A creates many codes, B opens
 * all of them. Each layer should silently prevent the reward without
 * blocking the redemption itself, and every skip should produce a
 * matching audit row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import {
  CREDIT_SETTING_KEYS,
  CreditService,
} from '../src/services/credit.service.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import { SettingsService } from '../src/services/settings.service.js';
import { AuditService } from '../src/services/audit.service.js';

let env: TestEnv;
let credits: CreditRepository;
let svc: CreditService;
let settings: SettingsService;

function countAction(action: string): number {
  const row = env.db
    .prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?')
    .get(action) as { n: number };
  return row.n;
}

function buildSvc() {
  settings = new SettingsService(env.repos.settings);
  const audit = new AuditService(env.repos.audit);
  credits = new CreditRepository(env.db);
  svc = new CreditService({
    credits,
    users: env.repos.users,
    settings,
    audit,
    config: env.config,
  });
}

beforeEach(() => {
  env = buildTestEnv({ ENABLE_CREDITS: true });
  buildSvc();
});

afterEach(() => {
  env.close();
});

describe('Anti-farming — pair lifetime cap', () => {
  it('blocks the canonical "A creates 100 codes, B opens all" attack', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 5);
    // No velocity or quarantine in this test — isolate the pair cap.
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralRedeemerMinAgeMinutes, 0);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002');

    // B opens 100 of A's codes. Only the first 5 should reward A.
    let granted = 0;
    let blocked = 0;
    for (let i = 0; i < 100; i++) {
      const r = svc.rewardReferral({
        creatorUserId: a.id,
        redeemerUserId: b.id,
        referenceType: 'file',
        referenceId: 1000 + i,
      });
      if (r.granted) granted++;
      else if (r.reason === 'pair_lifetime_cap') blocked++;
    }

    expect(granted).toBe(5);
    expect(blocked).toBe(95);
    expect(credits.getBalance(a.id)).toBe(5);
    expect(countAction('credits.referral_pair_capped')).toBe(95);
  });

  it('different redeemers each get their own quota', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 2);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002');
    const c = seedUser(env.repos, '1003');

    // B exhausts pair cap with A.
    svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: 1 });
    svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: 2 });
    const blockedR = svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: 3 });
    expect(blockedR.granted).toBe(false);

    // C is a different redeemer — should still earn A.
    const c1 = svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: c.id, referenceType: 'file', referenceId: 4 });
    expect(c1.granted).toBe(true);
    expect(credits.getBalance(a.id)).toBe(3); // 2 from B + 1 from C
  });

  it('cap = 0 means the pair-lifetime layer is disabled', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002');

    for (let i = 0; i < 50; i++) {
      svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: i });
    }
    expect(credits.getBalance(a.id)).toBe(50);
    expect(countAction('credits.referral_pair_capped')).toBe(0);
  });
});

describe('Anti-farming — velocity window', () => {
  it('blocks burst attacks within the window', () => {
    // Disable lifetime cap to isolate velocity.
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 15);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMax, 3);
    settings.setNumber(CREDIT_SETTING_KEYS.referralRedeemerMinAgeMinutes, 0);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002');

    // First 3 inside the window should pass.
    for (let i = 0; i < 3; i++) {
      const r = svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: i });
      expect(r.granted).toBe(true);
    }
    // 4th should be blocked by velocity.
    const blocked = svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: 4 });
    expect(blocked.granted).toBe(false);
    expect(blocked.reason).toBe('pair_velocity');
    expect(countAction('credits.referral_velocity_blocked')).toBe(1);
  });
});

describe('Anti-farming — redeemer quarantine', () => {
  it('rejects rewards when the redeemer account is too new', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralRedeemerMinAgeMinutes, 60);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002'); // created right now → < 60 min old

    const r = svc.rewardReferral({
      creatorUserId: a.id,
      redeemerUserId: b.id,
      referenceType: 'file',
      referenceId: 1,
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toBe('redeemer_too_new');
    expect(credits.getBalance(a.id)).toBe(0);
    expect(countAction('credits.referral_redeemer_too_new')).toBe(1);
  });

  it('passes when the redeemer is older than the threshold', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralRedeemerMinAgeMinutes, 60);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002');
    // Forge an old created_at: 2h ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    env.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(twoHoursAgo, b.id);

    const r = svc.rewardReferral({
      creatorUserId: a.id,
      redeemerUserId: b.id,
      referenceType: 'file',
      referenceId: 1,
    });
    expect(r.granted).toBe(true);
  });
});

describe('Anti-farming — referralPairStats', () => {
  it('reports lifetime / today / window counts plus active caps', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 5);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 15);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMax, 2);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '1002');

    // Earn 2 today (which fills the velocity window).
    for (let i = 0; i < 2; i++) {
      svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: b.id, referenceType: 'file', referenceId: i });
    }

    const stats = svc.referralPairStats(a.id, b.id);
    expect(stats.lifetime).toBe(2);
    expect(stats.today).toBe(2);
    expect(stats.inWindow).toBe(2);
    expect(stats.pairLifetimeCap).toBe(5);
    expect(stats.pairWindowMax).toBe(2);
  });
});

describe('Anti-farming — layered defense ordering', () => {
  it('dailyCap still applies when other layers are off', () => {
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralRedeemerMinAgeMinutes, 0);
    settings.setNumber(CREDIT_SETTING_KEYS.referralDailyCap, 3);

    const a = seedUser(env.repos, '1001');
    const b = seedUser(env.repos, '2001');
    const c = seedUser(env.repos, '3001');

    // Different redeemers so pair cap (off anyway) wouldn't matter.
    let granted = 0;
    for (let i = 0; i < 5; i++) {
      const redeemer = i % 2 === 0 ? b.id : c.id;
      const r = svc.rewardReferral({ creatorUserId: a.id, redeemerUserId: redeemer, referenceType: 'file', referenceId: i });
      if (r.granted) granted++;
    }
    expect(granted).toBe(3);
    expect(credits.getBalance(a.id)).toBe(3);
  });
});
