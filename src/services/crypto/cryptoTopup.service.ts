/**
 * CryptoTopupService — orchestrates self-custodial top-up flows.
 *
 * Responsibilities:
 *   - Resolve runtime chain configuration from settings (with env defaults).
 *   - Create invoices: pick required confirmations, generate memo, set TTL.
 *   - Verify a user-pasted tx_hash via the right adapter.
 *   - Apply credits idempotently once verification + confirmations pass.
 *   - List recent invoices for a user (history view).
 *
 * Thread safety: the (chain, tx_hash) UNIQUE index in the repository
 * is the load-bearing dedup, so even if two requests race to apply the
 * same hash, only one will land. The service itself is stateless.
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/env.js';
import type { AuditService } from '../audit.service.js';
import type { SettingsService } from '../settings.service.js';
import type { CreditService } from '../credit.service.js';
import type {
  CryptoChainConfig,
  CryptoChainId,
  CryptoInvoiceRow,
  UserRow,
} from '../../types/index.js';
import { CRYPTO_CHAIN_IDS } from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import type { CryptoInvoiceRepository } from '../../repositories/cryptoInvoice.repository.js';
import type { ChainAdapter, TxVerification } from './chain.types.js';
import { amountMatches, fromBaseUnits, toBaseUnits } from './chain.types.js';
import { chainKey as registryChainKey, chainSpecOf } from './chain.registry.js';
import type { RateLimitService } from '../rateLimit.service.js';

/* ------------------------------------------------------------------------- *
 * Setting keys
 * ------------------------------------------------------------------------- */

export const CRYPTO_SETTING_KEYS = {
  enabled: 'credits.crypto.enabled',
  invoiceTtlMinutes: 'credits.crypto.invoice_ttl_minutes',
  pollIntervalSeconds: 'credits.crypto.poll_interval_seconds',
  amountToleranceBps: 'credits.crypto.amount_tolerance_bps',
} as const;

/**
 * How many random suffixes the unique-amount allocator will try before it
 * falls back to the user-requested amount. With a 3-digit suffix space
 * (999 distinct values) and active-invoice counts in the low hundreds,
 * five attempts is well above the collision floor while staying cheap.
 */
const UNIQUE_AMOUNT_MAX_TRIES = 5;

/**
 * Re-export of the canonical setting-key builder so existing call sites
 * (admin routers, tests, etc.) keep working. New code should import from
 * `chain.registry.ts` directly.
 */
export const chainKey = registryChainKey;

/* ------------------------------------------------------------------------- *
 * Service
 * ------------------------------------------------------------------------- */

export interface CryptoTopupServiceDeps {
  invoices: CryptoInvoiceRepository;
  settings: SettingsService;
  audit: AuditService;
  credits: CreditService;
  config: Config;
  /**
   * Adapters keyed by chain id. The boot wiring registers all enabled
   * adapters; missing adapters mean "chain not supported by this build".
   */
  adapters: Map<CryptoChainId, ChainAdapter>;
  /**
   * Wave 9.3 — used by `createInvoice` to throttle invoice issuance per
   * user. Optional so tests / older call sites don't break; when absent,
   * rate limiting silently no-ops.
   */
  rateLimit?: RateLimitService;
}

export interface CreateInvoiceInput {
  user: UserRow;
  chain: CryptoChainId;
  /** Whole units (e.g. "10" for 10 USDT). Validated against chain min/max. */
  amount: string;
}

export class CryptoTopupService {
  private readonly invoices: CryptoInvoiceRepository;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;
  private readonly credits: CreditService;
  private readonly config: Config;
  private readonly adapters: Map<CryptoChainId, ChainAdapter>;
  private readonly rateLimit: RateLimitService | undefined;

  constructor(deps: CryptoTopupServiceDeps) {
    this.invoices = deps.invoices;
    this.settings = deps.settings;
    this.audit = deps.audit;
    this.credits = deps.credits;
    this.config = deps.config;
    this.adapters = deps.adapters;
    this.rateLimit = deps.rateLimit;
  }

  /* ----------------------------------------------------------- toggles --- */

  isEnabled(): boolean {
    return (
      this.settings.getBoolean(CRYPTO_SETTING_KEYS.enabled) ??
      this.config.ENABLE_CRYPTO_TOPUP
    );
  }

  /** TTL in minutes; bounded server-side to keep stale invoices from piling up. */
  invoiceTtlMinutes(): number {
    const v = this.settings.getNumber(CRYPTO_SETTING_KEYS.invoiceTtlMinutes);
    return Math.max(5, v ?? this.config.CRYPTO_INVOICE_TTL_MINUTES);
  }

  pollIntervalSeconds(): number {
    const v = this.settings.getNumber(CRYPTO_SETTING_KEYS.pollIntervalSeconds);
    return Math.max(5, v ?? this.config.CRYPTO_POLL_INTERVAL_SECONDS);
  }

  amountToleranceBps(): number {
    const v = this.settings.getNumber(CRYPTO_SETTING_KEYS.amountToleranceBps);
    return Math.max(0, Math.min(10_000, v ?? this.config.CRYPTO_AMOUNT_TOLERANCE_BPS));
  }

  /**
   * USD threshold below which the worker ignores incoming transfers. With
   * USDT/USDC pegged to $1, the worker converts this directly to base
   * units of the chain's stablecoin. 0 disables dust filtering. Defensive
   * coercion: a missing/NaN config value returns 0 rather than crashing
   * the worker with a `BigInt(NaN)` throw.
   */
  dustThresholdUsd(): number {
    const v = this.config.CRYPTO_DUST_THRESHOLD_USD;
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return Math.max(0, v);
  }

  /* --------------------------------------------------------- chain config --- */

  /** Read the runtime config for one chain — returns null if not configured. */
  chainConfig(chain: CryptoChainId): CryptoChainConfig | null {
    if (!this.adapters.has(chain)) return null;
    const spec = chainSpecOf(chain);
    if (!spec) return null;
    const enabled = this.settings.getBoolean(chainKey(chain, 'enabled')) ?? false;
    const address = this.settings.getString(chainKey(chain, 'address')) ?? '';
    const apiKey = this.settings.getString(chainKey(chain, 'api_key')) ?? null;

    const conf =
      this.settings.getNumber(chainKey(chain, 'confirmations')) ??
      spec.envConfirmations(this.config);
    const rate =
      this.settings.getNumber(chainKey(chain, 'rate')) ?? spec.envRate(this.config);

    const minAmount =
      this.settings.getString(chainKey(chain, 'min_amount')) ?? spec.defaults.minAmount;
    const maxAmount =
      this.settings.getString(chainKey(chain, 'max_amount')) ?? spec.defaults.maxAmount;

    return {
      id: chain,
      enabled,
      address,
      decimals: spec.decimals,
      confirmations: conf,
      rate,
      apiKey,
      memoSupported: spec.memoSupported,
      label: spec.label,
      minAmount,
      maxAmount,
    };
  }

  /** Snapshot every adapter-registered chain. */
  listChainConfigs(): CryptoChainConfig[] {
    const out: CryptoChainConfig[] = [];
    for (const id of CRYPTO_CHAIN_IDS) {
      const cfg = this.chainConfig(id);
      if (cfg) out.push(cfg);
    }
    return out;
  }

  listEnabledChains(): CryptoChainConfig[] {
    if (!this.isEnabled()) return [];
    return this.listChainConfigs().filter(
      (c) => c.enabled && c.address.length > 0,
    );
  }

  /* --------------------------------------------------- invoice creation --- */

  createInvoice(input: CreateInvoiceInput): CryptoInvoiceRow {
    if (!this.isEnabled()) {
      throw new AppError(ErrorCode.CRYPTO_CHAIN_DISABLED, 'crypto top-up is disabled');
    }
    const cfg = this.chainConfig(input.chain);
    if (!cfg) {
      throw new AppError(
        ErrorCode.CRYPTO_CHAIN_DISABLED,
        `chain ${input.chain} is not registered`,
      );
    }
    if (!cfg.enabled || cfg.address.length === 0) {
      throw new AppError(
        ErrorCode.CRYPTO_CHAIN_DISABLED,
        `chain ${input.chain} is disabled or has no address configured`,
      );
    }

    // Wave 9.3 — abuse defenses run BEFORE we burn entropy on the unique-
    // amount allocator or hit the DB. Two layers:
    //   1. Per-user concurrent active-invoice cap (hard limit, no time
    //      window) — prevents an attacker from exhausting unique-amount
    //      space or RPC quota by stacking pending invoices.
    //   2. Per-user invoice-creation rate limit (sliding window, env-
    //      configured) — slows churn even when the user closes/reopens.
    const cap = Math.max(
      1,
      this.config.CRYPTO_MAX_ACTIVE_INVOICES_PER_USER,
    );
    const active = this.invoices.countActiveByUser(input.user.id);
    if (active >= cap) {
      throw new AppError(
        ErrorCode.CRYPTO_TOO_MANY_ACTIVE_INVOICES,
        `at most ${cap} active invoices per user`,
        { meta: { active, cap }, expose: true },
      );
    }
    if (this.rateLimit) {
      const decision = this.rateLimit.check(
        'crypto_invoice',
        input.user.telegram_user_id,
      );
      if (!decision.allowed) {
        throw new AppError(
          ErrorCode.RATE_LIMITED,
          'too many invoice creations; slow down',
          {
            meta: {
              retryAt: decision.retryAt?.toISOString() ?? null,
              scope: decision.scope,
            },
            expose: true,
          },
        );
      }
    }

    // Amount validation. We accept an extra decimal of precision over the
    // chain's nativeDecimals (e.g. 7 for TRON) to leave room for unique
    // micro-suffixes if the operator wants to use them later, but reject
    // anything beyond that.
    if (!/^\d+(\.\d{1,9})?$/.test(input.amount)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `invalid amount: ${input.amount}`);
    }
    const requestedBase = toBaseUnits(input.amount, cfg.decimals);
    const minBase = toBaseUnits(cfg.minAmount, cfg.decimals);
    const maxBase = toBaseUnits(cfg.maxAmount, cfg.decimals);
    if (requestedBase < minBase || requestedBase > maxBase) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `amount ${input.amount} outside ${cfg.minAmount}..${cfg.maxAmount}`,
      );
    }

    // credits = whole_units * rate (rounded down). Anchored to the
    // user-requested amount, not the post-signature amount, so the
    // micro-suffix is invisible to credits accounting.
    const credits = Number(
      (requestedBase * BigInt(cfg.rate)) / BigInt(10 ** cfg.decimals),
    );
    if (credits <= 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'amount too small to grant any credits');
    }

    // Memo-less chains (TRON-USDT) cannot be told apart by anything other
    // than the on-chain transfer amount, so we encode invoice identity into
    // the amount itself by appending a random sub-cent suffix. Chains with
    // memo support keep the user-requested amount untouched.
    let amountBase = requestedBase;
    if (!cfg.memoSupported) {
      amountBase = this.allocateUniqueAmount({
        chain: input.chain,
        requestedBase,
        decimals: cfg.decimals,
        minBase,
        maxBase,
      });
    }

    // 8 hex chars (4 bytes) gives 4.3B unique values — more than enough
    // for active-invoice uniqueness inside a TTL window. Prefixed with
    // "VL-" so the user can recognise it visually on the chain explorer.
    const memo = cfg.memoSupported
      ? `VL-${randomBytes(4).toString('hex').toUpperCase()}`
      : null;
    const ttlMin = this.invoiceTtlMinutes();
    const expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString();

    // Normalise amount_unit to the chain's native decimals so verification
    // always compares apples to apples.
    const amountUnit = fromBaseUnits(amountBase, cfg.decimals);

    // Wave 9.2 — frozen QR/wallet-deeplink URI. Standards-only; bare address
    // for chains that lack a stable scheme.
    const paymentUri = buildPaymentUri({
      chain: input.chain,
      address: cfg.address,
      amountUnit,
      decimals: cfg.decimals,
      memo,
    });

    const inserted = this.invoices.insert({
      userId: input.user.id,
      chain: input.chain,
      amountUnit,
      amountDecimals: cfg.decimals,
      amountLabel: `${amountUnit} ${cfg.label.replace(/^USDT.*$/, 'USDT')}`,
      creditsToGrant: credits,
      payToAddress: cfg.address,
      memo,
      paymentUri,
      requiredConfirmations: cfg.confirmations,
      expiresAt,
      metadata: {
        rate: cfg.rate,
        decimals: cfg.decimals,
        // Wave 9.3 — flag invoices that opted into the unique-amount
        // disambiguator so the worker only auto-attributes transfers to
        // these. Pre-9.3 legacy invoices lack this flag and are
        // intentionally excluded from auto-discover (manual paste only)
        // to prevent stranger-transfer mis-attribution. THIS GUARD IS
        // LOAD-BEARING — money safety depends on it.
        unique_suffix: !cfg.memoSupported,
      },
    });

    this.audit.log('crypto.invoice_created', {
      actorUserId: input.user.id,
      targetType: 'crypto_invoice',
      targetId: String(inserted.id),
      metadata: {
        chain: input.chain,
        amount: amountUnit,
        credits,
        memo,
        expiresAt,
      },
    });

    return inserted;
  }

  /* ---------------------------------------------- user-paste tx hash --- */

  /**
   * User asserts they paid; we verify on-chain. On success the invoice
   * advances to `submitted` (or directly to `confirmed` if confirmations
   * already meet the threshold).
   */
  async submitTxHash(input: {
    user: UserRow;
    invoiceId: number;
    txHash: string;
  }): Promise<{ invoice: CryptoInvoiceRow; verification: TxVerification }> {
    const invoice = this.invoices.findById(input.invoiceId);
    if (!invoice) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, `invoice ${input.invoiceId} not found`);
    }
    if (invoice.user_id !== input.user.id) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'this invoice belongs to another user');
    }
    if (invoice.status === 'confirmed') {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED,
        `invoice ${invoice.id} has already been applied`,
      );
    }
    if (invoice.status === 'expired' || invoice.status === 'failed') {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_EXPIRED,
        `invoice ${invoice.id} is not accepting payments`,
      );
    }

    const adapter = this.adapters.get(invoice.chain);
    if (!adapter) {
      throw new AppError(ErrorCode.CRYPTO_CHAIN_DISABLED, `no adapter for ${invoice.chain}`);
    }

    // Pre-check the dedup table — surface CRYPTO_TX_DUPLICATE before
    // burning an RPC round trip.
    const existing = this.invoices.findByChainAndTxHash(invoice.chain, input.txHash);
    if (existing && existing.id !== invoice.id) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_DUPLICATE,
        `tx ${input.txHash} is already attached to invoice ${existing.id}`,
      );
    }

    const ver = await adapter.verifyTx({
      txHash: input.txHash,
      expectedToAddress: invoice.pay_to_address,
      expectedAmount: invoice.amount_unit,
      expectedDecimals: invoice.amount_decimals,
      expectedMemo: invoice.memo,
    });
    // Audit: record the submission attempt regardless of outcome so abuse
    // patterns (repeated wrong hashes, scraping, etc.) are visible.
    this.audit.log('crypto.invoice_submit_attempt', {
      actorUserId: input.user.id,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: {
        chain: invoice.chain,
        txHash: input.txHash,
        verification: {
          found: ver.found,
          state: ver.state,
          confirmations: ver.confirmations,
          amount: ver.amount,
          toAddress: ver.toAddress,
          memo: ver.memo,
        },
      },
    });

    if (!ver.found) {
      throw new AppError(ErrorCode.CRYPTO_TX_NOT_FOUND, `tx ${input.txHash} not found on-chain`);
    }
    if (ver.state === 'failed') {
      this.invoices.setFailure(invoice.id, 'tx reverted on-chain');
      this.audit.log('crypto.invoice_failed', {
        actorUserId: input.user.id,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: { reason: 'tx_reverted', txHash: input.txHash },
      });
      throw new AppError(ErrorCode.CRYPTO_TX_MISMATCH, 'tx reverted on-chain');
    }

    // Match address / amount / memo. Each rejection is audited with the
    // exact mismatch so support can pinpoint the cause from logs alone.
    if (ver.toAddress && ver.toAddress.toLowerCase() !== invoice.pay_to_address.toLowerCase()) {
      this.audit.log('crypto.invoice_submit_rejected', {
        actorUserId: input.user.id,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: {
          reason: 'address_mismatch',
          expected: invoice.pay_to_address,
          actual: ver.toAddress,
          txHash: input.txHash,
        },
      });
      throw new AppError(
        ErrorCode.CRYPTO_TX_MISMATCH,
        `tx recipient ${ver.toAddress} does not match invoice address`,
      );
    }
    if (
      ver.amount === null ||
      !amountMatches({
        actual: ver.amount,
        expected: invoice.amount_unit,
        decimals: invoice.amount_decimals,
        toleranceBps: this.amountToleranceBps(),
      })
    ) {
      this.audit.log('crypto.invoice_submit_rejected', {
        actorUserId: input.user.id,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: {
          reason: 'amount_mismatch',
          expected: invoice.amount_unit,
          actual: ver.amount,
          toleranceBps: this.amountToleranceBps(),
          txHash: input.txHash,
        },
      });
      throw new AppError(
        ErrorCode.CRYPTO_TX_MISMATCH,
        `tx amount ${ver.amount} does not meet expected ${invoice.amount_unit}`,
      );
    }
    if (invoice.memo && ver.memo !== invoice.memo) {
      // Memo mismatch is a soft-fail on chains where wallets sometimes
      // strip the comment. We log it but still consider the payment
      // attributed via amount + address pair if those matched.
      this.audit.log('crypto.memo_mismatch', {
        actorUserId: input.user.id,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: { expected: invoice.memo, actual: ver.memo, txHash: input.txHash },
      });
    }

    // Atomically attach the hash. Throws CRYPTO_TX_DUPLICATE if a parallel
    // request raced us.
    let row = invoice;
    if (invoice.tx_hash !== input.txHash) {
      row = this.invoices.attachTxHash({
        id: invoice.id,
        txHash: input.txHash,
        fromAddress: ver.fromAddress,
      });
    }

    // Update confirmations now while we have fresh data.
    const updated = this.invoices.updateConfirmations(row.id, ver.confirmations) ?? row;

    if (ver.confirmations >= invoice.required_confirmations) {
      // Apply credits now.
      const applied = await this.applyCreditsForInvoice(updated);
      return { invoice: applied, verification: ver };
    }

    // Not enough confirmations yet — leave the invoice in 'confirming'
    // and let the worker poll until threshold is met.
    return { invoice: updated, verification: ver };
  }

  /**
   * Idempotent: applies credits + flips status to 'confirmed'. Safe to
   * call from both the user-paste flow and the worker.
   */
  async applyCreditsForInvoice(invoice: CryptoInvoiceRow): Promise<CryptoInvoiceRow> {
    if (invoice.applied_at !== null) return invoice;
    if (invoice.status === 'confirmed') return invoice;
    if (invoice.tx_hash === null) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_NOT_FOUND,
        `invoice ${invoice.id} has no tx hash`,
      );
    }

    const result = this.credits.applyTopup({
      userId: invoice.user_id,
      credits: invoice.credits_to_grant,
      stars: 0, // not a Stars payment
      paymentChargeId: `${invoice.chain}:${invoice.tx_hash}`,
    });

    const updated = this.invoices.markApplied({
      id: invoice.id,
      ledgerTxId: result.transaction.id,
      confirmations: invoice.confirmations,
    });

    this.audit.log('crypto.invoice_applied', {
      actorUserId: invoice.user_id,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: {
        chain: invoice.chain,
        credits: invoice.credits_to_grant,
        txHash: invoice.tx_hash,
        balanceAfter: result.balanceAfter,
        ledgerTxId: result.transaction.id,
      },
    });

    return updated ?? invoice;
  }

  /* ----------------------------------------- recheck / admin overrides --- */

  /**
   * Re-poll an invoice's tx (if any) against the chain. Both the user and
   * admin call this — when `actorIsAdmin` is false, the requester must own
   * the invoice. Returns the updated row (and, when confirmations clear
   * the threshold, applies credits inside the same call).
   */
  async recheckInvoice(input: {
    invoiceId: number;
    actorUserId: number;
    actorIsAdmin: boolean;
  }): Promise<{ invoice: CryptoInvoiceRow; verification: TxVerification | null }> {
    const invoice = this.invoices.findById(input.invoiceId);
    if (!invoice) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, `invoice ${input.invoiceId} not found`);
    }
    if (!input.actorIsAdmin && invoice.user_id !== input.actorUserId) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'invoice belongs to another user');
    }
    if (!invoice.tx_hash) {
      // Nothing to re-check yet; return the row unchanged so the caller can
      // re-render the "no payment seen yet" state.
      return { invoice, verification: null };
    }

    const adapter = this.adapters.get(invoice.chain);
    if (!adapter) {
      throw new AppError(ErrorCode.CRYPTO_CHAIN_DISABLED, `no adapter for ${invoice.chain}`);
    }

    const ver = await adapter.verifyTx({
      txHash: invoice.tx_hash,
      expectedToAddress: invoice.pay_to_address,
      expectedAmount: invoice.amount_unit,
      expectedDecimals: invoice.amount_decimals,
      expectedMemo: invoice.memo,
    });

    this.audit.log('crypto.invoice_recheck', {
      actorUserId: input.actorUserId,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: {
        chain: invoice.chain,
        txHash: invoice.tx_hash,
        actorIsAdmin: input.actorIsAdmin,
        verification: {
          found: ver.found,
          state: ver.state,
          confirmations: ver.confirmations,
          amount: ver.amount,
        },
      },
    });

    if (!ver.found || ver.state === 'pending') {
      this.invoices.updateConfirmations(invoice.id, 0);
      return { invoice: this.invoices.findById(invoice.id) ?? invoice, verification: ver };
    }
    if (ver.state === 'failed') {
      const updated = this.invoices.setFailure(invoice.id, 'tx reverted on-chain') ?? invoice;
      this.audit.log('crypto.invoice_failed', {
        actorUserId: input.actorUserId,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: { reason: 'tx_reverted_at_recheck', txHash: invoice.tx_hash },
      });
      return { invoice: updated, verification: ver };
    }

    let updated =
      this.invoices.updateConfirmations(invoice.id, ver.confirmations) ?? invoice;
    if (ver.confirmations >= invoice.required_confirmations && updated.applied_at === null) {
      updated = await this.applyCreditsForInvoice(updated);
    }
    return { invoice: updated, verification: ver };
  }

  /**
   * Admin-only override: apply credits regardless of the on-chain
   * confirmation threshold. Use case: an operator manually verified the
   * tx out of band (block explorer, etc.) and wants to credit the user
   * now without waiting. Refuses to act on invoices that don't have a
   * tx_hash attached — admins must use {@link adminAttachHash} first.
   */
  async forceApplyInvoice(input: {
    invoiceId: number;
    actorUserId: number;
    note?: string;
  }): Promise<CryptoInvoiceRow> {
    const invoice = this.invoices.findById(input.invoiceId);
    if (!invoice) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, `invoice ${input.invoiceId} not found`);
    }
    if (invoice.applied_at !== null) {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED,
        `invoice ${invoice.id} already applied`,
      );
    }
    if (!invoice.tx_hash) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_NOT_FOUND,
        `invoice ${invoice.id} has no tx_hash; attach one first`,
      );
    }

    this.audit.log('crypto.invoice_force_apply_requested', {
      actorUserId: input.actorUserId,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: { txHash: invoice.tx_hash, note: input.note ?? null },
    });

    return this.applyCreditsForInvoice(invoice);
  }

  /**
   * Admin-only: attach a tx hash to an invoice in any status (including
   * expired/failed) and verify it on-chain. If the verify succeeds it
   * runs through the same dedup + credit-grant pipeline as the user
   * paste flow. Useful when a user paid late and the user-side flow
   * refuses because the invoice expired.
   */
  async adminAttachHash(input: {
    invoiceId: number;
    txHash: string;
    actorUserId: number;
    note?: string;
  }): Promise<{ invoice: CryptoInvoiceRow; verification: TxVerification }> {
    const invoice = this.invoices.findById(input.invoiceId);
    if (!invoice) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, `invoice ${input.invoiceId} not found`);
    }
    const adapter = this.adapters.get(invoice.chain);
    if (!adapter) {
      throw new AppError(ErrorCode.CRYPTO_CHAIN_DISABLED, `no adapter for ${invoice.chain}`);
    }

    // Pre-check the dedup table.
    const existing = this.invoices.findByChainAndTxHash(invoice.chain, input.txHash);
    if (existing && existing.id !== invoice.id) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_DUPLICATE,
        `tx ${input.txHash} is already attached to invoice ${existing.id}`,
      );
    }

    const ver = await adapter.verifyTx({
      txHash: input.txHash,
      expectedToAddress: invoice.pay_to_address,
      expectedAmount: invoice.amount_unit,
      expectedDecimals: invoice.amount_decimals,
      expectedMemo: invoice.memo,
    });
    if (!ver.found) {
      throw new AppError(ErrorCode.CRYPTO_TX_NOT_FOUND, `tx ${input.txHash} not found on-chain`);
    }
    if (ver.state === 'failed') {
      throw new AppError(ErrorCode.CRYPTO_TX_MISMATCH, 'tx reverted on-chain');
    }
    if (
      ver.toAddress &&
      ver.toAddress.toLowerCase() !== invoice.pay_to_address.toLowerCase()
    ) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_MISMATCH,
        `tx recipient does not match invoice address`,
      );
    }
    if (
      ver.amount === null ||
      !amountMatches({
        actual: ver.amount,
        expected: invoice.amount_unit,
        decimals: invoice.amount_decimals,
        toleranceBps: this.amountToleranceBps(),
      })
    ) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_MISMATCH,
        `tx amount ${ver.amount} does not meet expected ${invoice.amount_unit}`,
      );
    }

    let row = this.invoices.attachTxHashAdmin({
      id: invoice.id,
      txHash: input.txHash,
      fromAddress: ver.fromAddress,
    });
    row = this.invoices.updateConfirmations(row.id, ver.confirmations) ?? row;

    this.audit.log('crypto.invoice_admin_attach', {
      actorUserId: input.actorUserId,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: { txHash: input.txHash, note: input.note ?? null },
    });

    if (ver.confirmations >= invoice.required_confirmations && row.applied_at === null) {
      row = await this.applyCreditsForInvoice(row);
    }
    return { invoice: row, verification: ver };
  }

  /**
   * Wave 9.3 — let the user voluntarily cancel any of their non-confirmed
   * invoices. Allowed states: pending / submitted / confirming. The pre-9.3
   * worker could mis-attribute a stranger's transfer to a legacy invoice
   * with a non-unique amount, leaving it stuck in 'submitted'/'confirming'
   * forever without the user ever paying — they need a way to clear those
   * out and free a slot under the per-user concurrent cap.
   *
   * Safety: the underlying `cancelByUser` repo call keeps the `tx_hash`
   * sticky after cancel, so the (chain, tx_hash) UNIQUE index continues
   * to reject any future re-discovery of the same on-chain transfer. If
   * the user genuinely paid an invoice they later cancelled, admin
   * recovery (`adminAttachHash` / `forceApplyInvoice`) is required —
   * better than silently re-crediting a stranger.
   *
   * Idempotent: re-cancelling an already-cancelled invoice returns the
   * cached row without an audit double-write.
   */
  cancelInvoice(input: { user: UserRow; invoiceId: number }): CryptoInvoiceRow {
    const invoice = this.invoices.findById(input.invoiceId);
    if (!invoice) {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_NOT_FOUND,
        `invoice ${input.invoiceId} not found`,
      );
    }
    if (invoice.user_id !== input.user.id) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'this invoice belongs to another user',
      );
    }
    if (invoice.status === 'confirmed') {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED,
        `invoice ${invoice.id} already confirmed; cannot cancel`,
      );
    }
    if (
      invoice.status === 'expired' &&
      invoice.failure_reason === 'user_cancelled'
    ) {
      // Already cancelled — return as-is, no audit duplication.
      return invoice;
    }
    const cancelled = this.invoices.cancelByUser({
      id: invoice.id,
      userId: input.user.id,
    });
    if (!cancelled) {
      // Race lost — invoice flipped state under us.
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_EXPIRED,
        `invoice ${invoice.id} is no longer cancellable`,
      );
    }
    this.audit.log('crypto.invoice_user_cancelled', {
      actorUserId: input.user.id,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: {
        chain: invoice.chain,
        amount: invoice.amount_unit,
        prevStatus: invoice.status,
        hadTxHash: invoice.tx_hash !== null,
      },
    });
    return cancelled;
  }

  /**
   * Admin-only: push the expires_at deadline forward and (optionally)
   * revive an already-expired invoice back to 'pending'. The user can
   * then resume the normal flow.
   */
  extendInvoice(input: {
    invoiceId: number;
    actorUserId: number;
    minutes: number;
  }): CryptoInvoiceRow {
    if (!Number.isFinite(input.minutes) || input.minutes < 1 || input.minutes > 24 * 60 * 7) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'minutes must be in [1, 10080]');
    }
    const invoice = this.invoices.findById(input.invoiceId);
    if (!invoice) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, `invoice ${input.invoiceId} not found`);
    }
    if (invoice.status === 'confirmed') {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED,
        `invoice ${invoice.id} already confirmed; nothing to extend`,
      );
    }
    const newExpiry = new Date(Date.now() + input.minutes * 60_000).toISOString();
    const updated = this.invoices.extendExpiry({
      id: invoice.id,
      expiresAt: newExpiry,
      revive: true,
    });
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'extendExpiry returned no row');
    }
    this.audit.log('crypto.invoice_extended', {
      actorUserId: input.actorUserId,
      targetType: 'crypto_invoice',
      targetId: String(invoice.id),
      metadata: {
        minutes: input.minutes,
        oldExpiresAt: invoice.expires_at,
        newExpiresAt: newExpiry,
      },
    });
    return updated;
  }

  /* -------------------------------------------------------- read APIs --- */

  listRecentByUser(userId: number, limit = 10): CryptoInvoiceRow[] {
    return this.invoices.listRecentByUser(userId, limit);
  }

  findInvoice(id: number): CryptoInvoiceRow | undefined {
    return this.invoices.findById(id);
  }

  /** Adapter accessor — used by the worker. */
  adapterFor(chain: CryptoChainId): ChainAdapter | undefined {
    return this.adapters.get(chain);
  }

  /**
   * Registry-spec accessor for routes that need network/token/showInPicker
   * metadata without re-importing the registry. Returns undefined for
   * unknown chain ids (e.g. legacy invoices on a removed chain).
   */
  specOf(chain: CryptoChainId): ReturnType<typeof chainSpecOf> {
    return chainSpecOf(chain);
  }

  /* -------------------------------------------------------- helpers --- */

  /**
   * Chains without memo support (TRON-USDT) can't be told apart by anything
   * but the transfer amount, so we encode invoice identity into the lowest
   * digits of the amount. Strategy:
   *
   *   1. Pick a 3-digit random suffix in 1..999 base units.
   *   2. Try add (`requested + suffix`); if it would overflow `maxBase`,
   *      try subtract (`requested - suffix`).
   *   3. If a collision is found with another active invoice on the same
   *      chain, reroll up to {@link UNIQUE_AMOUNT_MAX_TRIES} times.
   *   4. As a last resort, fall back to the requested amount unchanged —
   *      the worker still has the (chain, tx_hash) UNIQUE index as a
   *      secondary dedup, so a duplicate amount only delays correct
   *      attribution by at most one tick.
   *
   * The suffix lives well inside the chain's native decimals (e.g. 0.000137
   * USDT on a 6-decimal chain), so credits accounting is anchored to the
   * user-requested amount, not the post-signature amount.
   */
  private allocateUniqueAmount(input: {
    chain: CryptoChainId;
    requestedBase: bigint;
    decimals: number;
    minBase: bigint;
    maxBase: bigint;
  }): bigint {
    for (let attempt = 0; attempt < UNIQUE_AMOUNT_MAX_TRIES; attempt++) {
      const suffix = (BigInt(randomBytes(2).readUInt16BE(0)) % 999n) + 1n;
      const candidate = this.signAmount(input.requestedBase, suffix, input.minBase, input.maxBase);
      if (candidate === null) break;
      const probe = fromBaseUnits(candidate, input.decimals);
      const collision = this.invoices.findActiveByChainAndAmount(input.chain, probe);
      if (!collision) return candidate;
    }
    return input.requestedBase;
  }

  /**
   * Apply `suffix` to `base` so the result stays inside `[minBase, maxBase]`.
   * Prefer addition; fall back to subtraction; return null if neither fits
   * (caller falls back to the original amount).
   */
  private signAmount(
    base: bigint,
    suffix: bigint,
    minBase: bigint,
    maxBase: bigint,
  ): bigint | null {
    const added = base + suffix;
    if (added <= maxBase) return added;
    const subtracted = base - suffix;
    if (subtracted >= minBase) return subtracted;
    return null;
  }

  // Wave 9.3 — env-driven defaults are sourced from `chain.registry.ts` via
  // each spec's `envConfirmations`/`envRate` accessor. The previous switch
  // statements were retired here; chainConfig() reads spec accessors directly.
}

/* ------------------------------------------------------------------------- *
 * QR / wallet-deeplink URI construction
 * ------------------------------------------------------------------------- */

/**
 * Address allowlist regexes per chain. Defense-in-depth against an address
 * containing URI-injection characters that would alter the meaning of the
 * encoded string ("?", "&", "#", whitespace).
 *
 * Wave 9.3 — extended to all 9 chain ids. EVM addresses (BSC/ETH) are 0x
 * + 40 hex; the regex accepts both upper- and lower-case. Adding a new
 * chain is one line here plus one entry in `chain.registry.ts`.
 */
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TON_ADDRESS_RE = /^(?:[A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/;

const ADDRESS_ALLOWLIST: Record<CryptoChainId, RegExp> = {
  'tron-usdt': TRON_ADDRESS_RE,
  'tron-usdc': TRON_ADDRESS_RE,
  'bsc-usdt': EVM_ADDRESS_RE,
  'bsc-usdc': EVM_ADDRESS_RE,
  'eth-usdt': EVM_ADDRESS_RE,
  'eth-usdc': EVM_ADDRESS_RE,
  'ton-native': TON_ADDRESS_RE,
  'ton-usdt-jetton': TON_ADDRESS_RE,
  'ton-usdc-jetton': TON_ADDRESS_RE,
};

/**
 * Build a QR-payable / wallet-deeplink URI for one invoice. Returns `null`
 * when the chain has no standard scheme worth emitting (the Mini App then
 * shows a bare-address QR + amount as text). Pure function — no I/O — so
 * it stays cheap to call inside the invoice creation transaction.
 *
 * Standards used:
 *   - TON family: `ton://transfer/<address>?amount=<nano>&text=<memo>` per
 *     the official TON deep link spec.
 *   - TRON-USDT: TRC-20 has no universal URI scheme. We return `null` so
 *     the Mini App renders the address alone (most TRON wallets only
 *     accept a bare address from a QR anyway).
 *
 * The address is validated against {@link ADDRESS_ALLOWLIST} before encoding;
 * an invalid address simply returns null rather than emitting a malformed URI.
 */
export function buildPaymentUri(input: {
  chain: CryptoChainId;
  address: string;
  /** Decimal string in human units (e.g. "10.5"). */
  amountUnit: string;
  /** Chain's native decimals (e.g. 9 for TON, 6 for USDT). */
  decimals: number;
  memo: string | null;
}): string | null {
  const allow = ADDRESS_ALLOWLIST[input.chain];
  if (!allow.test(input.address)) return null;

  switch (input.chain) {
    case 'tron-usdt':
    case 'tron-usdc':
      // No standard URI for TRC-20. Returning null keeps the Mini App in
      // address-only QR mode for these chains.
      return null;
    case 'bsc-usdt':
    case 'bsc-usdc':
    case 'eth-usdt':
    case 'eth-usdc':
      // EIP-681 (`ethereum:<addr>?value=…`) is technically supported by some
      // wallets but stablecoin transfers need a token-aware ABI call rather
      // than native transfer; popular mobile wallets ignore the param. Stick
      // with bare-address QR + amount-as-text — same UX as TRC-20.
      return null;
    case 'ton-native':
    case 'ton-usdt-jetton':
    case 'ton-usdc-jetton': {
      const nano = humanToBaseUnits(input.amountUnit, input.decimals);
      const params: string[] = [];
      if (nano !== null && nano > 0n) params.push(`amount=${nano.toString()}`);
      if (input.memo && /^[A-Za-z0-9._-]{1,64}$/.test(input.memo)) {
        // Memo regex stays narrow on purpose — only the chars we generate.
        params.push(`text=${encodeURIComponent(input.memo)}`);
      }
      const qs = params.length === 0 ? '' : `?${params.join('&')}`;
      return `ton://transfer/${input.address}${qs}`;
    }
  }
}

/**
 * Convert a decimal-string amount in human units to base-unit BigInt. Returns
 * null on bad input rather than throwing — `buildPaymentUri` decides how to
 * proceed.
 */
function humanToBaseUnits(amount: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  if (decimals < 0 || decimals > 30) return null;
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try {
    return BigInt((whole ?? '0') + fracPadded);
  } catch {
    return null;
  }
}
