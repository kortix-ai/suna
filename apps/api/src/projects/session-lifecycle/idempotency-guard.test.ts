import { describe, expect, test } from 'bun:test';
import { crossAccountIdempotencyResult } from './idempotency-guard';

describe('crossAccountIdempotencyResult', () => {
  test('same account → no conflict (falls through to normal dedupe)', () => {
    expect(crossAccountIdempotencyResult('acct-1', 'acct-1')).toBeNull();
  });

  test('different account → 409 IDEMPOTENCY_KEY_CONFLICT with no foreign details echoed', () => {
    const r = crossAccountIdempotencyResult('acct-foreign', 'acct-caller');
    expect(r?.status).toBe('failed');
    expect(r?.retryable).toBe(false);
    expect(r?.error?.status).toBe(409);
    expect((r?.error?.body as { code?: string })?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(r?.commandId).toBeUndefined();
    expect(r?.sessionId).toBeUndefined();
  });
});
