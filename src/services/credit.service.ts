/**
 * VaultLink Bot — credit system service.
 *
 * Owns all credit policy decisions: whether the system is on, what an
 * action costs, who is exempt, and how rewards are doled out. The
 * repository layer below has zero policy and just ensures atomicity.
 *
 * Every cost is read through `costFor()` which walks the settings table:
 * per-file-type override → per-action base → env default → hardcoded
 * fallback. Admins flip toggles and edit numbers via `/admin → Credits`
 * (and the Mini App admin page); none of this requires a redeploy.
 */

import type { Config } from '../config/env.js';
import type {
  CreditReason,
  CreditTopupPackage,
  CreditTransactionRow,
  FileType,
  UserRow,
} from '../types/index.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { AuditService } from './audit.service.js';
import type { SettingsService } from './settings.service.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type {
  ApplyDeltaResult,
  CreditRepository,
} from '../repositories/credit.repository.js';

/* ------------------------------------------------------------------------- *
 * Setting keys
 * ------------------------------------------------------------------------- */

/**
 * Canonical settings keys. Centralised so the admin UI, the service, and
 * the tests all use the exact same strings.
 */
export const CREDIT_SETTING_KEYS = {
  enabled: 'credits.enabled',
  signupBonus: 'credits.signup_bonus',
  costDecode: 'credits.cost_decode',
  costCollectionOpen: 'credits.cost_collection_open',
  costCollectionSend: 'credits.cost_collection_send',
  costCollectionPerItem: 'credits.cost_collection_per_item',
  referralEnabled: 'credits.referral_enabled',
  referralReward: 'credits.referral_reward',
  referralDailyCap: 'credits.referral_daily_cap',
  referralPairLifetimeCap: 'credits.referral_pair_lifetime_cap',
  referralPairWindowMinutes: 'credits.referral_pair_window_minutes',
  referralPairWindowMax: 'credits.referral_pair_window_max',
  referralRedeemerMinAgeMinutes: 'credits.referral_redeemer_min_age_minutes',
  topupEnabled: 'credits.topup_enabled',
  topupPackages: 'credits.topup_packages',
  bypassForOwner: 'credits.bypass_for_owner',
  bypassForAdmin: 'credits.bypass_for_admin',
} as const;

/** Build the per-file-type override key, e.g. `credits.cost_decode.video`. */
export const costDecodeKeyForType = (fileType: FileType): string =>
  `${CREDIT_SETTING_KEYS.costDecode}.${fileType}`;

/* ------------------------------------------------------------------------- *
 * Cost / charge primitives
 * ------------------------------------------------------------------------- */

export type ChargeKind = 'decode' | 'collection_open' | 'collection_send';

export interface CostContext {
  /** Required when `kind === 'decode'` — selects the per-type override. */
  fileType?: FileType;
  /** Required when `kind === 'collection_send'` — used by per-item surcharge. */
  itemCount?: number;
}

export interface ChargeRequest {
  user: UserRow;
  kind: ChargeKind;
  /** `'file'` | `'collection'`. */
  referenceType: 'file' | 'collection';
  /** Numeric id of the file/collection being redeemed. */
  referenceId: number;
  /** When known, lets owner-bypass take effect. */
  ownerUserId?: number | null;
  /** When `kind === 'decode'`, used for the per-type cost override. */
  fileType?: FileType;
  /** When `kind === 'collection_send'`, used for the per-item surcharge. */
  itemCount?: number;
  /** Used by ShareService to bypass charge for super_admin / ADMIN_IDs. */
  isAdmin?: boolean;
}

/**
 * Receipt of a successful charge — pass to {@link CreditService.refund}
 * if the delivery that follows fails so the user gets their credits back.
 */
export interface ChargeReceipt {
  /** True when the charge actually deducted credits. False = system off, owner bypass, admin bypass, or zero cost. */
  charged: boolean;
  /** Cost actually deducted (0 when `charged` is false). */
  amount: number;
  /** Balance immediately after the deduction. */
  balanceAfter: number;
  /** Ledger row id, useful for refund traceback. */
  transactionId: number | null;
  /** Why the charge was skipped (owner_bypass / admin_bypass / disabled / zero_cost / charged). */
  reason: 'charged' | 'disabled' | 'owner_bypass' | 'admin_bypass' | 'zero_cost';
  /** Echoed back so refund() can write a matching ledger entry. */
  request: Pick<ChargeRequest, 'user' | 'kind' | 'referenceType' | 'referenceId'>;
}

/** Map a {@link ChargeKind} to the matching {@link CreditReason} for the ledger. */
const kindToReason = (kind: ChargeKind): CreditReason => {
  switch (kind) {
    case 'decode':
      return 'spend_decode';
    case 'collection_open':
      return 'spend_collection_open';
    case 'collection_send':
      return 'spend_collection_send';
  }
};

/** UTC midnight of the current day, ISO-encoded — anchor for the daily referral cap. */
const todayUtcStartIso = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
};

/** Defensive deep parse of the topup-packages setting. */
function parseTopupPackages(raw: string | undefined): CreditTopupPackage[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: CreditTopupPackage[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return null;
    const stars = (entry as Record<string, unknown>).stars;
    const credits = (entry as Record<string, unknown>).credits;
    if (
      typeof stars !== 'number' ||
      typeof credits !== 'number' ||
      !Number.isFinite(stars) ||
      !Number.isFinite(credits) ||
      stars < 1 ||
      credits < 1 ||
      !Number.isInteger(stars) ||
      !Number.isInteger(credits)
    ) {
      return null;
    }
    out.push({ stars, credits });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Defaults
 * ------------------------------------------------------------------------- */

/**
 * Built-in fallback packages used when neither the settings table nor an
 * env default specifies anything. 1 ⭐ = 10 credits at the entry tier with
 * volume bonuses at the upper tiers (per the Wave 9 plan defaults).
 */
export const DEFAULT_TOPUP_PACKAGES: readonly CreditTopupPackage[] = Object.freeze([
  Object.freeze({ stars: 10, credits: 100 }),
  Object.freeze({ stars: 50, credits: 600 }),
  Object.freeze({ stars: 100, credits: 1500 }),
] as readonly CreditTopupPackage[]);

/* ------------------------------------------------------------------------- *
 * Service
 * ------------------------------------------------------------------------- */

export interface CreditServiceDeps {
  credits: CreditRepository;
  users: UserRepository;
  settings: SettingsService;
  audit: AuditService;
  config: Config;
}

export class CreditService {
  private readonly creditsRepo: CreditRepository;
  private readonly users: UserRepository;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;
  private readonly config: Config;

  constructor(deps: CreditServiceDeps) {
    this.creditsRepo = deps.credits;
    this.users = deps.users;
    this.settings = deps.settings;
    this.audit = deps.audit;
    this.config = deps.config;
  }

  /* ------------------------------------------------------ feature toggles -- */

  /** Is the credit system currently active? */
  isEnabled(): boolean {
    return this.settings.getBoolean(CREDIT_SETTING_KEYS.enabled) ?? this.config.ENABLE_CREDITS;
  }

  isReferralEnabled(): boolean {
    return (
      this.settings.getBoolean(CREDIT_SETTING_KEYS.referralEnabled) ??
      this.config.CREDITS_REFERRAL_ENABLED
    );
  }

  isTopupEnabled(): boolean {
    return (
      this.settings.getBoolean(CREDIT_SETTING_KEYS.topupEnabled) ??
      this.config.CREDITS_TOPUP_ENABLED
    );
  }

  bypassForOwner(): boolean {
    return (
      this.settings.getBoolean(CREDIT_SETTING_KEYS.bypassForOwner) ??
      this.config.CREDITS_BYPASS_FOR_OWNER
    );
  }

  bypassForAdmin(): boolean {
    return (
      this.settings.getBoolean(CREDIT_SETTING_KEYS.bypassForAdmin) ??
      this.config.CREDITS_BYPASS_FOR_ADMIN
    );
  }

  /* ----------------------------------------------------------- amounts --- */

  signupBonusAmount(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.signupBonus);
    return v ?? this.config.CREDITS_SIGNUP_BONUS;
  }

  referralRewardAmount(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.referralReward);
    return v ?? this.config.CREDITS_REFERRAL_REWARD;
  }

  referralDailyCap(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.referralDailyCap);
    return v ?? this.config.CREDITS_REFERRAL_DAILY_CAP;
  }

  /** Anti-farming knob 1: per-(creator, redeemer) lifetime cap. 0 = off. */
  referralPairLifetimeCap(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.referralPairLifetimeCap);
    return v ?? this.config.CREDITS_REFERRAL_PAIR_LIFETIME_CAP;
  }

  /** Anti-farming knob 2 (a): velocity window in minutes. 0 = off. */
  referralPairWindowMinutes(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.referralPairWindowMinutes);
    return v ?? this.config.CREDITS_REFERRAL_PAIR_WINDOW_MINUTES;
  }

  /** Anti-farming knob 2 (b): max rewards per pair within the window. */
  referralPairWindowMax(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.referralPairWindowMax);
    return v ?? this.config.CREDITS_REFERRAL_PAIR_WINDOW_MAX;
  }

  /** Anti-farming knob 3: redeemer must be at least N minutes old. 0 = off. */
  referralRedeemerMinAgeMinutes(): number {
    const v = this.settings.getNumber(CREDIT_SETTING_KEYS.referralRedeemerMinAgeMinutes);
    return v ?? this.config.CREDITS_REFERRAL_REDEEMER_MIN_AGE_MINUTES;
  }

  /**
   * Resolve the cost of an action. Walks the settings table top-down so
   * admins can be as coarse or granular as they want without code
   * changes (per-file-type override → per-action base → env default →
   * hardcoded 1).
   */
  costFor(kind: ChargeKind, ctx: CostContext = {}): number {
    if (kind === 'decode') {
      if (ctx.fileType) {
        const override = this.settings.getNumber(costDecodeKeyForType(ctx.fileType));
        if (override !== undefined) return Math.max(0, override);
      }
      const base = this.settings.getNumber(CREDIT_SETTING_KEYS.costDecode);
      return Math.max(0, base ?? this.config.CREDITS_COST_DECODE);
    }
    if (kind === 'collection_open') {
      const v = this.settings.getNumber(CREDIT_SETTING_KEYS.costCollectionOpen);
      return Math.max(0, v ?? this.config.CREDITS_COST_COLLECTION_OPEN);
    }
    // collection_send: base + per-item surcharge
    const base = this.settings.getNumber(CREDIT_SETTING_KEYS.costCollectionSend);
    const perItem = this.settings.getNumber(CREDIT_SETTING_KEYS.costCollectionPerItem) ?? 0;
    const items = Math.max(0, ctx.itemCount ?? 0);
    return Math.max(0, (base ?? this.config.CREDITS_COST_COLLECTION_SEND) + perItem * items);
  }

  /** Snapshot of all topup packages — defaults applied if nothing is configured. */
  topupPackages(): CreditTopupPackage[] {
    const raw = this.settings.getString(CREDIT_SETTING_KEYS.topupPackages);
    const parsed = parseTopupPackages(raw);
    if (parsed && parsed.length > 0) return parsed;
    return DEFAULT_TOPUP_PACKAGES.map((p) => ({ stars: p.stars, credits: p.credits }));
  }

  setTopupPackages(packages: CreditTopupPackage[], actorUserId: number): void {
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'at least one package is required');
    }
    for (const p of packages) {
      if (!Number.isInteger(p.stars) || !Number.isInteger(p.credits) || p.stars < 1 || p.credits < 1) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'package values must be positive integers', {
          meta: { package: p },
        });
      }
    }
    this.settings.setString(CREDIT_SETTING_KEYS.topupPackages, JSON.stringify(packages));
    this.audit.log('credits.settings_changed', {
      actorUserId,
      targetType: 'setting',
      targetId: CREDIT_SETTING_KEYS.topupPackages,
      metadata: { packages },
    });
  }

  /* ----------------------------------------------------------- balance --- */

  getBalance(userId: number): number {
    return this.creditsRepo.getBalance(userId);
  }

  /** Recent ledger entries, newest-first. */
  getRecentHistory(userId: number, limit: number): CreditTransactionRow[] {
    return this.creditsRepo.listByUser(userId, Math.max(1, limit), 0);
  }

  /** Lifetime totals (for the Mini App "earned / spent" widget). */
  getLifetimeTotals(userId: number): { gained: number; spent: number; balance: number } {
    const totals = this.creditsRepo.totals(userId);
    return { ...totals, balance: this.creditsRepo.getBalance(userId) };
  }

  /* ------------------------------------------------------ signup bonus --- */

  /**
   * Idempotent: grants the signup bonus exactly once per user. No-op when
   * the system is disabled or the bonus amount is zero. Called from the
   * attach-user middleware on every interaction; the `credits_initialized`
   * flag short-circuits the second call onward.
   */
  ensureSignupBonus(user: UserRow): UserRow {
    if (user.credits_initialized === 1) return user;
    if (!this.isEnabled()) return user;
    const amount = this.signupBonusAmount();
    if (amount <= 0) {
      // Disabled by setting amount=0 — still mark initialized so the user
      // doesn't get the bonus retroactively if the amount is later raised.
      return this.users.setCreditsInitialized(user.id);
    }

    // Apply the credit BEFORE flipping the flag — see UserRepository note.
    let result: ApplyDeltaResult;
    try {
      result = this.creditsRepo.applyDelta({
        userId: user.id,
        delta: amount,
        reason: 'signup_bonus',
        referenceType: 'user',
        referenceId: String(user.id),
        metadata: { amount },
      });
    } catch (err) {
      // If the grant fails we leave the flag unset so the next interaction
      // tries again. Logging happens through the global error handler.
      throw err;
    }
    const updated = this.users.setCreditsInitialized(user.id);
    this.audit.log('credits.signup_bonus', {
      actorUserId: user.id,
      targetType: 'user',
      targetId: String(user.id),
      metadata: {
        amount,
        balanceAfter: result.balanceAfter,
        transactionId: result.transaction.id,
      },
    });
    return updated;
  }

  /* ------------------------------------------------------------ charge --- */

  /**
   * Deduct credits for a redemption. Returns a {@link ChargeReceipt}; pass
   * it to {@link refund} on delivery failure to release the hold. Throws
   * `INSUFFICIENT_CREDITS` (an exposable AppError) when the user can't
   * afford the action.
   */
  chargeForRedemption(req: ChargeRequest): ChargeReceipt {
    const stub: Pick<ChargeRequest, 'user' | 'kind' | 'referenceType' | 'referenceId'> = {
      user: req.user,
      kind: req.kind,
      referenceType: req.referenceType,
      referenceId: req.referenceId,
    };

    // Wave 9.2 — short-circuit on spend-lock BEFORE any other check, so a
    // refund-blocked user can't squeeze a free spend in via owner_bypass /
    // admin_bypass / zero_cost branches. The lock takes precedence.
    this.assertSpendable(req.user);

    if (!this.isEnabled()) {
      return {
        charged: false,
        amount: 0,
        balanceAfter: this.creditsRepo.getBalance(req.user.id),
        transactionId: null,
        reason: 'disabled',
        request: stub,
      };
    }

    if (req.isAdmin && this.bypassForAdmin()) {
      return {
        charged: false,
        amount: 0,
        balanceAfter: this.creditsRepo.getBalance(req.user.id),
        transactionId: null,
        reason: 'admin_bypass',
        request: stub,
      };
    }

    if (
      req.ownerUserId !== undefined &&
      req.ownerUserId !== null &&
      req.ownerUserId === req.user.id &&
      this.bypassForOwner()
    ) {
      return {
        charged: false,
        amount: 0,
        balanceAfter: this.creditsRepo.getBalance(req.user.id),
        transactionId: null,
        reason: 'owner_bypass',
        request: stub,
      };
    }

    const cost = this.costFor(req.kind, {
      ...(req.fileType !== undefined ? { fileType: req.fileType } : {}),
      ...(req.itemCount !== undefined ? { itemCount: req.itemCount } : {}),
    });
    if (cost === 0) {
      return {
        charged: false,
        amount: 0,
        balanceAfter: this.creditsRepo.getBalance(req.user.id),
        transactionId: null,
        reason: 'zero_cost',
        request: stub,
      };
    }

    // Pre-flight balance check for a friendlier error (the repository
    // would also throw, but we want the "need vs have" numbers in the
    // exposed message).
    const balanceBefore = this.creditsRepo.getBalance(req.user.id);
    if (balanceBefore < cost) {
      throw new AppError(
        ErrorCode.INSUFFICIENT_CREDITS,
        `Insufficient credits (need ${cost}, have ${balanceBefore})`,
        {
          expose: false, // surfaced via locale, not raw message
          meta: { needed: cost, balance: balanceBefore },
        },
      );
    }

    const result = this.creditsRepo.applyDelta({
      userId: req.user.id,
      delta: -cost,
      reason: kindToReason(req.kind),
      referenceType: req.referenceType,
      referenceId: String(req.referenceId),
      metadata: {
        kind: req.kind,
        ...(req.fileType !== undefined ? { fileType: req.fileType } : {}),
        ...(req.itemCount !== undefined ? { itemCount: req.itemCount } : {}),
      },
    });

    this.audit.log('credits.spend', {
      actorUserId: req.user.id,
      targetType: req.referenceType,
      targetId: String(req.referenceId),
      metadata: {
        amount: cost,
        kind: req.kind,
        balanceAfter: result.balanceAfter,
        transactionId: result.transaction.id,
      },
    });

    return {
      charged: true,
      amount: cost,
      balanceAfter: result.balanceAfter,
      transactionId: result.transaction.id,
      reason: 'charged',
      request: stub,
    };
  }

  /** Refund a previously-issued charge. Safe to call on a no-op receipt. */
  refund(receipt: ChargeReceipt, errorReason?: string): void {
    if (!receipt.charged || receipt.amount <= 0) return;

    const result = this.creditsRepo.applyDelta({
      userId: receipt.request.user.id,
      delta: receipt.amount,
      reason: 'refund',
      referenceType: receipt.request.referenceType,
      referenceId: String(receipt.request.referenceId),
      metadata: {
        kind: receipt.request.kind,
        amount: receipt.amount,
        originalTransactionId: receipt.transactionId,
        errorReason: errorReason ?? null,
      },
    });

    this.audit.log('credits.refund', {
      actorUserId: receipt.request.user.id,
      targetType: receipt.request.referenceType,
      targetId: String(receipt.request.referenceId),
      metadata: {
        amount: receipt.amount,
        kind: receipt.request.kind,
        balanceAfter: result.balanceAfter,
        originalTransactionId: receipt.transactionId,
        errorReason: errorReason ?? null,
      },
    });
  }

  /* ---------------------------------------------------------- referral --- */

  /**
   * Credit the creator of a code that was just successfully redeemed.
   *
   * Anti-farming defense-in-depth — the reward is silently skipped when:
   *   1. system or referral disabled / amount is zero
   *   2. creator === redeemer (own-code redemption)
   *   3. redeemer account is younger than the quarantine threshold
   *      (`credits.referral_redeemer_min_age_minutes`) — defeats
   *      throwaway alts
   *   4. the (creator, redeemer) pair has already earned the lifetime
   *      cap (`credits.referral_pair_lifetime_cap`) — defeats the
   *      "A creates 10k codes, B opens all of them" collusion attack
   *      (Dropbox-style)
   *   5. the (creator, redeemer) pair earned more than the velocity
   *      window allows in the last N minutes — burst defense
   *   6. the creator hit today's UTC daily cap
   *      (`credits.referral_daily_cap`)
   *
   * "Silently skipped" means: the open still works, the user isn't told
   * anything, but every skip writes a structured audit row so the
   * admin's `/admin_credit_referral_stats` and audit log reveal the
   * pattern. Failures inside the credit grant itself never block the
   * redemption — they're swallowed-but-audited.
   */
  rewardReferral(input: {
    creatorUserId: number;
    redeemerUserId: number;
    referenceType: 'file' | 'collection';
    referenceId: number;
  }): { granted: boolean; amount: number; reason: string } {
    if (!this.isEnabled() || !this.isReferralEnabled()) {
      return { granted: false, amount: 0, reason: 'disabled' };
    }
    if (input.creatorUserId === input.redeemerUserId) {
      return { granted: false, amount: 0, reason: 'self' };
    }
    const amount = this.referralRewardAmount();
    if (amount <= 0) {
      return { granted: false, amount: 0, reason: 'zero' };
    }

    /* ---------------- Layer 3: redeemer quarantine ---------------- */
    const minAge = this.referralRedeemerMinAgeMinutes();
    if (minAge > 0) {
      const redeemer = this.users.findById(input.redeemerUserId);
      if (redeemer) {
        const ageMs = Date.now() - new Date(redeemer.created_at).getTime();
        if (ageMs < minAge * 60_000) {
          this.audit.log('credits.referral_redeemer_too_new', {
            actorUserId: input.redeemerUserId,
            targetType: 'user',
            targetId: String(input.creatorUserId),
            metadata: {
              redeemerCreatedAt: redeemer.created_at,
              ageMinutes: Math.floor(ageMs / 60_000),
              minAgeMinutes: minAge,
              referenceType: input.referenceType,
              referenceId: input.referenceId,
            },
          });
          return { granted: false, amount: 0, reason: 'redeemer_too_new' };
        }
      }
    }

    /* -------------- Layer 4: per-pair lifetime cap ---------------- */
    const pairLifetimeCap = this.referralPairLifetimeCap();
    if (pairLifetimeCap > 0) {
      const pairLifetime = this.creditsRepo.countReferralRewardsForPair(
        input.creatorUserId,
        input.redeemerUserId,
        '1970-01-01T00:00:00.000Z',
      );
      if (pairLifetime >= pairLifetimeCap) {
        this.audit.log('credits.referral_pair_capped', {
          actorUserId: input.redeemerUserId,
          targetType: 'user',
          targetId: String(input.creatorUserId),
          metadata: {
            pairLifetimeCount: pairLifetime,
            pairLifetimeCap,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
          },
        });
        return { granted: false, amount: 0, reason: 'pair_lifetime_cap' };
      }
    }

    /* -------------- Layer 5: per-pair velocity window ------------- */
    const windowMin = this.referralPairWindowMinutes();
    const windowMax = this.referralPairWindowMax();
    if (windowMin > 0 && windowMax > 0) {
      const sinceIso = new Date(Date.now() - windowMin * 60_000).toISOString();
      const recentPair = this.creditsRepo.countReferralRewardsForPair(
        input.creatorUserId,
        input.redeemerUserId,
        sinceIso,
      );
      if (recentPair >= windowMax) {
        this.audit.log('credits.referral_velocity_blocked', {
          actorUserId: input.redeemerUserId,
          targetType: 'user',
          targetId: String(input.creatorUserId),
          metadata: {
            windowMinutes: windowMin,
            windowMax,
            recentPairCount: recentPair,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
          },
        });
        return { granted: false, amount: 0, reason: 'pair_velocity' };
      }
    }

    /* -------------- Layer 6: per-creator daily cap (existing) ----- */
    const cap = this.referralDailyCap();
    if (cap > 0) {
      const earnedToday = this.creditsRepo.sumByUserAndReasonSince(
        input.creatorUserId,
        'referral_reward',
        todayUtcStartIso(),
      );
      if (earnedToday + amount > cap) {
        this.audit.log('credits.referral_capped', {
          actorUserId: input.redeemerUserId,
          targetType: 'user',
          targetId: String(input.creatorUserId),
          metadata: {
            cap,
            earnedToday,
            attemptedAmount: amount,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
          },
        });
        return { granted: false, amount: 0, reason: 'capped' };
      }
    }

    try {
      const result = this.creditsRepo.applyDelta({
        userId: input.creatorUserId,
        delta: amount,
        reason: 'referral_reward',
        referenceType: input.referenceType,
        referenceId: String(input.referenceId),
        metadata: {
          amount,
          redeemerUserId: input.redeemerUserId,
        },
      });
      this.audit.log('credits.referral_reward', {
        actorUserId: input.redeemerUserId,
        targetType: 'user',
        targetId: String(input.creatorUserId),
        metadata: {
          amount,
          balanceAfter: result.balanceAfter,
          transactionId: result.transaction.id,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        },
      });
      return { granted: true, amount, reason: 'granted' };
    } catch {
      this.audit.log('credits.referral_failed', {
        actorUserId: input.redeemerUserId,
        targetType: 'user',
        targetId: String(input.creatorUserId),
        metadata: { amount, reason: 'apply_delta_failed' },
      });
      return { granted: false, amount: 0, reason: 'error' };
    }
  }

  /**
   * Admin / observability helper — returns lifetime / today / current
   * window counts for a single (creator, redeemer) pair. Backs the
   * `/admin_credit_referral_stats` command and the Mini App audit view.
   */
  referralPairStats(creatorUserId: number, redeemerUserId: number): {
    lifetime: number;
    today: number;
    inWindow: number;
    pairLifetimeCap: number;
    pairWindowMinutes: number;
    pairWindowMax: number;
  } {
    const lifetime = this.creditsRepo.countReferralRewardsForPair(
      creatorUserId,
      redeemerUserId,
      '1970-01-01T00:00:00.000Z',
    );
    const today = this.creditsRepo.countReferralRewardsForPair(
      creatorUserId,
      redeemerUserId,
      todayUtcStartIso(),
    );
    const windowMin = this.referralPairWindowMinutes();
    const inWindow =
      windowMin > 0
        ? this.creditsRepo.countReferralRewardsForPair(
            creatorUserId,
            redeemerUserId,
            new Date(Date.now() - windowMin * 60_000).toISOString(),
          )
        : 0;
    return {
      lifetime,
      today,
      inWindow,
      pairLifetimeCap: this.referralPairLifetimeCap(),
      pairWindowMinutes: windowMin,
      pairWindowMax: this.referralPairWindowMax(),
    };
  }

  /* -------------------------------------------------------------- topup --- */

  /**
   * Apply a successful Telegram Stars topup. Caller (the topup router's
   * `successful_payment` handler) is responsible for ensuring this runs
   * at most once per `paymentChargeId`.
   */
  applyTopup(input: {
    userId: number;
    credits: number;
    stars: number;
    paymentChargeId: string;
  }): ApplyDeltaResult {
    if (!Number.isInteger(input.credits) || input.credits <= 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'topup credits must be a positive integer');
    }
    const result = this.creditsRepo.applyDelta({
      userId: input.userId,
      delta: input.credits,
      reason: 'topup',
      referenceType: 'invoice',
      referenceId: input.paymentChargeId,
      metadata: {
        credits: input.credits,
        stars: input.stars,
        paymentChargeId: input.paymentChargeId,
      },
    });
    this.audit.log('credits.topup', {
      actorUserId: input.userId,
      targetType: 'user',
      targetId: String(input.userId),
      metadata: {
        credits: input.credits,
        stars: input.stars,
        paymentChargeId: input.paymentChargeId,
        balanceAfter: result.balanceAfter,
        transactionId: result.transaction.id,
      },
    });
    return result;
  }

  /* ---------------------------------------------------- admin adjust --- */

  /**
   * Admin-issued credit adjustment (positive grant or negative revoke).
   * Refuses overdrafts so an admin can't drive a balance negative —
   * use {@link adminSet} when you need to set an absolute value.
   */
  adminAdjust(input: {
    actorUserId: number;
    targetUserId: number;
    delta: number;
    note?: string;
  }): ApplyDeltaResult {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'delta must be a non-zero integer');
    }

    const result = this.creditsRepo.applyDelta({
      userId: input.targetUserId,
      delta: input.delta,
      reason: 'admin_adjust',
      referenceType: 'user',
      referenceId: String(input.actorUserId),
      metadata: {
        actorUserId: input.actorUserId,
        delta: input.delta,
        note: input.note ?? null,
      },
    });
    this.audit.log('credits.admin_adjust', {
      actorUserId: input.actorUserId,
      targetType: 'user',
      targetId: String(input.targetUserId),
      metadata: {
        delta: input.delta,
        balanceAfter: result.balanceAfter,
        transactionId: result.transaction.id,
        note: input.note ?? null,
      },
    });
    return result;
  }

  /** Set a target user's balance to an absolute value (admin "set" flow). */
  adminSet(input: {
    actorUserId: number;
    targetUserId: number;
    targetBalance: number;
    note?: string;
  }): { delta: number; balanceAfter: number; transaction: CreditTransactionRow } {
    const setArgs: {
      userId: number;
      targetBalance: number;
      actorUserId: number;
      note?: string;
    } = {
      userId: input.targetUserId,
      targetBalance: input.targetBalance,
      actorUserId: input.actorUserId,
    };
    if (input.note !== undefined) setArgs.note = input.note;
    const { delta, transaction } = this.creditsRepo.setAbsoluteBalance(setArgs);
    this.audit.log('credits.admin_set', {
      actorUserId: input.actorUserId,
      targetType: 'user',
      targetId: String(input.targetUserId),
      metadata: {
        delta,
        balanceAfter: input.targetBalance,
        transactionId: transaction.id,
        note: input.note ?? null,
      },
    });
    return { delta, balanceAfter: input.targetBalance, transaction };
  }

  /* -------------------------------------------------------- settings --- */

  /** Generic set-and-audit helper used by admin toggles and number edits. */
  setSetting(
    key: string,
    value: { kind: 'bool'; value: boolean } | { kind: 'number'; value: number },
    actorUserId: number,
  ): void {
    const oldValue = this.settings.getString(key) ?? null;
    if (value.kind === 'bool') {
      this.settings.setBoolean(key, value.value);
    } else {
      if (!Number.isInteger(value.value) || value.value < 0) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'numeric setting must be a non-negative integer');
      }
      this.settings.setNumber(key, value.value);
    }
    this.audit.log('credits.settings_changed', {
      actorUserId,
      targetType: 'setting',
      targetId: key,
      metadata: {
        key,
        oldValue,
        newValue: value.kind === 'bool' ? String(value.value) : String(value.value),
      },
    });
  }

  /** Drop a setting back to its env-default. */
  clearSetting(key: string, actorUserId: number): void {
    const oldValue = this.settings.getString(key) ?? null;
    this.settings.delete(key);
    this.audit.log('credits.settings_changed', {
      actorUserId,
      targetType: 'setting',
      targetId: key,
      metadata: { key, oldValue, newValue: null },
    });
  }

  /* ---------------------------------------------------- Wave 9.2: locks --- */

  /**
   * Throws `SPEND_LOCKED` when the user is currently in a Stars-refund
   * cooling-off period. Called from {@link chargeForRedemption} (every
   * paid action) and from any future spend pathway. The lock is checked
   * against the freshly-read row each time, not a memoized snapshot, so
   * an admin "clear lock" takes effect immediately on next request.
   */
  assertSpendable(user: UserRow): void {
    // The user we get is the request-attached row; re-read for freshness so
    // a lock cleared by an admin between attach time and now is honored.
    const fresh = this.users.findById(user.id);
    if (!fresh) return; // user vanished — let downstream handle it
    if (fresh.spend_locked_until === null) return;
    const unlockMs = Date.parse(fresh.spend_locked_until);
    if (!Number.isFinite(unlockMs)) return; // malformed value, ignore
    if (unlockMs <= Date.now()) return; // expired naturally
    throw new AppError(
      ErrorCode.SPEND_LOCKED,
      `account spending is locked until ${fresh.spend_locked_until}`,
      {
        expose: true,
        meta: {
          userId: user.id,
          spendLockedUntil: fresh.spend_locked_until,
          unlockMs,
        },
      },
    );
  }

  /**
   * Telegram delivered a `refunded_payment` (or an admin-initiated refund
   * arrived via the same channel — `bot.api.refundStarPayment` triggers
   * the same service message). Reverses the original `topup` ledger row,
   * applies the proportional spend-lock, bumps the refund counters, and
   * — if the repeat-offender threshold trips — flips `is_banned = 1`.
   *
   * Idempotent: a second call with the same `paymentChargeId` is a
   * no-op (the existence of a `topup_refund` row is the de-dupe guard).
   *
   * `source = 'telegram'` is the normal path (the user disputed via
   * Telegram support); `'admin'` is when the operator initiates the
   * refund themselves. Both write the same ledger entry; the audit
   * action varies so the dashboard can split them.
   */
  refundTopup(input: {
    paymentChargeId: string;
    source: 'telegram' | 'admin';
    adminUserId?: number;
  }): {
    applied: boolean;
    reason: 'no_topup' | 'already_refunded' | 'applied';
    credits: number;
    stars: number;
    balanceAfter: number;
    spendLockedUntil: string | null;
    hardBanned: boolean;
  } {
    // 1. Find the original topup ledger row.
    const original = this.creditsRepo.findTopupByPaymentChargeId(input.paymentChargeId);
    if (!original) {
      this.audit.log('credits.refund_no_topup', {
        actorUserId: input.adminUserId ?? null,
        targetType: 'payment',
        targetId: input.paymentChargeId,
        metadata: { source: input.source },
      });
      return {
        applied: false,
        reason: 'no_topup',
        credits: 0,
        stars: 0,
        balanceAfter: 0,
        spendLockedUntil: null,
        hardBanned: false,
      };
    }

    // 2. Idempotency — has this charge already been refunded?
    if (this.creditsRepo.existsRefundForPaymentCharge(input.paymentChargeId)) {
      this.audit.log('credits.refund_dedup', {
        actorUserId: input.adminUserId ?? original.user_id,
        targetType: 'payment',
        targetId: input.paymentChargeId,
        metadata: { source: input.source, originalLedgerId: original.id },
      });
      return {
        applied: false,
        reason: 'already_refunded',
        credits: 0,
        stars: 0,
        balanceAfter: this.creditsRepo.getBalance(original.user_id),
        spendLockedUntil: null,
        hardBanned: false,
      };
    }

    // 3. Pull the stars amount from the original metadata so the lock
    //    duration is proportional to what the user actually paid.
    let stars = 0;
    if (original.metadata_json) {
      try {
        const meta = JSON.parse(original.metadata_json) as { stars?: number };
        if (typeof meta.stars === 'number' && Number.isFinite(meta.stars) && meta.stars > 0) {
          stars = Math.floor(meta.stars);
        }
      } catch {
        // Malformed metadata — fall through with stars=0; the lock then
        // becomes a flat 0s (i.e. clawback only, no time-based lock).
      }
    }

    const credits = original.delta; // positive (it was a topup grant)

    // 4. Atomic clawback — applyDeltaUnchecked allows the cached balance to
    //    go negative for users who already spent the credits. Spending is
    //    then auto-blocked by the overdraft check on every applyDelta.
    const reversal = this.creditsRepo.applyDeltaUnchecked({
      userId: original.user_id,
      delta: -credits,
      reason: 'topup_refund',
      referenceType: 'payment',
      referenceId: input.paymentChargeId,
      metadata: {
        credits,
        stars,
        source: input.source,
        originalLedgerId: original.id,
        adminUserId: input.adminUserId ?? null,
      },
    });

    // 5. Bump refund counters on the user row.
    let updated = this.users.incrementRefundCounters(original.user_id, stars);

    // 6. Compute and set the spend-lock end time.
    const lockSecsRaw = stars * Math.max(0, this.config.STARS_REFUND_LOCK_SECONDS_PER_STAR);
    const lockSecs = Math.min(
      Math.max(0, this.config.STARS_REFUND_LOCK_MAX_SECONDS),
      lockSecsRaw,
    );
    let spendLockedUntil: string | null = updated.spend_locked_until;
    if (lockSecs > 0) {
      const proposed = new Date(Date.now() + lockSecs * 1000).toISOString();
      // Take max(existing, proposed) so a fresh refund can never SHORTEN
      // an active lock from a previous refund.
      const existingMs =
        updated.spend_locked_until === null ? 0 : Date.parse(updated.spend_locked_until);
      const proposedMs = Date.parse(proposed);
      const finalUntil = proposedMs >= existingMs ? proposed : updated.spend_locked_until!;
      updated = this.users.setSpendLockedUntil(original.user_id, finalUntil);
      spendLockedUntil = finalUntil;
    }

    // 7. Repeat-offender hard ban — count refund events in the last
    //    STARS_REFUND_HARD_BAN_WINDOW_DAYS days.
    let hardBanned = false;
    const threshold = this.config.STARS_REFUND_HARD_BAN_THRESHOLD;
    if (threshold > 0) {
      const sinceIso = new Date(
        Date.now() - this.config.STARS_REFUND_HARD_BAN_WINDOW_DAYS * 24 * 3600 * 1000,
      ).toISOString();
      const recent = this.creditsRepo.countByUserAndReasonSince(
        original.user_id,
        'topup_refund',
        sinceIso,
      );
      if (recent >= threshold && updated.is_banned !== 1) {
        updated = this.users.setBanned(original.user_id, true);
        hardBanned = true;
      }
    }

    // 8. Audit.
    this.audit.log(
      input.source === 'telegram' ? 'credits.stars_refund_received' : 'credits.stars_refund_admin',
      {
        actorUserId: input.adminUserId ?? original.user_id,
        targetType: 'user',
        targetId: String(original.user_id),
        metadata: {
          paymentChargeId: input.paymentChargeId,
          credits,
          stars,
          source: input.source,
          originalLedgerId: original.id,
          reversalLedgerId: reversal.transaction.id,
          balanceAfter: reversal.balanceAfter,
          spendLockedUntil,
          hardBanned,
        },
      },
    );

    return {
      applied: true,
      reason: 'applied',
      credits,
      stars,
      balanceAfter: reversal.balanceAfter,
      spendLockedUntil,
      hardBanned,
    };
  }

  /**
   * Founder-only: clear an active spend-lock and (optionally) write off any
   * negative balance with an `admin_writeoff` ledger entry. Use case: a
   * legitimate Telegram refund where the user is not actually abusing.
   */
  clearSpendLock(input: {
    actorUserId: number;
    targetUserId: number;
    writeOffNegativeBalance: boolean;
    note?: string;
  }): { balanceAfter: number; wroteOff: number; spendLockedUntil: null } {
    const updated = this.users.setSpendLockedUntil(input.targetUserId, null);
    let wroteOff = 0;
    let balanceAfter = updated.credits;
    if (input.writeOffNegativeBalance && updated.credits < 0) {
      wroteOff = -updated.credits;
      const result = this.creditsRepo.applyDeltaUnchecked({
        userId: input.targetUserId,
        delta: wroteOff,
        reason: 'admin_writeoff',
        referenceType: 'user',
        referenceId: String(input.actorUserId),
        metadata: {
          actorUserId: input.actorUserId,
          amount: wroteOff,
          note: input.note ?? null,
        },
      });
      balanceAfter = result.balanceAfter;
    }
    this.audit.log('credits.spend_lock_cleared', {
      actorUserId: input.actorUserId,
      targetType: 'user',
      targetId: String(input.targetUserId),
      metadata: {
        wroteOff,
        balanceAfter,
        note: input.note ?? null,
      },
    });
    return { balanceAfter, wroteOff, spendLockedUntil: null };
  }
}
