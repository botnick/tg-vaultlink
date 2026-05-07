/**
 * Admin recheck / force-apply / attach / extend — exercises the rescue
 * pipeline plus the audit-log requirement.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestEnv, seedUser, type TestEnv } from './helpers/testDb.js';
import {
  CryptoTopupService,
  chainKey,
} from '../src/services/crypto/cryptoTopup.service.js';
import { CreditService } from '../src/services/credit.service.js';
import { CreditRepository } from '../src/repositories/credit.repository.js';
import { CryptoInvoiceRepository } from '../src/repositories/cryptoInvoice.repository.js';
import { SettingsService } from '../src/services/settings.service.js';
import { AuditService } from '../src/services/audit.service.js';
import type { ChainAdapter, TxVerification } from '../src/services/crypto/chain.types.js';
import type { CryptoChainId, UserRow } from '../src/types/index.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

/**
 * Sentinel — the stub mirrors the requested amount when `next.amount` is
 * left at this value, so happy-path tests don't have to know about the
 * unique-suffix allocator. Tests that want amount-mismatch override
 * `next.amount` to a concrete decimal string.
 */
const MIRROR_AMOUNT = '__MIRROR__';

interface AdapterStub extends ChainAdapter {
  next: TxVerification;
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
    async verifyTx(args) {
      const next = this.next;
      if (next.amount === MIRROR_AMOUNT) {
        return { ...next, amount: args.expectedAmount };
      }
      return next;
    },
    async listRecentTransfers() {
      return [];
    },
  } as AdapterStub;
}

let env: TestEnv;
let credits: CreditRepository;
let invoices: CryptoInvoiceRepository;
let svc: CryptoTopupService;
let creditService: CreditService;
let settings: SettingsService;
let user: UserRow;
let admin: UserRow;
let adapter: AdapterStub;

function auditCount(action: string): number {
  return env.db
    .prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?')
    .get(action) as unknown as { n: number } extends infer T ? (T extends { n: number } ? number : number) : number;
}

function countAction(action: string): number {
  const row = env.db
    .prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?')
    .get(action) as { n: number };
  return row.n;
}

beforeEach(() => {
  env = buildTestEnv({ ENABLE_CRYPTO_TOPUP: true });
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

  settings.setBoolean('credits.crypto.enabled', true);
  settings.setBoolean(chainKey('tron-usdt', 'enabled'), true);
  settings.setString(chainKey('tron-usdt', 'address'), 'TXyz');
  settings.setNumber(chainKey('tron-usdt', 'rate'), 100);
  settings.setNumber(chainKey('tron-usdt', 'confirmations'), 19);

  user = seedUser(env.repos, '1001');
  admin = seedUser(env.repos, '9999', 'super_admin');
});

afterEach(() => {
  env.close();
});

describe('CryptoTopupService — recheckInvoice', () => {
  it('user can recheck their own invoice and audit-logs the call', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    // Force the invoice into 'submitted' state by attaching a hash.
    invoices.attachTxHash({ id: inv.id, txHash: 'a'.repeat(64), fromAddress: 'sender' });

    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 30,
      amount: MIRROR_AMOUNT,
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };

    const result = await svc.recheckInvoice({
      invoiceId: inv.id,
      actorUserId: user.id,
      actorIsAdmin: false,
    });

    expect(result.invoice.status).toBe('confirmed'); // 30 >= 19
    expect(credits.getBalance(user.id)).toBe(1000);
    expect(countAction('crypto.invoice_recheck')).toBeGreaterThanOrEqual(1);
    expect(countAction('crypto.invoice_applied')).toBeGreaterThanOrEqual(1);
  });

  it('user cannot recheck someone else\'s invoice', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    const other = seedUser(env.repos, '2002');
    await expect(
      svc.recheckInvoice({
        invoiceId: inv.id,
        actorUserId: other.id,
        actorIsAdmin: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it('admin can recheck any invoice', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    invoices.attachTxHash({ id: inv.id, txHash: 'b'.repeat(64), fromAddress: 'sender' });
    const result = await svc.recheckInvoice({
      invoiceId: inv.id,
      actorUserId: admin.id,
      actorIsAdmin: true,
    });
    expect(result.invoice.id).toBe(inv.id);
  });
});

describe('CryptoTopupService — forceApplyInvoice', () => {
  it('admin force-applies an invoice with a hash but below conf threshold', async () => {
    settings.setNumber(chainKey('tron-usdt', 'confirmations'), 100);
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    invoices.attachTxHash({ id: inv.id, txHash: 'c'.repeat(64), fromAddress: 'sender' });

    const result = await svc.forceApplyInvoice({
      invoiceId: inv.id,
      actorUserId: admin.id,
      note: 'verified manually on tronscan',
    });
    expect(result.status).toBe('confirmed');
    expect(credits.getBalance(user.id)).toBe(1000);
    expect(countAction('crypto.invoice_force_apply_requested')).toBe(1);
    expect(countAction('crypto.invoice_applied')).toBe(1);
  });

  it('refuses force-apply on an invoice with no tx hash', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    await expect(
      svc.forceApplyInvoice({ invoiceId: inv.id, actorUserId: admin.id }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_NOT_FOUND });
  });

  it('refuses force-apply on already-applied invoice', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    invoices.attachTxHash({ id: inv.id, txHash: 'd'.repeat(64), fromAddress: 's' });
    await svc.forceApplyInvoice({ invoiceId: inv.id, actorUserId: admin.id });
    await expect(
      svc.forceApplyInvoice({ invoiceId: inv.id, actorUserId: admin.id }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED });
  });
});

describe('CryptoTopupService — adminAttachHash', () => {
  it('admin attaches a hash to an EXPIRED invoice and verifies on-chain', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    invoices.expireIfStale(inv.id); // turns it into 'pending' still since expires_at is fresh
    // Force it expired manually via setStatus.
    invoices.setStatus(inv.id, 'expired');

    const result = await svc.adminAttachHash({
      invoiceId: inv.id,
      txHash: 'e'.repeat(64),
      actorUserId: admin.id,
      note: 'late payment rescue',
    });
    expect(result.invoice.tx_hash).toBe('e'.repeat(64));
    // Verification confirms (50 >= 19) so credits should apply automatically.
    expect(result.invoice.status).toBe('confirmed');
    expect(credits.getBalance(user.id)).toBe(1000);
    expect(countAction('crypto.invoice_admin_attach')).toBe(1);
  });

  it('rejects an attach when the on-chain amount mismatches', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 50,
      amount: '5',
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await expect(
      svc.adminAttachHash({
        invoiceId: inv.id,
        txHash: 'f'.repeat(64),
        actorUserId: admin.id,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_MISMATCH });
  });
});

describe('CryptoTopupService — extendInvoice', () => {
  it('extends and revives an expired invoice', () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    invoices.setStatus(inv.id, 'expired');

    const beforeMs = Date.now();
    const after = svc.extendInvoice({
      invoiceId: inv.id,
      actorUserId: admin.id,
      minutes: 30,
    });
    expect(after.status).toBe('pending');
    // New expiry sits ~30 min ahead of the call. Allow a comfortable
    // window so the assertion isn't flaky on slow hosts.
    const newMs = new Date(after.expires_at).getTime();
    expect(newMs).toBeGreaterThan(beforeMs + 25 * 60_000);
    expect(newMs).toBeLessThan(beforeMs + 35 * 60_000);
    expect(countAction('crypto.invoice_extended')).toBe(1);
  });

  it('refuses to extend an already-confirmed invoice', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    invoices.attachTxHash({ id: inv.id, txHash: '1'.repeat(64), fromAddress: 's' });
    await svc.forceApplyInvoice({ invoiceId: inv.id, actorUserId: admin.id });

    expect(() =>
      svc.extendInvoice({ invoiceId: inv.id, actorUserId: admin.id, minutes: 30 }),
    ).toThrow(AppError);
  });
});

describe('CryptoTopupService — audit completeness', () => {
  it('logs invoice_submit_attempt for every paste, success or fail', async () => {
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
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: '2'.repeat(64) }),
    ).rejects.toBeInstanceOf(AppError);
    expect(countAction('crypto.invoice_submit_attempt')).toBe(1);
  });

  it('logs invoice_submit_rejected with reason on amount mismatch', async () => {
    const inv = svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    adapter.next = {
      found: true,
      state: 'success',
      confirmations: 50,
      amount: '5',
      fromAddress: 'sender',
      toAddress: 'TXyz',
      memo: null,
      blockTime: '2026-05-07T00:00:00.000Z',
    };
    await expect(
      svc.submitTxHash({ user, invoiceId: inv.id, txHash: '3'.repeat(64) }),
    ).rejects.toMatchObject({ code: ErrorCode.CRYPTO_TX_MISMATCH });
    expect(countAction('crypto.invoice_submit_rejected')).toBe(1);
  });

  it('logs invoice_created on every new invoice', () => {
    svc.createInvoice({ user, chain: 'tron-usdt', amount: '10' });
    svc.createInvoice({ user, chain: 'tron-usdt', amount: '5' });
    expect(countAction('crypto.invoice_created')).toBe(2);
  });
});

// Touch the unused helper to keep the test file linter-clean if utils
// shift around.
void auditCount;
