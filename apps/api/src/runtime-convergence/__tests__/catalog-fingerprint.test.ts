import { describe, expect, test } from 'bun:test';
import { fingerprintManagedLineup } from '../catalog-fingerprint';

const modelA = { id: 'kimi-k3' };
const modelB = { id: 'deepseek-v4.1-flash' };

describe('fingerprintManagedLineup', () => {
  test('is a hex digest', () => {
    const fp = fingerprintManagedLineup([modelA]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is order-independent — the served set is what matters, not array order', () => {
    expect(fingerprintManagedLineup([modelA, modelB])).toBe(fingerprintManagedLineup([modelB, modelA]));
  });

  test('moves when a model is added or removed', () => {
    const withOne = fingerprintManagedLineup([modelA]);
    const withTwo = fingerprintManagedLineup([modelA, modelB]);
    expect(withOne).not.toBe(withTwo);
  });

  test('an empty lineup still fingerprints deterministically', () => {
    expect(fingerprintManagedLineup([])).toBe(fingerprintManagedLineup([]));
  });
});
