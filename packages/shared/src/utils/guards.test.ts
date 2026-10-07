import { describe, expect, test } from 'bun:test';
import { isRecord, sleep } from './guards';

describe('guards', () => {
  test('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
  test('sleep resolves after the delay', async () => {
    const t = Date.now();
    await sleep(20);
    expect(Date.now() - t).toBeGreaterThanOrEqual(15);
  });
});
