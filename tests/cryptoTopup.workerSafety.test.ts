/**
 * Money-safety tests for the auto-discover path in CryptoTopupWorker.
 *
 * The worker takes the `tx_hash` of a transfer it sees on-chain and binds
 * it to a pending invoice. Wrong attribution = real money credited to the
 * wrong user. These tests pin the load-bearing safeguards so any future
 * refactor that loosens them fails loudly:
 *
 *   1. Pre-9.3 legacy invoices (no unique_suffix flag, no memo) MUST NOT
 *      be auto-attributed — stranger transfers would otherwise steal
 *      their slot.
 *   2. Wave 9.3 unique-suffix invoices MUST require an EXACT amount match.
 *      `actual >= expected` would let a slightly-larger transfer satisfy
 *      a smaller-amount invoice on the next position — credits would land
 *      on the wrong user.
 *   3. Two concurrent invoices with adjacent unique-amount suffixes MUST
 *      be attributed to the right one, not whichever was iterated first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the process-wide logger before anything pulls it in. The worker's
// `tick()` calls `getLogger()`, which would normally trigger `getConfig()`
// (Zod-validated env), and tests don't ship a populated `process.env`.
vi.mock('../src/logger/logger.js', () => {
  const log = {
    debug: console.log,
    info: console.log,
    warn: console.warn,
    error: console.error,
    fatal: console.error,
    trace: console.log,
    silent: () => undefined,
    level: 'silent',
    child: () => log,
  };
  return {
    getLogger: () => log,
    createLogger: () => log,
    resetLoggerForTests: () => undefined,
  };
});

import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import {
  CryptoTopupService,
  chainKey,
} from '../src/services/crypto/cryptoTopup.service.js';
import { CryptoTopupWorker } from '../src/services/crypto/cryptoTopup.worker.js';
import { CreditService } from '../src/services/credit.service.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import { CryptoInvoiceRepository } from '../src/repositories/cryptoInvoice.repository.js';
import { SettingsService } from '../src/services/settings.service.js';
import { AuditService } from '../src/services/audit.service.js';
import type {
  ChainAdapter,
  RecentTransfer,
  TxVerification,
} from '../src/services/crypto/chain.types.js';
import type { CryptoChainId, UserRow } from '../src/types/index.js';

const MIRROR_AMOUNT = '__MIRROR__';

interface AdapterStub extends ChainAdapter {
  next: TxVerification;
  recent: RecentTransfer[];
}

function makeStub(): AdapterStub {
  return {
    id: 'tron-usdt',
    label: 'tron-usdt',
    memoSupported: false,
    nativeDecimals: 6,
    validateAddress: () => true,
    next: {
      found: true,
      state: 'success',
      confirmations: 50,
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    },
    recent: [],
    async verifyTx(args) {
      const next = this.next;
      if (next.amount === MIRROR_AMOUNT) {
        return { ...next, amount: args.expectedAmount };
      }
      return next;
    },
    async listRecentTransfers() {
      return this.recent;
    },
  } as AdapterStub;
}

let env: TestEnv;
let credits: CreditRepository;
let invoices: CryptoInvoiceRepository;
let svc: CryptoTopupService;
let worker: CryptoTopupWorker;
let adapter: AdapterStub;
let user: UserRow;
let stranger: UserRow;

beforeEach(() => {
  env = buildTestEnv({ ENABLE_CRYPTO_TOPUP: true });
  const settings = new SettingsService(env.repos.settings);
  const audit = new AuditService(env.repos.audit);
  credits = new CreditRepository(env.db);
  const creditService = new CreditService({
    credits,
    users: env.repos.users,
    settings,
    audit,
    config: env.config,
  });
  invoices = new CryptoInvoiceRepository(env.db);
  adapter = makeStub();
  const adapters = new Map<CryptoChainId, ChainAdapter>([['tron-usdt', adapter]]);
  svc = new CryptoTopupService({
    invoices,
    settings,
    audit,
    credits: creditService,
    config: env.config,
    adapters,
  });
  worker = new CryptoTopupWorker({ service: svc, invoices, audit });

  settings.setBoolean('credits.crypto.enabled', true);
  settings.setBoolean(chainKey('tron-usdt', 'enabled'), true);
  settings.setString(chainKey('tron-usdt', 'address'), 'TXyz');
  settings.setNumber(chainKey('tron-usdt', 'rate'), 100);
  settings.setNumber(chainKey('tron-usdt', 'confirmations'), 1);

  user = seedUser(env.repos, '1001');
  stranger = seedUser(env.repos, '2002');
});

afterEach(() => env.close());

describe('worker safety — Wave 9.3 disambiguation contract', () => {
  it('does NOT auto-attribute a stranger transfer to a legacy invoice', async () => {
    // Build a legacy-shaped invoice manually: no metadata flag, no memo,
    // round amount. Mirrors what pre-9.3 deployments left in the DB.
    const legacy = invoices.insert({
      userId: user.id,
      chain: 'tron-usdt',
      amountUnit: '1',
      amountDecimals: 6,
      amountLabel: '1 USDT',
      creditsToGrant: 100,
      payToAddress: 'TXyz',
      memo: null,
      paymentUri: null,
      requiredConfirmations: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: null, // <-- no unique_suffix flag
    });

    // A stranger's "1 USDT" transfer arrives at our address.
    adapter.recent = [
      {
        txHash: 'a'.repeat(64),
        amount: '1',
        fromAddress: 'someone-else',
        toAddress: 'TXyz',
        memo: null,
        blockTime: '2026-05-07T00:00:00.000Z',
        confirmations: 5,
        state: 'success',
      },
    ];

    await worker.tick();

    const after = invoices.findById(legacy.id);
    expect(after?.status).toBe('pending');
    expect(after?.tx_hash).toBeNull();
    expect(credits.getBalance(user.id)).toBe(0);
  });

  it('only matches an EXACT amount for unique-suffix invoices', async () => {
    // Two invoices, adjacent unique amounts. A stranger transfer of
    // 1.000200 must NOT credit the lower-amount invoice (1.000050) just
    // because actual >= expected.
    const lower = invoices.insert({
      userId: user.id,
      chain: 'tron-usdt',
      amountUnit: '1.00005',
      amountDecimals: 6,
      amountLabel: '1.00005 USDT',
      creditsToGrant: 100,
      payToAddress: 'TXyz',
      memo: null,
      paymentUri: null,
      requiredConfirmations: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: { unique_suffix: true },
    });

    adapter.recent = [
      {
        txHash: 'b'.repeat(64),
        amount: '1.0002', // strictly larger — must NOT match `lower`
        fromAddress: 'someone-else',
        toAddress: 'TXyz',
        memo: null,
        blockTime: '2026-05-07T00:00:00.000Z',
        confirmations: 5,
        state: 'success',
      },
    ];

    await worker.tick();

    const after = invoices.findById(lower.id);
    expect(after?.status).toBe('pending');
    expect(after?.tx_hash).toBeNull();
    expect(credits.getBalance(user.id)).toBe(0);
  });

  it('credits the correct invoice when two unique-amount invoices race a single transfer', async () => {
    // Two unique-suffix invoices, one stranger pays exactly the second.
    // With EXACT match the worker attributes only to the matching one.
    const first = invoices.insert({
      userId: user.id,
      chain: 'tron-usdt',
      amountUnit: '1.00005',
      amountDecimals: 6,
      amountLabel: '1.00005 USDT',
      creditsToGrant: 100,
      payToAddress: 'TXyz',
      memo: null,
      paymentUri: null,
      requiredConfirmations: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: { unique_suffix: true },
    });
    const second = invoices.insert({
      userId: stranger.id,
      chain: 'tron-usdt',
      amountUnit: '1.000123',
      amountDecimals: 6,
      amountLabel: '1.000123 USDT',
      creditsToGrant: 100,
      payToAddress: 'TXyz',
      memo: null,
      paymentUri: null,
      requiredConfirmations: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: { unique_suffix: true },
    });

    adapter.recent = [
      {
        txHash: 'c'.repeat(64),
        amount: '1.000123',
        fromAddress: 'real-payer',
        toAddress: 'TXyz',
        memo: null,
        blockTime: '2026-05-07T00:00:00.000Z',
        confirmations: 5,
        state: 'success',
      },
    ];

    await worker.tick();

    expect(invoices.findById(first.id)?.status).toBe('pending');
    expect(invoices.findById(first.id)?.tx_hash).toBeNull();
    expect(credits.getBalance(user.id)).toBe(0);

    expect(invoices.findById(second.id)?.status).toBe('confirmed');
    expect(credits.getBalance(stranger.id)).toBe(100);
  });

  it('createInvoice stamps unique_suffix=true on memo-less chains', () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    const meta = JSON.parse(inv.metadata_json ?? '{}') as { unique_suffix?: boolean };
    expect(meta.unique_suffix).toBe(true);
  });
});
