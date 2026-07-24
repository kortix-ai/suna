import { describe, expect, test } from 'bun:test';
import {
  originRefConflicts,
  requireConnectorsConflicts,
  runtimeContextConflicts,
} from './idempotency-conflicts';

describe('originRefConflicts', () => {
  test('same origin_ref → no conflict', () => {
    expect(originRefConflicts('alice', 'alice')).toBe(false);
    expect(originRefConflicts('  alice ', 'alice')).toBe(false); // trim-normalized
  });
  test('different origin_ref → conflict (cross-end-user within an account)', () => {
    expect(originRefConflicts('alice', 'bob')).toBe(true);
  });
  test('absent vs present → conflict (deny-by-default)', () => {
    expect(originRefConflicts(undefined, 'alice')).toBe(true);
    expect(originRefConflicts('alice', undefined)).toBe(true);
    expect(originRefConflicts('alice', '   ')).toBe(true); // whitespace = absent
  });
  test('both absent → no conflict', () => {
    expect(originRefConflicts(undefined, undefined)).toBe(false);
    expect(originRefConflicts(null, '')).toBe(false);
  });
});

describe('runtimeContextConflicts', () => {
  test('same context (order-independent) → no conflict', () => {
    expect(runtimeContextConflicts({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(false);
  });
  test('different value → conflict', () => {
    expect(runtimeContextConflicts({ tenant: 'acme' }, { tenant: 'globex' })).toBe(true);
  });
  test('absent vs present → conflict', () => {
    expect(runtimeContextConflicts(undefined, { tenant: 'acme' })).toBe(true);
    expect(runtimeContextConflicts({ tenant: 'acme' }, undefined)).toBe(true);
  });
  test('both absent → no conflict', () => {
    expect(runtimeContextConflicts(undefined, null)).toBe(false);
  });
});

describe('requireConnectorsConflicts', () => {
  test('same set (order-independent, deduped) → no conflict', () => {
    expect(requireConnectorsConflicts(['gmail', 'slack'], ['slack', 'gmail'])).toBe(false);
    expect(requireConnectorsConflicts(['gmail', 'gmail'], ['gmail'])).toBe(false);
  });
  test('different required set → conflict', () => {
    expect(requireConnectorsConflicts(['gmail'], ['slack'])).toBe(true);
    expect(requireConnectorsConflicts(['gmail'], ['gmail', 'slack'])).toBe(true);
  });
  test('absent and empty both mean "no requirements" → no conflict', () => {
    expect(requireConnectorsConflicts(undefined, [])).toBe(false);
    expect(requireConnectorsConflicts([], undefined)).toBe(false);
    expect(requireConnectorsConflicts(undefined, undefined)).toBe(false);
  });
  test('absent vs a real requirement → conflict', () => {
    expect(requireConnectorsConflicts(undefined, ['gmail'])).toBe(true);
    expect(requireConnectorsConflicts(['gmail'], undefined)).toBe(true);
  });
});
