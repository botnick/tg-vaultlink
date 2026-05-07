/**
 * Chain adapter unit tests — pure logic + mocked HTTP, no live RPC.
 *
 * Coverage focus:
 *   - Decimal helpers (`toBaseUnits` / `fromBaseUnits` / `amountMatches`)
 *     since every cost decision flows through them.
 *   - TRON USDT verifyTx: log decoding, success vs. fail receipt.
 *   - TON native verifyTx: comment extraction.
 *   - Address validation (cheap, no I/O).
 */

import { describe, expect, it } from 'vitest';
import {
  amountMatches,
  fromBaseUnits,
  toBaseUnits,
} from '../src/services/crypto/chain.types.js';
import { TronUsdtAdapter, hexToTronAddress } from '../src/services/crypto/tron.adapter.js';
import { TonNativeAdapter } from '../src/services/crypto/ton.adapter.js';

describe('chain.types — decimal helpers', () => {
  it('toBaseUnits handles whole numbers, decimals, and zero-pad', () => {
    expect(toBaseUnits('10', 6)).toBe(10_000_000n);
    expect(toBaseUnits('10.5', 6)).toBe(10_500_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('1', 9)).toBe(1_000_000_000n);
  });

  it('toBaseUnits truncates beyond declared decimals (no rounding)', () => {
    expect(toBaseUnits('0.1234567', 6)).toBe(123_456n);
  });

  it('toBaseUnits throws on malformed input', () => {
    expect(() => toBaseUnits('abc', 6)).toThrow();
    expect(() => toBaseUnits('-1', 6)).toThrow();
    expect(() => toBaseUnits('', 6)).toThrow();
  });

  it('fromBaseUnits round-trips and trims trailing zeros', () => {
    expect(fromBaseUnits(10_500_000n, 6)).toBe('10.5');
    expect(fromBaseUnits(10_000_000n, 6)).toBe('10');
    expect(fromBaseUnits(0n, 6)).toBe('0');
    expect(fromBaseUnits(1n, 6)).toBe('0.000001');
  });

  it('amountMatches enforces >= expected when tolerance is zero', () => {
    expect(amountMatches({ actual: '10', expected: '10', decimals: 6, toleranceBps: 0 })).toBe(true);
    expect(amountMatches({ actual: '9.999999', expected: '10', decimals: 6, toleranceBps: 0 })).toBe(false);
    expect(amountMatches({ actual: '10.000001', expected: '10', decimals: 6, toleranceBps: 0 })).toBe(true);
  });

  it('amountMatches honors basis-point tolerance', () => {
    // 1% (100 bps) tolerance: 9.9 USDT against expected 10 should pass.
    expect(
      amountMatches({ actual: '9.9', expected: '10', decimals: 6, toleranceBps: 100 }),
    ).toBe(true);
    // 0.5% tolerance is tighter: 9.9 fails.
    expect(
      amountMatches({ actual: '9.9', expected: '10', decimals: 6, toleranceBps: 50 }),
    ).toBe(false);
  });
});

describe('TronUsdtAdapter — address validation', () => {
  it('accepts well-formed TRON addresses', () => {
    const a = new TronUsdtAdapter();
    expect(a.validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
  });

  it('rejects malformed inputs', () => {
    const a = new TronUsdtAdapter();
    expect(a.validateAddress('not-a-tron-address')).toBe(false);
    expect(a.validateAddress('0x1234')).toBe(false);
    // Wrong length:
    expect(a.validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj')).toBe(false);
  });
});

describe('TronUsdtAdapter — hexToTronAddress', () => {
  it('encodes the USDT contract hex back to its base58 form', () => {
    // 0x41 prefix is implicit. The known USDT contract:
    //   base58: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
    //   hex (without 0x41): a614f803b6fd780986a42c78ec9c7f77e6ded13c
    const out = hexToTronAddress('a614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(out).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  });
});

describe('TronUsdtAdapter — verifyTx (mocked HTTP)', () => {
  it('returns { found: false } when the receipt is missing', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({}), { status: 200 });
    const adapter = new TronUsdtAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    const r = await adapter.verifyTx({
      txHash: 'a'.repeat(64),
      expectedToAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      expectedAmount: '10',
      expectedDecimals: 6,
    });
    expect(r.found).toBe(false);
  });

  it('parses a Transfer log and returns confirmations', async () => {
    // Mock POST /wallet/gettransactioninfobyid returning a TRC20 transfer.
    // Pre-build the canonical TRON Transfer event topic 0:
    //   keccak256("Transfer(address,address,uint256)") =
    //   0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
    const topic0 = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const fromHex = '0'.repeat(24) + 'a614f803b6fd780986a42c78ec9c7f77e6ded13c';
    const toHex = '0'.repeat(24) + 'a614f803b6fd780986a42c78ec9c7f77e6ded13c';
    // 10 USDT in base units (decimals=6) = 10_000_000 = 0x989680
    const amountHex = '0'.repeat(58) + '989680'; // 64 hex chars
    const txInfo = {
      id: 'a'.repeat(64),
      blockNumber: 1000,
      blockTimeStamp: 1714780000000,
      receipt: { result: 'SUCCESS' },
      log: [
        {
          address: 'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
          topics: [topic0, fromHex, toHex],
          data: amountHex,
        },
      ],
    };

    let postCount = 0;
    const fetchMock = async (url: string | URL) => {
      const u = String(url);
      postCount++;
      if (u.includes('gettransactioninfobyid')) {
        return new Response(JSON.stringify(txInfo), { status: 200 });
      }
      if (u.includes('getnowblock')) {
        return new Response(
          JSON.stringify({ block_header: { raw_data: { number: 1020 } } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const adapter = new TronUsdtAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    const r = await adapter.verifyTx({
      txHash: 'a'.repeat(64),
      expectedToAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      expectedAmount: '10',
      expectedDecimals: 6,
    });

    expect(r.found).toBe(true);
    expect(r.state).toBe('success');
    expect(r.amount).toBe('10');
    expect(r.confirmations).toBe(20); // 1020 - 1000
    expect(r.toAddress).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(postCount).toBeGreaterThanOrEqual(2);
  });

  it('reports state=failed when the receipt is non-SUCCESS', async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          id: 'a'.repeat(64),
          blockNumber: 1,
          receipt: { result: 'REVERT' },
          log: [],
        }),
        { status: 200 },
      );
    const adapter = new TronUsdtAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    const r = await adapter.verifyTx({
      txHash: 'b'.repeat(64),
      expectedToAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      expectedAmount: '10',
      expectedDecimals: 6,
    });
    expect(r.found).toBe(true);
    expect(r.state).toBe('failed');
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = async () => new Response('boom', { status: 500 });
    const adapter = new TronUsdtAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(
      adapter.verifyTx({
        txHash: 'c'.repeat(64),
        expectedToAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        expectedAmount: '10',
        expectedDecimals: 6,
      }),
    ).rejects.toThrow();
  });
});

describe('TonNativeAdapter — address validation', () => {
  it('accepts EQ.../UQ... and raw 0:hex forms', () => {
    const a = new TonNativeAdapter();
    expect(a.validateAddress('EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJDM2c5jZc4hF1F1bv-i')).toBe(true);
    expect(
      a.validateAddress(
        '0:0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).toBe(true);
  });

  it('rejects malformed inputs', () => {
    const a = new TonNativeAdapter();
    expect(a.validateAddress('garbage')).toBe(false);
    expect(a.validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(false);
  });
});
