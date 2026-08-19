import { describe, expect, test } from 'bun:test';
import { crossAccountIdempotencyResult } from './idempotency-guard';

const own = { accountId: 'acct-1', projectId: 'proj-1', commandType: 'create_session' };
const caller = { accountId: 'acct-1', projectId: 'proj-1' };

describe('crossAccountIdempotencyResult', () => {
  test("caller's own create_session (same account+project) → no conflict (normal dedupe)", () => {
    expect(crossAccountIdempotencyResult(own, caller)).toBeNull();
  });

  test('different account → 409 IDEMPOTENCY_KEY_CONFLICT, no foreign details echoed', () => {
    const r = crossAccountIdempotencyResult({ ...own, accountId: 'acct-foreign' }, caller);
    expect(r?.status).toBe('failed');
    expect(r?.retryable).toBe(false);
    expect(r?.error?.status).toBe(409);
    expect((r?.error?.body as { code?: string })?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(r?.commandId).toBeUndefined();
    expect(r?.sessionId).toBeUndefined();
  });

  test('same account, DIFFERENT project → 409 (no cross-project session disclosure)', () => {
    const r = crossAccountIdempotencyResult({ ...own, projectId: 'proj-other' }, caller);
    expect(r?.error?.status).toBe(409);
    expect((r?.error?.body as { code?: string })?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  test('same account+project but a non-create (continue_session) command → 409', () => {
    const r = crossAccountIdempotencyResult({ ...own, commandType: 'continue_session' }, caller);
    expect(r?.error?.status).toBe(409);
  });
});
