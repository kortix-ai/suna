// THE MID-TURN EXTENSION.
//
// A turn is granted 4 hours when it STARTS, and in the first cut of the deadline
// model nothing re-extended it: `extendSandboxDeadline` fired only on a turn-start
// POST. The measured tail is longer than that grant — MAX turn ~8.4h, and roughly
// 7-18 turns per 30 days exceed 4h — so a long turn was killed mid-work, which is
// strictly worse than the 4-hour zombie it was preventing.
//
// `usage_events` is the signal that closes it, and it is the one the reviewers
// named: it is written HERE, by the gateway, after a real upstream completion —
// never by the sandbox. The box cannot mint one without spending real money
// through our own control plane, so it satisfies the invariant that only a
// control-plane-OBSERVED event may extend a box.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let extendCalls: Array<{ target: unknown; grantMs: number | undefined }> = [];
let usageRows = 0;

mock.module('../config', () => ({
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        return target[key];
      },
    },
  ),
}));

mock.module('../shared/usage-events', () => ({
  recordUsageEvent: async () => {
    usageRows += 1;
    return 'usage-1';
  },
  resolveSessionOriginRef: async () => null,
}));

// `../billing/services/credits` is deliberately NOT mocked: with
// KORTIX_BILLING_INTERNAL_ENABLED false, recordGatewayUsage returns before it
// reaches the wallet, and a partial stub of that module breaks its other
// importers (mock.module replaces the whole module, exports and all).

const realPolicy = await import('../workspaces/sandbox-deadline-policy');
mock.module('../workspaces/sandbox-deadline', () => ({
  ...realPolicy,
  extendSandboxDeadline: async (target: unknown, grantMs?: number) => {
    extendCalls.push({ target, grantMs });
  },
}));

const { recordGatewayUsage } = await import('./hooks');

// The extend is throttled per SESSION and the throttle is module state that
// outlives one test, so each test drives its own session id — sharing one would
// let a later assertion pass because an earlier test consumed the window.
let sessionCounter = 0;
let sessionId = 'sess-0';

function usage(over: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    actorUserId: 'user-1',
    workspaceId: 'proj-1',
    sessionId,
    provider: 'anthropic',
    model: 'claude-sonnet-4.6',
    promptTokens: 100,
    completionTokens: 50,
    finalCost: 0.01,
    upstreamCost: 0.005,
    streaming: false,
    billingMode: 'credits',
    requestId: 'req-1',
    ...over,
  } as never;
}

beforeEach(() => {
  extendCalls = [];
  usageRows = 0;
  sessionCounter += 1;
  sessionId = `sess-${sessionCounter}`;
});

describe('recordGatewayUsage extends the sandbox deadline mid-turn', () => {
  test('REGRESSION: a gateway LLM call re-extends the box, so an 8-hour turn survives', async () => {
    await recordGatewayUsage(usage());

    expect(usageRows).toBe(1);
    expect(extendCalls).toHaveLength(1);
    expect(extendCalls[0].target).toEqual({ sessionId });
  });

  // The measured p99.9 gap between consecutive usage_events inside one session is
  // OVER AN HOUR — a long local tool run (build, test suite, migration) emits none
  // at all — so a grant near that gap would kill a box in the middle of exactly
  // the work it exists to do.
  test('the grant comfortably exceeds the ~1h p99.9 gap between usage events', async () => {
    await recordGatewayUsage(usage());

    expect(extendCalls[0].grantMs).toBe(realPolicy.llmActivityGrantMs());
    expect(extendCalls[0].grantMs).toBeGreaterThan(3 * 3_600_000);
  });

  test('a turn making many calls writes ONE deadline update per minute, not one per call', async () => {
    for (let i = 0; i < 20; i += 1) await recordGatewayUsage(usage());

    expect(usageRows).toBe(20);
    expect(extendCalls).toHaveLength(1);
  });

  test('two different sessions each get their own window', async () => {
    await recordGatewayUsage(usage({ sessionId: `${sessionId}-a` }));
    await recordGatewayUsage(usage({ sessionId: `${sessionId}-b` }));

    expect(extendCalls.map((c) => c.target)).toEqual([
      { sessionId: `${sessionId}-a` },
      { sessionId: `${sessionId}-b` },
    ]);
  });

  // A gateway call with no session behind it (the legacy router path, a bare API
  // key) has no box to extend, and must not produce a write against a null id.
  test('a call with no session id extends nothing', async () => {
    await recordGatewayUsage(usage({ sessionId: null }));
    await recordGatewayUsage(usage({ sessionId: undefined }));

    expect(extendCalls).toEqual([]);
  });

  // A pure hold refund observed NOTHING — there was no upstream call, so there is
  // no evidence the box is alive and nothing to extend.
  test('a pure admission-hold refund is not an observation', async () => {
    await recordGatewayUsage(
      usage({ finalCost: 0, billingHoldUsd: 0.01, promptTokens: 0, completionTokens: 0 }),
    );

    expect(usageRows).toBe(0);
    expect(extendCalls).toEqual([]);
  });
});
