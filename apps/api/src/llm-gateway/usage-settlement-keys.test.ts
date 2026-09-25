// A settlement the gateway retries must move the wallet once. The usage row is
// unique per request id (see usage-idempotency.integration.test.ts); this file
// pins that every wallet call derives its idempotency key from that request,
// so a replay repeats the key instead of minting a new one.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeWallet } from '../billing/wallet/fake';

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

const fake = createFakeWallet();
mock.module('../billing/wallet', () => ({ wallet: fake.wallet }));

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
    fake.restore();
  });

  test('a replayed settlement above the hold settles under the same usage row', async () => {
    await recordGatewayUsage(event('req_debit', 0.05));
    await recordGatewayUsage(event('req_debit', 0.05));
    const [first, second] = fake.calls.settle;
    const usageEventId = first!.audit!.usageEventId as string;
    expect(fake.calls.settle).toHaveLength(2);
    expect(first).toEqual({
      accountId: 'acct-1',
      amount: 0.04,
      description: 'LLM · kortix/kortix/test',
      kind: 'llm_debit',
      key: { request: `llm:${usageEventId}` },
      audit: {
        usageEventId,
        upstreamCostUsd: 0.05,
        markup: expect.any(Number),
        actorUserId: 'user-1',
        route: '/v1/llm/chat/completions',
      },
    });
    expect(second!.key).toEqual(first!.key);
  });

  test('a replayed hold refund carries one wallet key per request', async () => {
    await recordGatewayUsage(event('req_refund', 0.001));
    await recordGatewayUsage(event('req_refund', 0.001));
    expect(fake.calls.grant).toHaveLength(2);
    expect(fake.calls.grant[0]).toMatchObject({
      kind: 'llm_reservation_refund',
      expiring: false,
      key: { request: 'llm-hold-refund:req_refund' },
    });
    expect(fake.calls.grant[1]!.key).toEqual(fake.calls.grant[0]!.key);
  });
});
