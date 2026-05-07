/**
 * VaultLink Bot — Mini App credit + crypto top-up routes.
 *
 * User-facing endpoints:
 *
 *   GET  /api/v1/credits                       — flags + balance + lifetime + Stars packages
 *   GET  /api/v1/credits/history?cursor=&limit= — paginated ledger entries
 *
 *   GET  /api/v1/crypto/chains                 — chains the user can pay on
 *   POST /api/v1/crypto/invoices               — create one
 *   GET  /api/v1/crypto/invoices               — user's recent
 *   GET  /api/v1/crypto/invoices/:id           — single invoice
 *   POST /api/v1/crypto/invoices/:id/submit    — submit a tx hash
 *   POST /api/v1/crypto/invoices/:id/recheck   — re-poll the chain
 *
 * Every successful POST returns the resulting invoice row so the SPA can
 * update its cache without an extra round trip. Errors flow through the
 * Hono onError handler in `server.ts` (which maps `AppError.expose` to 400
 * and unexposed errors to 500).
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppRepos, AppServices } from '../types.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import {
  CRYPTO_CHAIN_NETWORK,
  CRYPTO_CHAIN_TOKEN,
  CRYPTO_PICKER_CHAIN_IDS,
  type CryptoChainId,
  type CryptoInvoiceRow,
  type CryptoNetwork,
  type CryptoToken,
} from '../../types/index.js';

export interface CreditsRouteDeps {
  services: AppServices;
  repos: AppRepos;
}

interface CreditsSummaryDto {
  enabled: boolean;
  balance: number;
  lifetime: { gained: number; spent: number };
  signupBonus: number;
  referralEnabled: boolean;
  referralReward: number;
  referralDailyCap: number;
  topupEnabled: boolean;
  packages: ReadonlyArray<{ stars: number; credits: number }>;
  cryptoEnabled: boolean;
  cryptoChainsAvailable: number;
  /**
   * Wave 9.2 — Stars refund defense. When non-null and in the future, every
   * credit-spend short-circuits with SPEND_LOCKED. The Mini App renders a
   * banner with the unlock countdown.
   */
  spendLockedUntil: string | null;
  /** Lifetime count of Stars refund events (admins use it for sanity-checking). */
  refundCount: number;
  /** Lifetime sum of Stars refunded by this user. */
  totalRefundedStars: number;
}

interface CryptoChainDto {
  id: CryptoChainId;
  /** Wave 9.3 — network bucket for picker grouping (trx/bsc/eth/ton). */
  network: CryptoNetwork;
  /** Wave 9.3 — token bucket (USDT/USDC/native). */
  token: CryptoToken;
  label: string;
  enabled: boolean;
  decimals: number;
  confirmations: number;
  rate: number;
  memoSupported: boolean;
  minAmount: string;
  maxAmount: string;
  /** Address NEVER returned for disabled chains. */
  address: string | null;
  /** Whether this chain shows in the user-facing picker (false = legacy). */
  showInPicker: boolean;
  /**
   * Whether the operator has stored a custom RPC-provider API key for this
   * chain. Boolean only — the value itself stays server-side. The admin UI
   * uses this to render a "configured / using default" badge so the
   * operator knows the chain's current state without rotating blindly.
   */
  apiKeySet: boolean;
}

interface CryptoInvoiceDto {
  id: number;
  chain: CryptoChainId;
  /** Wave 9.3 — denormalised for the SPA: network + token from registry. */
  network: CryptoNetwork;
  token: CryptoToken;
  status: string;
  amount_unit: string;
  amount_decimals: number;
  amount_label: string;
  credits_to_grant: number;
  pay_to_address: string;
  memo: string | null;
  /**
   * Wave 9.2 — server-built BIP-21 / ton:// URI suitable for QR rendering.
   * `null` for chains without a standard scheme (Mini App falls back to a
   * bare-address QR + amount as text).
   */
  payment_uri: string | null;
  tx_hash: string | null;
  confirmations: number;
  required_confirmations: number;
  expires_at: string;
  paid_at: string | null;
  applied_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

function toInvoiceDto(row: CryptoInvoiceRow): CryptoInvoiceDto {
  return {
    id: row.id,
    chain: row.chain,
    network: CRYPTO_CHAIN_NETWORK[row.chain],
    token: CRYPTO_CHAIN_TOKEN[row.chain],
    status: row.status,
    amount_unit: row.amount_unit,
    amount_decimals: row.amount_decimals,
    amount_label: row.amount_label,
    credits_to_grant: row.credits_to_grant,
    pay_to_address: row.pay_to_address,
    memo: row.memo,
    payment_uri: row.payment_uri,
    tx_hash: row.tx_hash,
    confirmations: row.confirmations,
    required_confirmations: row.required_confirmations,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    applied_at: row.applied_at,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
  };
}

export function creditsRoutes(deps: CreditsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services } = deps;

  /* --------------------------------------------- summary + history --- */
  app.get('/credits', (c) => {
    const credits = services.credits;
    const u = c.var.user;
    const lifetime = credits.getLifetimeTotals(u.id);
    // Re-read the user row so `spend_locked_until` reflects any change made
    // since auth-middleware attached `c.var.user` (e.g. the admin just
    // cleared a lock — we want the banner to disappear immediately on
    // refresh, not on next session).
    const fresh = deps.repos.users.findById(u.id) ?? u;
    const dto: CreditsSummaryDto = {
      enabled: credits.isEnabled(),
      balance: lifetime.balance,
      lifetime: { gained: lifetime.gained, spent: lifetime.spent },
      signupBonus: credits.signupBonusAmount(),
      referralEnabled: credits.isReferralEnabled(),
      referralReward: credits.referralRewardAmount(),
      referralDailyCap: credits.referralDailyCap(),
      topupEnabled: credits.isTopupEnabled(),
      packages: credits.topupPackages(),
      cryptoEnabled: services.crypto.isEnabled(),
      cryptoChainsAvailable: services.crypto.listEnabledChains().length,
      spendLockedUntil: fresh.spend_locked_until,
      refundCount: fresh.refund_count,
      totalRefundedStars: fresh.total_refunded_stars,
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ data: dto });
  });

  /* ---------------------------------- Wave 9.2: Stars invoice link --- */
  app.post('/credits/stars/invoice', async (c) => {
    const body = await c.req
      .json<{ packageIndex?: unknown }>()
      .catch(() => ({}) as { packageIndex?: unknown });
    const idx = body.packageIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'packageIndex must be a non-negative integer', {
        expose: true,
      });
    }
    try {
      const result = await services.payments.createStarsInvoiceLink({
        userId: c.var.user.id,
        packageIndex: idx,
        // Localized title/desc/lineLabel come from the bot's locales bundle
        // through a tiny helper on the credit service. The Mini App never
        // sees these — they show up inside Telegram's payment sheet.
        title: 'VaultLink Credits',
        description: `Top up VaultLink credits via Telegram Stars`,
        lineLabel: 'VaultLink Credits',
      });
      c.header('Cache-Control', 'no-store');
      return c.json({
        data: {
          invoiceLink: result.invoiceLink,
          stars: result.stars,
          credits: result.credits,
          packageIndex: result.packageIndex,
        },
      });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, {
          expose: true,
          ...(err.meta ? { meta: err.meta } : {}),
        });
      }
      throw err;
    }
  });

  app.get('/credits/history', (c) => {
    const u = c.var.user;
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query('limit') ?? '30', 10) || 30, 1),
      100,
    );
    const cursor = Number.parseInt(c.req.query('cursor') ?? '0', 10) || 0;
    const rows =
      cursor > 0
        ? services.credits['creditsRepo'] // soft access — listByUserBefore
          ? deps.repos.credits.listByUserBefore(u.id, cursor, limit)
          : []
        : services.credits.getRecentHistory(u.id, limit);
    const nextCursor = rows.length === limit ? rows[rows.length - 1]?.id ?? null : null;
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        items: rows,
        next_cursor: nextCursor,
      },
    });
  });

  /* ------------------------------------------------- crypto chains --- */
  app.get('/crypto/chains', (c) => {
    const enabled = services.crypto.isEnabled();
    const items: CryptoChainDto[] = services.crypto.listChainConfigs().map((cfg) => {
      const spec = services.crypto.specOf(cfg.id);
      return {
        id: cfg.id,
        network: CRYPTO_CHAIN_NETWORK[cfg.id],
        token: CRYPTO_CHAIN_TOKEN[cfg.id],
        label: cfg.label,
        enabled: enabled && cfg.enabled && cfg.address.length > 0,
        decimals: cfg.decimals,
        confirmations: cfg.confirmations,
        rate: cfg.rate,
        memoSupported: cfg.memoSupported,
        minAmount: cfg.minAmount,
        maxAmount: cfg.maxAmount,
        // Address only for chains the user can actually pay — withhold
        // configured-but-disabled addresses so we don't leak operator
        // walking-around metadata via the public API.
        address: enabled && cfg.enabled && cfg.address.length > 0 ? cfg.address : null,
        showInPicker: spec?.showInPicker ?? false,
        apiKeySet: typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
      };
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        master_enabled: enabled,
        items,
      },
    });
  });

  /* ------------------------------------------------ crypto invoices --- */
  app.post('/crypto/invoices', async (c) => {
    const body = await c.req
      .json<{ chain?: unknown; amount?: unknown }>()
      .catch(() => ({}) as { chain?: unknown; amount?: unknown });
    const chain = body.chain;
    const amount = body.amount;
    if (
      typeof chain !== 'string' ||
      !(CRYPTO_PICKER_CHAIN_IDS as readonly string[]).includes(chain)
    ) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'chain must be one of the user-selectable stablecoin ids',
        { expose: true },
      );
    }
    if (typeof amount !== 'string' || amount.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'amount must be a decimal string', {
        expose: true,
      });
    }
    try {
      const inv = services.crypto.createInvoice({
        user: c.var.user,
        chain: chain as CryptoChainId,
        amount,
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ data: toInvoiceDto(inv) });
    } catch (err) {
      if (err instanceof AppError && !err.expose) {
        // Surface domain validation errors to the SPA without leaking
        // implementation details.
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  app.get('/crypto/invoices', (c) => {
    const u = c.var.user;
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query('limit') ?? '20', 10) || 20, 1),
      100,
    );
    const rows = services.crypto.listRecentByUser(u.id, limit);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: rows.map(toInvoiceDto) });
  });

  app.get('/crypto/invoices/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    const inv = services.crypto.findInvoice(id);
    if (!inv) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, 'invoice not found', { expose: true });
    }
    if (inv.user_id !== c.var.user.id) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'forbidden', { expose: true });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toInvoiceDto(inv) });
  });

  app.post('/crypto/invoices/:id/submit', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    const body = await c.req
      .json<{ tx_hash?: unknown }>()
      .catch(() => ({}) as { tx_hash?: unknown });
    const txHash = body.tx_hash;
    if (typeof txHash !== 'string' || !/^[0-9a-fA-F]{32,128}$/.test(txHash)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'tx_hash must be hex (32-128 chars)', {
        expose: true,
      });
    }
    try {
      const result = await services.crypto.submitTxHash({
        user: c.var.user,
        invoiceId: id,
        txHash,
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ data: toInvoiceDto(result.invoice) });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  /* ------------------------------------------------- cancel invoice --- */
  // Wave 9.3 — user voluntarily cancels their own pending invoice. Frees
  // the slot under the per-user concurrent cap so they can re-create with a
  // corrected amount/chain. Refused if a payment has already been seen
  // (tx_hash attached) — at that point the verify pipeline has to run.
  app.post('/crypto/invoices/:id/cancel', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    try {
      const inv = services.crypto.cancelInvoice({
        user: c.var.user,
        invoiceId: id,
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ data: toInvoiceDto(inv) });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, {
          expose: true,
          ...(err.meta ? { meta: err.meta } : {}),
        });
      }
      throw err;
    }
  });

  app.post('/crypto/invoices/:id/recheck', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    try {
      const result = await services.crypto.recheckInvoice({
        invoiceId: id,
        actorUserId: c.var.user.id,
        actorIsAdmin: false,
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ data: toInvoiceDto(result.invoice) });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  return app;
}
