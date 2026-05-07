/**
 * CryptoTopupWorker — background poller for crypto top-up invoices.
 *
 * Two responsibilities per tick:
 *
 *   1. Re-poll invoices in 'submitted' / 'confirming' state — recompute
 *      confirmations, advance to 'confirmed' (and apply credits) when
 *      threshold is reached.
 *
 *   2. Auto-discover incoming transfers for invoices in 'pending' state
 *      that the user hasn't manually attached a hash to yet. We query
 *      each adapter's `listRecentTransfers`, match against pending
 *      invoices on the same chain by amount + memo, and pull the matching
 *      tx through the same submitTxHash code path so all dedup /
 *      idempotency guarantees apply.
 *
 *   3. Expire pending invoices past their TTL.
 *
 * Single-process by design: the (chain, tx_hash) UNIQUE index is the
 * cross-instance backstop, but we don't expect two workers to run.
 */

import { getLogger } from '../../logger/logger.js';
import type { CryptoTopupService } from './cryptoTopup.service.js';
import type { CryptoInvoiceRepository } from '../../repositories/cryptoInvoice.repository.js';
import type { CryptoInvoiceRow } from '../../types/index.js';
import type { AuditService } from '../audit.service.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

const POLL_BATCH_SIZE = 50;
/** Don't block the process; let .unref() take effect on the timer. */
const TICK_BACKOFF_MS_ON_ERROR = 5_000;

export interface CryptoTopupWorkerDeps {
  service: CryptoTopupService;
  invoices: CryptoInvoiceRepository;
  audit: AuditService;
}

export class CryptoTopupWorker {
  private readonly service: CryptoTopupService;
  private readonly invoices: CryptoInvoiceRepository;
  private readonly audit: AuditService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inflight = false;

  constructor(deps: CryptoTopupWorkerDeps) {
    this.service = deps.service;
    this.invoices = deps.invoices;
    this.audit = deps.audit;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(this.intervalMs());
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Single-tick API — exposed for tests so they can drive the worker deterministically. */
  async tick(): Promise<{
    polled: number;
    confirmed: number;
    expired: number;
    discovered: number;
  }> {
    const log = getLogger();
    if (!this.service.isEnabled()) {
      return { polled: 0, confirmed: 0, expired: 0, discovered: 0 };
    }

    const pollIntervalMs = this.service.pollIntervalSeconds() * 1000;
    const cutoffIso = new Date(Date.now() - pollIntervalMs).toISOString();
    const due = this.invoices.listPendingForPoll(cutoffIso, POLL_BATCH_SIZE);

    let polled = 0;
    let confirmed = 0;
    let expired = 0;
    let discovered = 0;
    const nowMs = Date.now();

    for (const invoice of due) {
      polled++;
      // Expire stale pending-with-no-tx invoices first.
      if (
        invoice.status === 'pending' &&
        invoice.tx_hash === null &&
        new Date(invoice.expires_at).getTime() < nowMs
      ) {
        this.invoices.expireIfStale(invoice.id);
        this.audit.log('crypto.invoice_expired', {
          actorUserId: invoice.user_id,
          targetType: 'crypto_invoice',
          targetId: String(invoice.id),
          metadata: {
            chain: invoice.chain,
            amount: invoice.amount_unit,
            expiresAt: invoice.expires_at,
          },
        });
        expired++;
        continue;
      }

      try {
        if (invoice.tx_hash) {
          const advanced = await this.refreshTxConfirmations(invoice);
          if (advanced) confirmed++;
        } else {
          const found = await this.tryDiscoverPayment(invoice);
          if (found) {
            discovered++;
            // tryDiscoverPayment has already attached + maybe applied;
            // count it as a confirmation when the attached payment had
            // sufficient confirmations.
            const refreshed = this.invoices.findById(invoice.id);
            if (refreshed?.status === 'confirmed') confirmed++;
          } else {
            // Touch last_polled_at so the cutoff window advances.
            this.invoices.updateConfirmations(invoice.id, invoice.confirmations);
          }
        }
      } catch (err) {
        // Network resets (ECONNRESET / fetch failed / read timeout) are
        // routine on long-running RPC clients — TronGrid / toncenter
        // recycle TLS connections under load. The worker just retries on
        // the next tick, so log at debug level to keep the warn feed
        // signal-rich. RPC-level errors that the adapter has already
        // wrapped in `AppError(CRYPTO_RPC_ERROR)` carry an explicit code
        // we can surface; everything else stays at debug.
        const code =
          err instanceof AppError && err.code === ErrorCode.CRYPTO_RPC_ERROR
            ? 'rpc_error'
            : isTransientNetworkError(err)
              ? 'transient_network'
              : 'unknown';
        if (code === 'unknown') {
          log.warn(
            { err, invoiceId: invoice.id, chain: invoice.chain },
            'crypto worker: invoice poll failed',
          );
        } else {
          log.debug(
            { invoiceId: invoice.id, chain: invoice.chain, code },
            'crypto worker: invoice poll skipped (transient)',
          );
        }
      }
    }
    return { polled, confirmed, expired, discovered };
  }

  /* ----------------------------------------------------------------- internals -- */

  private intervalMs(): number {
    return Math.max(5, this.service.pollIntervalSeconds()) * 1000;
  }

  private scheduleNext(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.runOnce();
    }, ms);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private async runOnce(): Promise<void> {
    if (this.inflight) {
      this.scheduleNext(this.intervalMs());
      return;
    }
    this.inflight = true;
    try {
      await this.tick();
    } catch (err) {
      getLogger().error({ err }, 'crypto worker tick crashed');
      this.scheduleNext(TICK_BACKOFF_MS_ON_ERROR);
      this.inflight = false;
      return;
    }
    this.inflight = false;
    this.scheduleNext(this.intervalMs());
  }

  /**
   * For an invoice whose user already pasted a tx_hash: re-verify the
   * tx, update confirmations, and apply credits when the threshold is
   * reached. Returns true when the invoice flipped to 'confirmed' on
   * this tick.
   */
  private async refreshTxConfirmations(invoice: CryptoInvoiceRow): Promise<boolean> {
    if (!invoice.tx_hash) return false;
    const adapter = this.service.adapterFor(invoice.chain);
    if (!adapter) return false;

    const ver = await adapter.verifyTx({
      txHash: invoice.tx_hash,
      expectedToAddress: invoice.pay_to_address,
      expectedAmount: invoice.amount_unit,
      expectedDecimals: invoice.amount_decimals,
      expectedMemo: invoice.memo,
    });

    if (!ver.found || ver.state === 'pending') {
      this.invoices.updateConfirmations(invoice.id, 0);
      return false;
    }
    if (ver.state === 'failed') {
      this.invoices.setFailure(invoice.id, 'tx reverted on-chain');
      return false;
    }

    // Wave 9.3 — defense-in-depth re-verification on every poll. The
    // legacy worker only re-checked confirmations and trusted whatever
    // tx_hash had been attached. Combined with the old `actual >= expected`
    // amount-match, that meant a stranger's larger transfer attached at
    // submit-time would EVENTUALLY credit the wrong user once confirmations
    // crossed the threshold. We now re-validate the on-chain tx still
    // matches the invoice's address + amount on every refresh; mismatches
    // get parked in 'failed' state with an audit-loggable reason so support
    // can review before any credit lands. This is the load-bearing money-
    // safety check for invoices already in the submitted/confirming queue.
    const meta = parseMetadata(invoice.metadata_json);
    const hasMemoSignature = invoice.memo !== null && invoice.memo !== '';
    const hasAmountSignature = meta?.unique_suffix === true;
    const exactRequired = !hasMemoSignature;

    if (
      ver.toAddress &&
      ver.toAddress.toLowerCase() !== invoice.pay_to_address.toLowerCase()
    ) {
      this.invoices.setFailure(invoice.id, 'attribution_mismatch_address');
      this.audit.log('crypto.invoice_failed', {
        actorUserId: invoice.user_id,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: {
          reason: 'attribution_mismatch_address',
          expected: invoice.pay_to_address,
          actual: ver.toAddress,
          txHash: invoice.tx_hash,
        },
      });
      return false;
    }
    if (
      ver.amount === null ||
      !this.amountMeetsExpected(
        ver.amount,
        invoice.amount_unit,
        invoice.amount_decimals,
        { exactRequired },
      )
    ) {
      this.invoices.setFailure(invoice.id, 'attribution_mismatch_amount');
      this.audit.log('crypto.invoice_failed', {
        actorUserId: invoice.user_id,
        targetType: 'crypto_invoice',
        targetId: String(invoice.id),
        metadata: {
          reason: 'attribution_mismatch_amount',
          expected: invoice.amount_unit,
          actual: ver.amount,
          exactRequired,
          unique_suffix: hasAmountSignature,
          txHash: invoice.tx_hash,
        },
      });
      return false;
    }

    this.invoices.updateConfirmations(invoice.id, ver.confirmations);

    if (ver.confirmations >= invoice.required_confirmations) {
      const refreshed = this.invoices.findById(invoice.id);
      if (refreshed) {
        await this.service.applyCreditsForInvoice(refreshed);
        return true;
      }
    }
    return false;
  }

  /**
   * For pending invoices, list recent transfers to the receiving address
   * and try to attach the first one matching the invoice's expected
   * amount (and memo, when supported).
   */
  private async tryDiscoverPayment(invoice: CryptoInvoiceRow): Promise<boolean> {
    const adapter = this.service.adapterFor(invoice.chain);
    if (!adapter) return false;

    const sinceIso = invoice.created_at;
    const transfers = await adapter.listRecentTransfers({
      address: invoice.pay_to_address,
      sinceIso,
      limit: 50,
    });
    if (transfers.length === 0) return false;

    const dustBase = this.dustBaseUnits(invoice.amount_decimals);

    // Wave 9.3 — disambiguation contract. The worker can only auto-attribute
    // a transfer to an invoice when ONE of these holds:
    //   1. The invoice carries a memo (TON jetton family) — memo on-chain
    //      uniquely identifies the recipient invoice.
    //   2. The invoice opted into unique-amount allocation at creation time
    //      (`metadata.unique_suffix === true`) AND we match the amount
    //      EXACTLY (not `>=`). Without exact matching the suffix is
    //      meaningless: a stranger's slightly larger transfer would still
    //      match the next-lower invoice.
    // Pre-9.3 legacy invoices have neither — skip auto-discovery for them
    // so we never mis-attribute a stranger's transfer. Users with a
    // legacy invoice can still credit it via the manual "I paid" paste
    // flow (admin can also rescue via /admin_crypto_invoice_attach).
    const meta = parseMetadata(invoice.metadata_json);
    const hasMemoSignature = invoice.memo !== null && invoice.memo !== '';
    const hasAmountSignature = meta?.unique_suffix === true;
    if (!hasMemoSignature && !hasAmountSignature) {
      // Legacy invoice without a disambiguator — leave it to the user.
      return false;
    }

    for (const t of transfers) {
      // Skip transfers already attached to some other invoice on this chain.
      const existing = this.invoices.findByChainAndTxHash(invoice.chain, t.txHash);
      if (existing) continue;

      // Wave 9.3 — dust filter. Drops sub-threshold transfers before the
      // amount-match check so attackers can't fill the queue with
      // 0.000001 USDT pings to slow down legitimate matches.
      if (dustBase > 0n) {
        const actualBase = toBaseUnitsSafe(t.amount, invoice.amount_decimals);
        if (actualBase < dustBase) continue;
      }

      // Memo match when supported by the chain.
      if (invoice.memo && t.memo !== invoice.memo) continue;

      // Amount match. For memo-less invoices the unique-suffix is the only
      // attribution signal, so the match has to be EXACT — `>=` lets a
      // stranger's slightly-larger transfer steal the slot.
      if (
        !this.amountMeetsExpected(
          t.amount,
          invoice.amount_unit,
          invoice.amount_decimals,
          { exactRequired: !hasMemoSignature },
        )
      ) {
        continue;
      }

      try {
        // Use the service's submit path so the same dedup + verification
        // semantics apply (and audit rows are written).
        const owner = { id: invoice.user_id } as unknown as Parameters<
          typeof this.service.submitTxHash
        >[0]['user'];
        await this.service.submitTxHash({
          user: owner,
          invoiceId: invoice.id,
          txHash: t.txHash,
        });
        this.audit.log('crypto.invoice_auto_discovered', {
          actorUserId: invoice.user_id,
          targetType: 'crypto_invoice',
          targetId: String(invoice.id),
          metadata: {
            chain: invoice.chain,
            txHash: t.txHash,
            amount: t.amount,
            fromAddress: t.fromAddress,
          },
        });
        return true;
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.CRYPTO_TX_DUPLICATE) {
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  private amountMeetsExpected(
    actual: string,
    expected: string,
    decimals: number,
    opts: { exactRequired?: boolean } = {},
  ): boolean {
    try {
      const tolerance = this.service.amountToleranceBps();
      const a = toBaseUnitsSafe(actual, decimals);
      const e = toBaseUnitsSafe(expected, decimals);
      // Wave 9.3 — when the caller flagged "exact required" (memo-less
      // invoices that rely on the unique-amount suffix to disambiguate),
      // overpay is rejected on purpose: a stranger's larger transfer must
      // not be allowed to satisfy a smaller-amount pending invoice.
      if (opts.exactRequired) return a === e;
      if (tolerance <= 0) return a >= e;
      const min = (e * BigInt(10_000 - tolerance)) / 10_000n;
      return a >= min;
    } catch {
      return false;
    }
  }

  /**
   * Convert the operator's USD-denominated dust threshold into the chain's
   * base units. USDT/USDC peg to $1, so the threshold maps directly:
   *   threshold_usd × 10^decimals
   *
   * Returns 0n when dust filtering is disabled (env=0), short-circuiting
   * the filter altogether.
   */
  private dustBaseUnits(decimals: number): bigint {
    const usd = this.service.dustThresholdUsd();
    if (usd <= 0) return 0n;
    if (decimals < 0 || decimals > 30) return 0n;
    return BigInt(usd) * 10n ** BigInt(decimals);
  }
}

function toBaseUnitsSafe(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [whole, fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? '0') + padded);
}

/**
 * Recognise the routine "blip" class of network errors that bubble out of
 * `fetch`/undici when an RPC provider recycles a TLS connection or rate-
 * limits us briefly. The worker handles these by retrying on the next tick,
 * so they don't deserve a warn-level log line.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // undici TypeErrors wrap the syscall in `cause`.
  const cause = (err as { cause?: unknown }).cause;
  const messages = [
    (err as { message?: string }).message ?? '',
    typeof cause === 'object' && cause !== null
      ? ((cause as { message?: string }).message ?? '')
      : '',
  ];
  const codes = [
    (err as { code?: string }).code,
    typeof cause === 'object' && cause !== null
      ? (cause as { code?: string }).code
      : undefined,
  ];
  const transientCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EPIPE',
    'ENETRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
  ]);
  if (codes.some((c) => typeof c === 'string' && transientCodes.has(c))) return true;
  return messages.some((m) =>
    /ECONNRESET|fetch failed|socket hang up|other side closed|timeout|ETIMEDOUT|aborted/i.test(m),
  );
}

interface InvoiceMetadata {
  rate?: number;
  decimals?: number;
  /**
   * Wave 9.3 — set on memo-less invoices that opted into the unique-amount
   * disambiguator. The worker uses this flag to decide whether
   * auto-attribution is safe. Pre-9.3 legacy invoices won't carry it and
   * are therefore opted out of auto-discover entirely.
   */
  unique_suffix?: boolean;
}

/**
 * Parse the invoice's `metadata_json` blob. Pure-fail on malformed input —
 * a missing flag means "legacy invoice", which the worker handles
 * explicitly by skipping auto-discover.
 */
function parseMetadata(json: string | null): InvoiceMetadata | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as InvoiceMetadata;
  } catch {
    return null;
  }
}
