// A settlement the gateway retries must move the wallet once. The usage row is
// unique per request id (see usage-idempotency.integration.test.ts); this file
// pins that every wallet call derives its idempotency key from that request,
// so a replay repeats the key instead of minting a new one.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return true;
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        return target[key];
      },
    },
  ),
}));

// The row writer returns the SAME row for the same request id, exactly like
// the `on conflict do nothing` + read-back in shared/usage-events.ts.
const rowByRequest = new Map<string, string>();
mock.module('../shared/usage-events', () => ({
  recordUsageEvent: async (input: { requestId?: string | null }) => {
    const key = input.requestId ?? crypto.randomUUID();
    if (!rowByRequest.has(key)) rowByRequest.set(key, crypto.randomUUID());
    return rowByRequest.get(key)!;
  },
  resolveSessionOriginRef: async () => null,
}));

const deducts: Array<{ usageEventId?: string | null; costUsd: number }> = [];
const grants: Array<{ amount: number; key: string | null | undefined }> = [];
const realCredits = await import('../billing/services/credits');
mock.module('../billing/services/credits', () => ({
  ...realCredits,
  deductForLlmUsage: async (opts: { usageEventId?: string | null; costUsd: number }) => {
    deducts.push({ usageEventId: opts.usageEventId, costUsd: opts.costUsd });
    return { success: true, cost: opts.costUsd, newBalance: 0, transactionId: null };
  },
  grantCredits: async (
    _accountId: string,
    amount: number,
    _type: string,
    _description: string,
    _isExpiring?: boolean,
    _stripeEventId?: string,
    opts?: { idempotencyKey?: string | null },
  ) => {
    grants.push({ amount, key: opts?.idempotencyKey });
    return { success: true };
  },
}));

const realDeadline = await import('../projects/sandbox-deadline');
mock.module('../projects/sandbox-deadline', () => ({
  ...realDeadline,
  extendSandboxDeadline: async () => {},
}));

const { recordGatewayUsage } = await import('./hooks');

function event(requestId: string, finalCost: number) {
  return {
    accountId: 'acct-1',
    actorUserId: 'user-1',
    provider: 'kortix',
    model: 'kortix/test',
    promptTokens: 100,
    completionTokens: 10,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    upstreamCost: finalCost,
    finalCost,
    billingMode: 'credits' as const,
    streaming: true,
    requestId,
    billingHoldUsd: 0.01,
  };
}

describe('gateway settlement idempotency keys', () => {
  beforeEach(() => {
    deducts.length = 0;
    grants.length = 0;
  });

  test('a replayed settlement above the hold debits under the same usage row', async () => {
    await recordGatewayUsage(event('req_debit', 0.05));
    await recordGatewayUsage(event('req_debit', 0.05));
    expect(deducts).toHaveLength(2);
    expect(deducts[0]!.usageEventId).toBeTruthy();
    expect(deducts[1]!.usageEventId).toBe(deducts[0]!.usageEventId);
  });

  test('a replayed hold refund carries one idempotency key per request', async () => {
    await recordGatewayUsage(event('req_refund', 0.001));
    await recordGatewayUsage(event('req_refund', 0.001));
    expect(grants).toHaveLength(2);
    expect(grants[0]!.key).toBe('llm-hold-refund:req_refund');
    expect(grants[1]!.key).toBe(grants[0]!.key);
  });
});
