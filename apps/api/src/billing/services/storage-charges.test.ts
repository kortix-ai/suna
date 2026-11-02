// Storage billing money logic: the rate math, the charge planner that makes
// every charge exactly once, the volume-name attribution, and the day window.
// The tick against PostgreSQL and a fake Platinum is
// storage-charges.integration.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  classifyVolumeName,
  MIN_STORAGE_CHARGE_USD,
  nextStorageCursor,
  planStorageCharge,
  storageChargeKey,
  storageChargeUsd,
  storageDaysToRead,
} from './storage-charges';

const fresh = { chargedGibHours: 0, chargeSeq: 0, pendingGibHours: null, pendingUsd: null };

describe('storageChargeUsd', () => {
  test('GiB-hours × the per-kind rate, to the ledger 10 decimals', () => {
    expect(storageChargeUsd('volume', 1000)).toBe(0.082);
    expect(storageChargeUsd('volume_snapshot', 1000)).toBe(0.055);
    expect(storageChargeUsd('scratch', 1000)).toBe(0.036);
    // A real receipt from the probe: 1942.6484406237842 GiB-hours, Platinum metered 159,297 µ$.
    expect(storageChargeUsd('volume', 1942.6484406237842)).toBe(0.1592971721);
    expect(Math.floor(storageChargeUsd('volume', 1942.6484406237842) * 1e6)).toBe(159_297);
  });
});

describe('planStorageCharge', () => {
  test('a first reading charges all of it as charge 1', () => {
    expect(planStorageCharge('volume', fresh, 100)).toEqual({ action: 'charge', seq: 1, gibHours: 100, amountUsd: 0.0082 });
  });

  test('a later reading charges only the GiB-hours past what was charged', () => {
    const state = { chargedGibHours: 100, chargeSeq: 1, pendingGibHours: null, pendingUsd: null };
    expect(planStorageCharge('volume', state, 150)).toEqual({ action: 'charge', seq: 2, gibHours: 150, amountUsd: 0.0041 });
  });

  test('the same reading again charges nothing: a replayed tick moves no money', () => {
    const state = { chargedGibHours: 150, chargeSeq: 2, pendingGibHours: null, pendingUsd: null };
    expect(planStorageCharge('volume', state, 150)).toEqual({ action: 'none' });
  });

  test('a smaller reading never refunds', () => {
    const state = { chargedGibHours: 150, chargeSeq: 2, pendingGibHours: null, pendingUsd: null };
    expect(planStorageCharge('volume', state, 120)).toEqual({ action: 'none' });
  });

  test('a pending charge replays first, with its own amount and sequence, whatever Platinum reads now', () => {
    const state = { chargedGibHours: 100, chargeSeq: 1, pendingGibHours: 150, pendingUsd: 0.0041 };
    expect(planStorageCharge('volume', state, 400)).toEqual({ action: 'replay', seq: 2, gibHours: 150, amountUsd: 0.0041 });
  });

  test('a difference below the minimum waits until it grows past it', () => {
    const tiny = (MIN_STORAGE_CHARGE_USD / 0.000082) * 0.5;
    expect(planStorageCharge('volume', fresh, tiny)).toEqual({ action: 'none' });
    expect(planStorageCharge('volume', fresh, tiny * 4).action).toBe('charge');
  });

  test('a non-finite reading charges nothing', () => {
    expect(planStorageCharge('volume', fresh, Number.NaN)).toEqual({ action: 'none' });
  });
});

test('the wallet key names the control plane, meter, volume, day and charge sequence', () => {
  expect(storageChargeKey('home', 'volume', 'vol_1', '2026-11-01', 2)).toBe('platinum-storage:home:volume:vol_1:2026-11-01:2');
});

describe('classifyVolumeName', () => {
  test('a Files drive volume', () => {
    expect(classifyVolumeName('kd-0123456789abcdef0123')).toEqual({ kind: 'drive' });
  });
  test("a session's /workspace volume carries its session id", () => {
    expect(classifyVolumeName('kws-3f2a9c1e-7d4b-4c55-9a7e-0f1e2d3c4b5a')).toEqual({
      kind: 'workspace',
      sessionId: '3f2a9c1e-7d4b-4c55-9a7e-0f1e2d3c4b5a',
    });
  });
  test('anything else is not a Kortix product volume', () => {
    for (const name of ['home', 'root-box-1', 'kd-short', 'kws-', 'KD-0123456789abcdef0123']) {
      expect(classifyVolumeName(name)).toEqual({ kind: 'other' });
    }
  });
});

describe('the day window', () => {
  test('reads the ended days from the cursor through yesterday, never today', () => {
    expect(storageDaysToRead('2026-10-29', '2026-11-01')).toEqual(['2026-10-29', '2026-10-30', '2026-10-31']);
    expect(storageDaysToRead('2026-11-01', '2026-11-01')).toEqual([]);
  });

  test('reads at most 7 days a tick, and nothing older than 14 days', () => {
    expect(storageDaysToRead('2026-10-01', '2026-11-01')).toEqual([
      '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24',
    ]);
  });

  test('the cursor keeps the last 3 ended days open for late growth', () => {
    const read = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];
    expect(nextStorageCursor('2026-10-27', '2026-11-01', read, new Set())).toBe('2026-10-29');
  });

  test('a failed day holds the cursor', () => {
    const read = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];
    expect(nextStorageCursor('2026-10-27', '2026-11-01', read, new Set(['2026-10-28']))).toBe('2026-10-28');
  });

  test('days not read this tick stay open', () => {
    expect(nextStorageCursor('2026-10-18', '2026-11-01', ['2026-10-18', '2026-10-19'], new Set())).toBe('2026-10-20');
  });

  test('a day that failed for 14 days leaves the window', () => {
    expect(nextStorageCursor('2026-10-01', '2026-11-01', [], new Set())).toBe('2026-10-18');
  });

  test('the cursor never moves back', () => {
    expect(nextStorageCursor('2026-11-01', '2026-11-01', [], new Set())).toBe('2026-11-01');
  });
});
