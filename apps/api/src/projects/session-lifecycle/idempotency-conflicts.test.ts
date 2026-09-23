import { describe, expect, test } from 'bun:test';
import { runtimeContextConflicts } from './idempotency-conflicts';

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

