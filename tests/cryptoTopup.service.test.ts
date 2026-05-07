/**
 * CryptoTopupService — covers invoice creation rules + the verify→apply
 * pipeline, with a stub adapter so we don't go to the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import { CryptoTopupService, chainKey } from '../src/services/crypto/cryptoTopup.service.js';
import { CreditService } from '../src/services/credit.service.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import { CryptoInvoiceRepository } from '../src/repositories/cryptoInvoice.repository.js';
import { SettingsService } from '../src/services/settings.service.js';
import { AuditService } from '../src/services/audit.service.js';
import type { ChainAdapter, TxVerification } from '../src/services/crypto/chain.types.js';
import type { CryptoChainId, UserRow } from '../src/types/index.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

/**
 * Sentinel for the stub's `amount` field meaning "mirror the request".
 * The unique-amount allocator (Wave 9.3) makes invoice amounts unpredictable
 * from the test's perspective, so the default stub now reflects whatever
 * amount the service asks about — happy-path tests stay one-line.
 * Tests that want to test amount-mismatch override `next.amount` explicitly.
 */
const MIRROR_AMOUNT = '__MIRROR__';

interface AdapterStub extends ChainAdapter {
  /** Last verifyTx args for assertions. */
  lastArgs: Parameters<ChainAdapter['verifyTx']>[0] | null;
  /** What the next verifyTx call should return. */
  next: TxVerification;
}

function makeStub(id: CryptoChainId, opts: { memoSupported?: boolean } = {}): AdapterStub {
  return {
    id,
    label: id,
    memoSupported: opts.memoSupported ?? true,
    nativeDecimals: id === 'tron-usdt' ? 6 : id === 'ton-native' ? 9 : 6,
    validateAddress: () => true,
    lastArgs: null,
    next: {
      found: true,
      state: 'success',
      confirmations: 100,
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    },
    async verifyTx(args) {
      this.lastArgs = args;
      if (this.next.amount === MIRROR_AMOUNT) {
        return { ...this.next, amount: args.expectedAmount };
      }
      return this.next;
    },
    async listRecentTransfers() {
      return [];
    },
  } as AdapterStub;
}

let env: TestEnv;
let credits: CreditRepository;
let creditService: CreditService;
let invoices: CryptoInvoiceRepository;
let svc: CryptoTopupService;
let settings: SettingsService;
let adapter: AdapterStub;
let user: UserRow;

function buildSvc(chain: CryptoChainId = 'tron-usdt') {
  settings = new SettingsService(env.repos.settings);
  const audit = new AuditService(env.repos.audit);
  credits = new CreditRepository(env.db);
  creditService = new CreditService({
    credits,
    users: env.repos.users,
    settings,
    audit,
    config: env.config,
  });
  invoices = new CryptoInvoiceRepository(env.db);
  adapter = makeStub(chain, { memoSupported: chain !== 'tron-usdt' });
  const adapters = new Map<CryptoChainId, ChainAdapter>([[chain, adapter]]);
  svc = new CryptoTopupService({
    invoices,
    settings,
    audit,
    credits: creditService,
    config: env.config,
    adapters,
  });

  // Enable the chain with a configured address.
  settings.setBoolean('credits.crypto.enabled', true);
  settings.setBoolean(chainKey(chain, 'enabled'), true);
  settings.setString(chainKey(chain, 'address'), 'TXyz');
  settings.setNumber(chainKey(chain, 'rate'), 100);
  settings.setNumber(chainKey(chain, 'confirmations'), 19);
}

beforeEach(() => {
  env = buildTestEnv({ ENABLE_CRYPTO_TOPUP: true });
  buildSvc();
  user = seedUser(env.repos, '1001');
});

afterEach(() => {
  env.close();
});

describe('createInvoice', () => {
  it('creates a pending invoice with credits = amount * rate', () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    expect(inv.status).toBe('pending');
    // Wave 9.3 — TRC-20 has no memo, so the service appends a unique
    // micro-suffix (.000XYZ) to the amount. Credits stay anchored to the
    // user-requested amount.
    expect(inv.amount_unit).toMatch(/^10(\.\d{1,6})?$/);
    expect(inv.credits_to_grant).toBe(1000); // 10 * 100
    expect(inv.pay_to_address).toBe('TXyz');
    expect(inv.memo).toBeNull();
    expect(inv.required_confirmations).toBe(19);
  });

  it('issues distinct amount_unit for two concurrent invoices on a memo-less chain', () => {
    const a = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    const b = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    expect(a.amount_unit).not.toBe(b.amount_unit);
  });

  it('refuses creation when the master switch is off', () => {
    settings.setBoolean('credits.crypto.enabled', false);
    expect(() =>
      svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' }),
    ).toThrow(AppError);
  });

  it('refuses creation when the chain is disabled', () => {
    settings.setBoolean(chainKey('tron-usdt', 'enabled'), false);
    expect(() =>
      svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' }),
    ).toThrow(AppError);
  });

  it('refuses amounts outside min/max', () => {
    settings.setString(chainKey('tron-usdt', 'min_amount'), '5');
    settings.setString(chainKey('tron-usdt', 'max_amount'), '50');
    expect(() => svc.createInvoice({ user, chain: 'tron-usdt', amount: '1' })).toThrow(AppError);
    expect(() => svc.createInvoice({ user, chain: 'tron-usdt', amount: '100' })).toThrow(AppError);
    // Boundaries pass.
    expect(svc.createInvoice({ user, chain: 'tron-usdt', amount: '5' }).id).toBeGreaterThan(0);
  });

  it('generates a memo on chains that support it', () => {
    buildSvc('ton-native');
    user = seedUser(env.repos, '1002');
    const inv = svc.createInvoice({ user, chain: 'ton-native', amount: '5' });
    expect(inv.memo).toMatch(/^VL-[0-9A-F]{8}$/);
  });
});

describe('submitTxHash', () => {
  it('applies credits when verifyTx confirms with enough confirmations', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 50,
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    const { invoice } = await svc.submitTxHash({
      user,
      invoiceId: inv.id,
      txHash: 'a'.repeat(64),
    });
    expect(invoice.status).toBe('confirmed');
    expect(invoice.tx_hash).toBe('a'.repeat(64));
    expect(invoice.applied_at).not.toBeNull();
    expect(credits.getBalance(user.id)).toBe(1000);
  });

  it('stays in confirming when confirmations are below threshold', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 5, // below 19
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    const { invoice } = await svc.submitTxHash({
      user,
      invoiceId: inv.id,
      txHash: 'b'.repeat(64),
    });
    expect(invoice.status).toBe('confirming');
    expect(invoice.tx_hash).toBe('b'.repeat(64));
    expect(invoice.applied_at).toBeNull();
    expect(credits.getBalance(user.id)).toBe(0);
  });

  it('rejects an invoice belonging to another user', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    const other = seedUser(env.repos, '2002');
    await expect(
      svc.submitTxHash({ user: other, invoiceId: inv.id, txHash: 'c'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it('rejects a tx_hash already used by another invoice on the same chain', async () => {
    const inv1 = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    const inv2 = svc.createInvoice({ user, chain: 'tron-usdt', amount: '5' });
    const hash = 'd'.repeat(64);

    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 50,
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await svc.submitTxHash({ user, invoiceId: inv1.id, txHash: hash });

    await expect(
      svc.submitTxHash({ user, invoiceId: inv2.id, txHash: hash }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_DUPLICATE });
  });

  it('rejects when the on-chain amount is below the invoice amount', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 50,
      amount: '9.99',
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await expect(
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: 'e'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_MISMATCH });
    expect(credits.getBalance(user.id)).toBe(0);
  });

  it('rejects when the recipient address does not match', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 50,
      // Mirror so the amount-match passes — we want the address mismatch
      // to be the reason the verify fails.
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TWrong',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await expect(
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_MISMATCH });
  });

  it('rejects a not-found tx', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: false,
      state: 'pending',
      confirmations: 0,
      amount: null,
      fromAddress: null,
      toAddress: null,
      memo: null,
      blockTime: null,
    };
    await expect(
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: '1'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_NOT_FOUND });
  });

  it('marks the invoice failed when the tx reverted', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'failed',
      confirmations: 0,
      amount: null,
      fromAddress: null,
      toAddress: null,
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await expect(
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: '2'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_MISMATCH });
    const after = invoices.findById(inv.id);
    expect(after?.status).toBe('failed');
  });

  it('is idempotent — re-submitting the same hash on an already-applied invoice errors out', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 100,
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await svc.submitTxHash({ user, invoiceId: inv.id, txHash: '3'.repeat(64) });
    expect(credits.getBalance(user.id)).toBe(1000);

    await expect(
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: '3'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED });
    // Crucially the balance stays at 1000 — no double-credit.
    expect(credits.getBalance(user.id)).toBe(1000);
  });
});

describe('listEnabledChains', () => {
  it('hides chains with no address configured', () => {
    settings.delete(chainKey('tron-usdt', 'address'));
    expect(svc.listEnabledChains()).toHaveLength(0);
  });

  it('hides chains that are disabled', () => {
    settings.setBoolean(chainKey('tron-usdt', 'enabled'), false);
    expect(svc.listEnabledChains()).toHaveLength(0);
  });
});
