import { describe, expect, test } from 'bun:test';
import { resolveWarmConfig, warmBoxReapReason } from '../platform/services/warm-pool';

describe('resolveWarmConfig', () => {
  // Default size comes from KORTIX_WARM_POOL_SIZE (operator default), so just
  // assert the per-project UI value is honored over it.
  test('honors the per-project UI value', () => {
    expect(resolveWarmConfig({ warm_pool: { enabled: false, size: 3 } })).toEqual({ enabled: false, size: 3 });
    expect(resolveWarmConfig({ warm_pool: { enabled: true, size: 0 } })).toEqual({ enabled: true, size: 0 });
  });
  test('clamps oversized size', () => {
    expect(resolveWarmConfig({ warm_pool: { enabled: true, size: 999 } })).toEqual({ enabled: true, size: 10 });
  });
  test('defaults to enabled when unset', () => {
    expect(resolveWarmConfig(null).enabled).toBe(true);
    expect(resolveWarmConfig({}).enabled).toBe(true);
  });
});

describe('warmBoxReapReason', () => {
  const base = { status: 'active', createdAt: new Date(1000), updatedAt: new Date(1000) };
  const now = 1000;

  test('keeps a fresh parked box', () => {
    expect(warmBoxReapReason({ ...base, poolState: 'parked' }, now)).toBeNull();
  });
  test('reaps explicitly marked boxes', () => {
    expect(warmBoxReapReason({ ...base, poolState: 'reap' }, now)).toBe('marked');
  });
  test('reaps errored boxes', () => {
    expect(warmBoxReapReason({ ...base, poolState: 'booting', status: 'error' }, now)).toBe('errored');
  });
  test('reaps a box stuck booting past the timeout', () => {
    const created = new Date(0);
    expect(warmBoxReapReason({ ...base, poolState: 'booting', createdAt: created }, 10 * 60_000, { bootTimeoutMs: 60_000 })).toBe('boot-timeout');
    expect(warmBoxReapReason({ ...base, poolState: 'booting', createdAt: created }, 30_000, { bootTimeoutMs: 60_000 })).toBeNull();
  });
  test('ages out a long-parked box (snapshot drift cycling)', () => {
    const created = new Date(0);
    expect(warmBoxReapReason({ ...base, poolState: 'parked', createdAt: created }, 10 * 60_000, { maxAgeMs: 60_000 })).toBe('aged-out');
  });
});
