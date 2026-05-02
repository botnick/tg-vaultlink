/**
 * Tests for {@link UserService.setRole} — the founder-only role mutator.
 *
 * Goals:
 *   - Only founders (`ADMIN_IDS`) may promote / demote.
 *   - Promoted super admins (`role='super_admin'` but NOT in ADMIN_IDS)
 *     CANNOT promote others — that's the escalation-prevention property
 *     this method exists to enforce.
 *   - Founders cannot be demoted via this method (they must be removed
 *     from `.env ADMIN_IDS` first).
 *   - Self-mutation is refused.
 *   - Promoting a banned user is refused.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { UserService } from '../src/services/user.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';

let env: TestEnv;

afterEach(() => {
  if (env) env.close();
});

/**
 * Bring up a fresh test env where `ADMIN_IDS` has been overridden to the
 * supplied list, then construct `UserService` against it. Each test calls
 * this with the founder/promoted matrix it cares about.
 */
function bootstrap(adminIds: string[]): {
  env: TestEnv;
  users: UserService;
} {
  env = buildTestEnv({ ADMIN_IDS: Object.freeze([...adminIds]) as readonly string[] });
  const users = new UserService(env.repos.users, env.config);
  return { env, users };
}

describe('user.service.setRole — founder gate', () => {
  it('a founder can promote a regular user to super_admin', () => {
    const { env: e, users } = bootstrap(['100']);
    const founder = seedUser(e.repos, '100', 'super_admin');
    const target = seedUser(e.repos, '200');
    const updated = users.setRole(target, 'super_admin', founder);
    expect(updated.role).toBe('super_admin');
  });

  it('a promoted super admin (not in ADMIN_IDS) CANNOT promote others — escalation block', () => {
    const { env: e, users } = bootstrap(['100']);
    // 'promoted' has role=super_admin but is NOT in ADMIN_IDS.
    const promoted = seedUser(e.repos, '300', 'super_admin');
    const target = seedUser(e.repos, '301');

    expect(() => users.setRole(target, 'super_admin', promoted)).toThrow(AppError);
    try {
      users.setRole(target, 'super_admin', promoted);
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
    }
  });

  it('a regular user CANNOT promote others', () => {
    const { env: e, users } = bootstrap(['100']);
    const stranger = seedUser(e.repos, '400');
    const target = seedUser(e.repos, '401');
    expect(() => users.setRole(target, 'super_admin', stranger)).toThrow(AppError);
  });

  it('refuses to demote a founder (must remove from ADMIN_IDS first)', () => {
    const { env: e, users } = bootstrap(['100', '101']);
    const founderA = seedUser(e.repos, '100', 'super_admin');
    const founderB = seedUser(e.repos, '101', 'super_admin');
    expect(() => users.setRole(founderB, 'user', founderA)).toThrow(AppError);
    try {
      users.setRole(founderB, 'user', founderA);
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.INVALID_INPUT);
    }
  });

  it('refuses self-mutation even by a founder', () => {
    const { env: e, users } = bootstrap(['100']);
    const founder = seedUser(e.repos, '100', 'super_admin');
    expect(() => users.setRole(founder, 'user', founder)).toThrow(AppError);
  });

  it('refuses to promote a banned user', () => {
    const { env: e, users } = bootstrap(['100']);
    const founder = seedUser(e.repos, '100', 'super_admin');
    const banned = seedUser(e.repos, '500', 'user', true);
    expect(() => users.setRole(banned, 'super_admin', founder)).toThrow(AppError);
  });

  it('a founder can demote a promoted super admin', () => {
    const { env: e, users } = bootstrap(['100']);
    const founder = seedUser(e.repos, '100', 'super_admin');
    const promoted = seedUser(e.repos, '600', 'super_admin');
    const updated = users.setRole(promoted, 'user', founder);
    expect(updated.role).toBe('user');
  });

  it('is idempotent when target.role already equals the requested role', () => {
    const { env: e, users } = bootstrap(['100']);
    const founder = seedUser(e.repos, '100', 'super_admin');
    const alreadySuper = seedUser(e.repos, '700', 'super_admin');
    const updated = users.setRole(alreadySuper, 'super_admin', founder);
    expect(updated.id).toBe(alreadySuper.id);
    expect(updated.role).toBe('super_admin');
  });
});
