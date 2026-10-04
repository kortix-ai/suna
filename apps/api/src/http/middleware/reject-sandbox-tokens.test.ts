import { describe, expect, test } from 'bun:test';
import { rejectSandboxTokens } from './reject-sandbox-tokens';

// Minimal Hono context stub: only `c.get` is read by rejectSandboxTokens.
// `next` is a spy so we can assert it was/wasn't called.
function ctx(overrides: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { authType: undefined, sandboxId: undefined, ...overrides };
  let nextCalled = false;
  return {
    c: {
      get: (key: string) => store[key],
    } as never,
    next: async () => {
      nextCalled = true;
    },
    nextCalled: () => nextCalled,
  };
}

describe('rejectSandboxTokens', () => {
  test('rejects a sandbox agent token (authType=apiKey + sandboxId) with 403', async () => {
    const { c, next, nextCalled } = ctx({ authType: 'apiKey', sandboxId: 'sb_123' });
    let caught: unknown;
    try {
      await rejectSandboxTokens(c, next);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { message: string }).message).toMatch(/Sandbox tokens/);
    expect((caught as { status?: number }).status).toBe(403);
    expect(nextCalled()).toBe(false);
  });

  test('allows a PAT (authType=pat)', async () => {
    const { c, next, nextCalled } = ctx({ authType: 'pat', userId: 'u_1' });
    await rejectSandboxTokens(c, next);
    expect(nextCalled()).toBe(true);
  });

  test('allows a service account (authType=service_account)', async () => {
    const { c, next, nextCalled } = ctx({ authType: 'service_account', accountId: 'acc_1' });
    await rejectSandboxTokens(c, next);
    expect(nextCalled()).toBe(true);
  });

  test('allows a Supabase session (authType=supabase)', async () => {
    const { c, next, nextCalled } = ctx({ authType: 'supabase', userId: 'u_2' });
    await rejectSandboxTokens(c, next);
    expect(nextCalled()).toBe(true);
  });

  test('allows a non-sandbox kortix_ API key (apiKey without sandboxId)', async () => {
    // Operator account API key — no sandboxId, so not an agent token.
    const { c, next, nextCalled } = ctx({ authType: 'apiKey', accountId: 'acc_1' });
    await rejectSandboxTokens(c, next);
    expect(nextCalled()).toBe(true);
  });

  test('allows when authType is unset (defensive — combinedAuth would 401 first)', async () => {
    const { c, next, nextCalled } = ctx({});
    await rejectSandboxTokens(c, next);
    expect(nextCalled()).toBe(true);
  });
});
