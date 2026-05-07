/**
 * VaultLink Bot — Mini App admin credit + crypto routes.
 *
 * All routes go behind {@link adminMiddleware}. Operations that materially
 * affect the economy (toggling, granting, force-applying) require founder
 * tier — the route bodies enforce that explicitly via `c.var.isFounder`.
 *
 * Endpoints:
 *   GET    /api/v1/admin/credits/settings             — full settings snapshot
 *   PATCH  /api/v1/admin/credits/settings             — toggle / set numeric
 *   POST   /api/v1/admin/credits/grant                — adjust user balance
 *   POST   /api/v1/admin/credits/setbal               — absolute set
 *   GET    /api/v1/admin/credits/stats                — global aggregates
 *
 *   PATCH  /api/v1/admin/crypto/chains/:id            — chain config
 *   POST   /api/v1/admin/crypto/chains/:id/api_key    — rotate api key
 *   GET    /api/v1/admin/crypto/invoices              — invoice queue (?status=)
 *   GET    /api/v1/admin/crypto/invoices/:id          — inspect
 *   POST   /api/v1/admin/crypto/invoices/:id/recheck  — re-poll on-chain
 *   POST   /api/v1/admin/crypto/invoices/:id/attach   — attach hash + verify
 *   POST   /api/v1/admin/crypto/invoices/:id/force    — force-apply credits
 *   POST   /api/v1/admin/crypto/invoices/:id/extend   — extend expiry
 *
 * Every mutation flows through services that audit-log internally; the
 * route layer adds NO business logic.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import { adminMiddleware } from '../middlewares.js';
import type { AppRepos, AppServices } from '../types.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import {
  CREDIT_SETTING_KEYS,
  costDecodeKeyForType,
} from '../../services/credit.service.js';
import {
  CRYPTO_SETTING_KEYS,
  chainKey,
} from '../../services/crypto/cryptoTopup.service.js';
import {
  CRYPTO_CHAIN_IDS,
  CREDIT_REASONS,
  type CryptoChainId,
} from '../../types/index.js';

export interface AdminCreditsRouteDeps {
  services: AppServices;
  repos: AppRepos;
}

const FILE_TYPES = [
  'document',
  'photo',
  'video',
  'audio',
  'voice',
  'animation',
  'sticker',
] as const;

function requireFounder(c: { var: { isFounder?: boolean } }): void {
  if (!c.var.isFounder) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'founder access required', { expose: true });
  }
}

function isCryptoChain(id: string): id is CryptoChainId {
  return (CRYPTO_CHAIN_IDS as readonly string[]).includes(id);
}

export function adminCreditsRoutes(deps: AdminCreditsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services } = deps;

  app.use('*', adminMiddleware({ services }));

  /* --------------------------------------------------- credits config --- */
  app.get('/admin/credits/settings', (c) => {
    const credits = services.credits;
    const fileTypeOverrides: Record<string, number | null> = {};
    for (const t of FILE_TYPES) {
      const v = services.settings.getNumber(costDecodeKeyForType(t));
      fileTypeOverrides[t] = typeof v === 'number' ? v : null;
    }
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        flags: {
          enabled: credits.isEnabled(),
          referralEnabled: credits.isReferralEnabled(),
          topupEnabled: credits.isTopupEnabled(),
          bypassForOwner: credits.bypassForOwner(),
          bypassForAdmin: credits.bypassForAdmin(),
        },
        numbers: {
          signupBonus: credits.signupBonusAmount(),
          costDecode: credits.costFor('decode'),
          costCollectionOpen: credits.costFor('collection_open'),
          costCollectionSendBase: credits.costFor('collection_send', { itemCount: 0 }),
          costCollectionPerItem:
            services.settings.getNumber(CREDIT_SETTING_KEYS.costCollectionPerItem) ?? 0,
          referralReward: credits.referralRewardAmount(),
          referralDailyCap: credits.referralDailyCap(),
          referralPairLifetimeCap: credits.referralPairLifetimeCap(),
          referralPairWindowMinutes: credits.referralPairWindowMinutes(),
          referralPairWindowMax: credits.referralPairWindowMax(),
          referralRedeemerMinAgeMinutes: credits.referralRedeemerMinAgeMinutes(),
        },
        fileTypeOverrides,
        topupPackages: credits.topupPackages(),
      },
    });
  });

  app.patch('/admin/credits/settings', async (c) => {
    requireFounder(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      key?: unknown;
      bool?: unknown;
      number?: unknown;
      clear?: unknown;
    };
    const key = body.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'key required', { expose: true });
    }
    if (body.clear === true) {
      services.credits.clearSetting(key, c.var.user.id);
      return c.json({ data: { key, cleared: true } });
    }
    if (typeof body.bool === 'boolean') {
      services.credits.setSetting(key, { kind: 'bool', value: body.bool }, c.var.user.id);
      return c.json({ data: { key, value: body.bool } });
    }
    if (typeof body.number === 'number' && Number.isInteger(body.number) && body.number >= 0) {
      services.credits.setSetting(
        key,
        { kind: 'number', value: body.number },
        c.var.user.id,
      );
      return c.json({ data: { key, value: body.number } });
    }
    throw new AppError(ErrorCode.INVALID_INPUT, 'must include bool/number/clear', { expose: true });
  });

  app.post('/admin/credits/grant', async (c) => {
    requireFounder(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      telegram_user_id?: unknown;
      delta?: unknown;
      note?: unknown;
    };
    const tg = typeof body.telegram_user_id === 'string' ? body.telegram_user_id : '';
    const delta = typeof body.delta === 'number' ? body.delta : NaN;
    if (!tg || !Number.isInteger(delta) || delta === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'telegram_user_id and non-zero integer delta required', {
        expose: true,
      });
    }
    const target = deps.repos.users.findByTelegramId(tg);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, `user ${tg} not found`, { expose: true });
    }
    try {
      const result = services.credits.adminAdjust({
        actorUserId: c.var.user.id,
        targetUserId: target.id,
        delta,
        ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
      });
      return c.json({
        data: {
          telegram_user_id: tg,
          delta,
          balanceAfter: result.balanceAfter,
        },
      });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  app.post('/admin/credits/setbal', async (c) => {
    requireFounder(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      telegram_user_id?: unknown;
      balance?: unknown;
      note?: unknown;
    };
    const tg = typeof body.telegram_user_id === 'string' ? body.telegram_user_id : '';
    const balance = typeof body.balance === 'number' ? body.balance : NaN;
    if (!tg || !Number.isInteger(balance) || balance < 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'telegram_user_id and non-negative balance required', {
        expose: true,
      });
    }
    const target = deps.repos.users.findByTelegramId(tg);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, `user ${tg} not found`, { expose: true });
    }
    const result = services.credits.adminSet({
      actorUserId: c.var.user.id,
      targetUserId: target.id,
      targetBalance: balance,
      ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
    });
    return c.json({
      data: { telegram_user_id: tg, balance, delta: result.delta },
    });
  });

  app.get('/admin/credits/stats', (c) => {
    const start = '1970-01-01T00:00:00.000Z';
    const totals: Record<string, number> = {};
    for (const reason of CREDIT_REASONS) {
      totals[reason] = deps.repos.credits.globalTotalsByReason(reason, start);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { totals } });
  });

  /* ----------------------- Wave 9.2 — Stars refund + spend-lock admin --- */

  /**
   * Founder-only: trigger a Telegram Stars refund on a previously-applied
   * topup. We only kick `bot.api.refundStarPayment`; Telegram delivers a
   * `refunded_payment` service message that the topup router converts into
   * the actual ledger reversal — single code path, no double-bookkeeping.
   *
   * Body: { telegram_user_id, payment_charge_id, note? }
   */
  app.post('/admin/credits/refund', async (c) => {
    requireFounder(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      telegram_user_id?: unknown;
      payment_charge_id?: unknown;
      note?: unknown;
    };
    const tg = typeof body.telegram_user_id === 'string' ? body.telegram_user_id : '';
    const charge = typeof body.payment_charge_id === 'string' ? body.payment_charge_id : '';
    if (!tg || !charge) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'telegram_user_id and payment_charge_id required',
        { expose: true },
      );
    }
    // Confirm the user exists locally — Telegram's API needs a numeric id
    // it knows about, and we want a clean 404 vs a Telegram-side error.
    const target = deps.repos.users.findByTelegramId(tg);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, `user ${tg} not found`, { expose: true });
    }
    // Pre-check: the original topup must exist in our ledger.
    const original = deps.repos.credits.findTopupByPaymentChargeId(charge);
    if (!original) {
      throw new AppError(
        ErrorCode.REFUND_NOT_FOUND,
        'no matching topup ledger row for this charge id',
        { expose: true },
      );
    }
    if (deps.repos.credits.existsRefundForPaymentCharge(charge)) {
      throw new AppError(
        ErrorCode.REFUND_ALREADY_PROCESSED,
        'this charge has already been refunded',
        { expose: true },
      );
    }
    try {
      const result = await services.payments.refundStarPayment({
        telegramUserId: tg,
        paymentChargeId: charge,
        actorUserId: c.var.user.id,
        ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
      });
      // Telegram will fire `refunded_payment` to us shortly; the actual
      // ledger reversal lands then. Return 202 to be honest about the
      // async nature.
      c.header('Cache-Control', 'no-store');
      return c.json({ data: { requested: result.requested, payment_charge_id: charge } }, 202);
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  /**
   * Founder-only: clear an active spend-lock. Optional `write_off=true` also
   * grants the user back the negative balance (`admin_writeoff` ledger row
   * with the actor's id). Use case: an honest user got refunded by Telegram
   * support for a legitimate reason — operator forgives the deficit.
   *
   * Body: { telegram_user_id, write_off?, note? }
   */
  app.post('/admin/credits/clear-lock', async (c) => {
    requireFounder(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      telegram_user_id?: unknown;
      write_off?: unknown;
      note?: unknown;
    };
    const tg = typeof body.telegram_user_id === 'string' ? body.telegram_user_id : '';
    if (!tg) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'telegram_user_id required', { expose: true });
    }
    const target = deps.repos.users.findByTelegramId(tg);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, `user ${tg} not found`, { expose: true });
    }
    const result = services.credits.clearSpendLock({
      actorUserId: c.var.user.id,
      targetUserId: target.id,
      writeOffNegativeBalance: body.write_off === true,
      ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        telegram_user_id: tg,
        balance_after: result.balanceAfter,
        wrote_off: result.wroteOff,
      },
    });
  });

  /**
   * List the most recent topups admin can refund. Surfaces telegram_payment
   * charge ids alongside the corresponding user so the operator doesn't
   * have to dig through audit logs to drive the refund flow.
   */
  app.get('/admin/credits/topups', (c) => {
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1),
      200,
    );
    // Pull the most recent 'topup' ledger rows directly via a raw SQL
    // query through the existing repos.audit pattern would require a new
    // ledger method. We'll use the credit repo's listByUser would be O(N)
    // per user; instead reach into the audit log: every topup writes a
    // 'credits.topup' audit row with paymentChargeId in metadata. The
    // existing repos.audit.list already supports filtering by `action`,
    // so this stays cheap and reuses the index on `idx_audit_action`.
    const rows = deps.repos.audit.list({ limit, offset: 0, action: 'credits.topup' });
    const userCache = new Map<number, { telegram_user_id: string; username: string | null }>();
    const items = rows.map((r) => {
      let user: { telegram_user_id: string; username: string | null } | null = null;
      if (r.actor_user_id !== null) {
        let cached = userCache.get(r.actor_user_id);
        if (cached === undefined) {
          const u = deps.repos.users.findById(r.actor_user_id);
          cached = u
            ? { telegram_user_id: u.telegram_user_id, username: u.username }
            : { telegram_user_id: '', username: null };
          userCache.set(r.actor_user_id, cached);
        }
        user = cached;
      }
      let meta: { credits?: number; stars?: number; paymentChargeId?: string } = {};
      try {
        if (r.metadata_json) meta = JSON.parse(r.metadata_json);
      } catch {
        // tolerate malformed
      }
      return {
        id: r.id,
        actor_user_id: r.actor_user_id,
        user,
        credits: meta.credits ?? null,
        stars: meta.stars ?? null,
        payment_charge_id: meta.paymentChargeId ?? null,
        created_at: r.created_at,
        // Surface whether it was already refunded so the UI can disable
        // the button on rows that no longer need an action.
        refunded:
          typeof meta.paymentChargeId === 'string'
            ? deps.repos.credits.existsRefundForPaymentCharge(meta.paymentChargeId)
            : false,
      };
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items } });
  });

  /* ---------------------------------------------------- crypto admin --- */
  app.patch('/admin/crypto/chains/:id', async (c) => {
    requireFounder(c);
    const id = c.req.param('id');
    if (!isCryptoChain(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'unknown chain', { expose: true });
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
      address?: unknown;
      confirmations?: unknown;
      rate?: unknown;
      min_amount?: unknown;
      max_amount?: unknown;
    };

    const updates: Record<string, unknown> = {};

    if (typeof body.address === 'string') {
      const adapter = services.crypto.adapterFor(id);
      if (adapter && body.address.length > 0 && !adapter.validateAddress(body.address)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'invalid address for this chain', {
          expose: true,
        });
      }
      services.settings.setString(chainKey(id, 'address'), body.address);
      services.audit.log('crypto.address_changed', {
        actorUserId: c.var.user.id,
        targetType: 'setting',
        targetId: chainKey(id, 'address'),
        metadata: { chain: id, address: body.address, source: 'miniapp' },
      });
      updates.address = body.address;
    }
    if (typeof body.enabled === 'boolean') {
      const cfg = services.crypto.chainConfig(id);
      if (body.enabled && (!cfg || cfg.address.length === 0)) {
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          'set address before enabling this chain',
          { expose: true },
        );
      }
      services.credits.setSetting(
        chainKey(id, 'enabled'),
        { kind: 'bool', value: body.enabled },
        c.var.user.id,
      );
      updates.enabled = body.enabled;
    }
    if (typeof body.confirmations === 'number' && Number.isInteger(body.confirmations) && body.confirmations >= 1) {
      services.credits.setSetting(
        chainKey(id, 'confirmations'),
        { kind: 'number', value: body.confirmations },
        c.var.user.id,
      );
      updates.confirmations = body.confirmations;
    }
    if (typeof body.rate === 'number' && Number.isInteger(body.rate) && body.rate >= 1) {
      services.credits.setSetting(
        chainKey(id, 'rate'),
        { kind: 'number', value: body.rate },
        c.var.user.id,
      );
      updates.rate = body.rate;
    }
    if (typeof body.min_amount === 'string' && /^\d+(\.\d+)?$/.test(body.min_amount)) {
      services.settings.setString(chainKey(id, 'min_amount'), body.min_amount);
      services.audit.log('crypto.min_amount_changed', {
        actorUserId: c.var.user.id,
        targetType: 'setting',
        targetId: chainKey(id, 'min_amount'),
        metadata: { chain: id, value: body.min_amount },
      });
      updates.min_amount = body.min_amount;
    }
    if (typeof body.max_amount === 'string' && /^\d+(\.\d+)?$/.test(body.max_amount)) {
      services.settings.setString(chainKey(id, 'max_amount'), body.max_amount);
      services.audit.log('crypto.max_amount_changed', {
        actorUserId: c.var.user.id,
        targetType: 'setting',
        targetId: chainKey(id, 'max_amount'),
        metadata: { chain: id, value: body.max_amount },
      });
      updates.max_amount = body.max_amount;
    }
    return c.json({ data: { id, updates, config: services.crypto.chainConfig(id) } });
  });

  app.post('/admin/crypto/chains/:id/api_key', async (c) => {
    requireFounder(c);
    const id = c.req.param('id');
    if (!isCryptoChain(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'unknown chain', { expose: true });
    }
    const body = (await c.req.json().catch(() => ({}))) as { api_key?: unknown };
    const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
    services.settings.setString(chainKey(id, 'api_key'), apiKey);
    services.audit.log('crypto.apikey_changed', {
      actorUserId: c.var.user.id,
      targetType: 'setting',
      targetId: chainKey(id, 'api_key'),
      metadata: { chain: id, source: 'miniapp', length: apiKey.length },
    });
    return c.json({ data: { id, ok: true } });
  });

  app.get('/admin/crypto/invoices', (c) => {
    const status = c.req.query('status') ?? '';
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1),
      200,
    );
    const offset = Math.max(Number.parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);
    const rows = status
      ? deps.repos.cryptoInvoices.listByStatusForAdmin(status, limit, offset)
      : deps.repos.cryptoInvoices.listRecentForAdmin(limit, offset);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: rows });
  });

  app.get('/admin/crypto/invoices/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    const inv = services.crypto.findInvoice(id);
    if (!inv) {
      throw new AppError(ErrorCode.CRYPTO_INVOICE_NOT_FOUND, 'invoice not found', { expose: true });
    }
    return c.json({ data: inv });
  });

  app.post('/admin/crypto/invoices/:id/recheck', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    try {
      const result = await services.crypto.recheckInvoice({
        invoiceId: id,
        actorUserId: c.var.user.id,
        actorIsAdmin: true,
      });
      return c.json({ data: result.invoice });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  app.post('/admin/crypto/invoices/:id/attach', async (c) => {
    requireFounder(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    const body = (await c.req.json().catch(() => ({}))) as { tx_hash?: unknown; note?: unknown };
    const tx = typeof body.tx_hash === 'string' ? body.tx_hash : '';
    if (!/^[0-9a-fA-F]{32,128}$/.test(tx)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'tx_hash must be hex 32-128 chars', {
        expose: true,
      });
    }
    try {
      const result = await services.crypto.adminAttachHash({
        invoiceId: id,
        txHash: tx,
        actorUserId: c.var.user.id,
        ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
      });
      return c.json({ data: result.invoice });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  app.post('/admin/crypto/invoices/:id/force', async (c) => {
    requireFounder(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
    try {
      const inv = await services.crypto.forceApplyInvoice({
        invoiceId: id,
        actorUserId: c.var.user.id,
        ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
      });
      return c.json({ data: inv });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  app.post('/admin/crypto/invoices/:id/extend', async (c) => {
    requireFounder(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
    }
    const body = (await c.req.json().catch(() => ({}))) as { minutes?: unknown };
    const minutes = typeof body.minutes === 'number' ? body.minutes : NaN;
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'minutes must be a positive integer', {
        expose: true,
      });
    }
    try {
      const inv = services.crypto.extendInvoice({
        invoiceId: id,
        actorUserId: c.var.user.id,
        minutes,
      });
      return c.json({ data: inv });
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, err.message, { expose: true, ...(err.meta ? { meta: err.meta } : {}) });
      }
      throw err;
    }
  });

  // Touch settings keys imports so tree-shake doesn't drop them.
  void CRYPTO_SETTING_KEYS;
  void CREDIT_SETTING_KEYS;

  return app;
}
