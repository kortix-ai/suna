import { describe, expect, test } from 'bun:test';
import { humanizeBootReason } from './boot-reasons';

describe('humanizeBootReason', () => {
  test('maps known server codes to plain language with the code retained', () => {
    const out = humanizeBootReason('runtime_identity_unavailable');
    expect(out.title).toBe("The session's runtime can't be found");
    expect(out.code).toBe('runtime_identity_unavailable');
    expect(out.hint.length).toBeGreaterThan(0);
  });

  test('de-snakes unknown codes into a sentence', () => {
    const out = humanizeBootReason('sandbox_pool_exhausted');
    expect(out.title).toBe('Sandbox pool exhausted');
    expect(out.code).toBe('sandbox_pool_exhausted');
  });

  test('passes through human sentences untouched', () => {
    const out = humanizeBootReason('Daytona returned HTTP 502');
    expect(out.title).toBe('Daytona returned HTTP 502');
    expect(out.code).toBeNull();
  });

  test('handles empty and undefined reasons', () => {
    expect(humanizeBootReason(undefined).title).toBe('The session could not start');
    expect(humanizeBootReason('  ').code).toBeNull();
  });
});
