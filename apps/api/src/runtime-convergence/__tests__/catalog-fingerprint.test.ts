import { describe, expect, test } from 'bun:test';
import { fingerprintManagedLineup } from '../catalog-fingerprint';

const modelA = { id: 'kimi-k3', upstreamModelId: 'moonshot/kimi-k3', transport: 'openrouter' as const };
const modelB = { id: 'deepseek-v4.1-flash', upstreamModelId: 'deepseek/v4.1-flash', transport: 'openrouter' as const };

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

  test('moves when the SAME id now points at a different upstream model', () => {
    const before = fingerprintManagedLineup([modelA]);
    const after = fingerprintManagedLineup([{ ...modelA, upstreamModelId: 'moonshot/kimi-k3-fast' }]);
    expect(before).not.toBe(after);
  });

  test('an empty lineup still fingerprints deterministically', () => {
    expect(fingerprintManagedLineup([])).toBe(fingerprintManagedLineup([]));
  });
});
