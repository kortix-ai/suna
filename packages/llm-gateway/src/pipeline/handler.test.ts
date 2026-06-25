import { describe, expect, test } from "bun:test";

import { createGateway } from "../create-gateway";
import type {
  GatewayHooks,
  GatewayTrace,
  UpstreamDescriptor,
  UsageEvent,
} from "../domain";
import type { FetchImpl } from "../http";

const principal = {
  userId: "u1",
  accountId: "a1",
  projectId: "p1",
  keyId: "k1",
};

const managed: UpstreamDescriptor = {
  provider: "openrouter",
  kind: "openai-compat",
  baseUrl: "https://up.test/v1",
  apiKey: "sk",
  billingMode: "credits",
  markup: 2,
};

const fastRetry = {
  sleep: async () => {},
  rand: () => 0.5,
  baseDelayMs: 1,
  maxAttempts: 2,
};

function makeHooks(over: Partial<GatewayHooks> = {}) {
  const usage: UsageEvent[] = [];
  const traces: GatewayTrace[] = [];
  const hooks: GatewayHooks = {
    authenticate: async (token) => (token === "good" ? principal : null),
    resolveUpstream: async () => [managed],
    assertBillingActive: async () => {},
    recordUsage: async (event) => {
      usage.push(event);
    },
    recordTrace: async (trace) => {
      traces.push(trace);
    },
    ...over,
  };
  return { hooks, usage, traces };
}

function okFetch(data: unknown): FetchImpl {
  return async () =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("gateway.chatCompletions", () => {
  test("401 without a bearer token, still traced", async () => {
    const { hooks, traces } = makeHooks();
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: undefined,
      rawBody: "{}",
    });
    expect(res.status).toBe(401);
    await flush();
    expect(traces[0].ok).toBe(false);
    expect(traces[0].errorCode).toBe("missing_token");
  });

  test("401 for an invalid token", async () => {
    const { hooks } = makeHooks();
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer nope",
      rawBody: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("402 when billing is inactive", async () => {
    const { hooks } = makeHooks({
      assertBillingActive: async () => {
        throw new Error("subscription required");
      },
    });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("subscription_required");
  });

  test("400 on invalid JSON", async () => {
    const { hooks } = makeHooks();
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("400 when no upstream resolves for the model", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [] });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"ghost"}',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("model_unavailable");
  });

  test("200 success records usage and a full trace", async () => {
    const { hooks, usage, traces } = makeHooks();
    const fetchImpl = okFetch({
      model: "kortix/x",
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 },
    });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"kortix/x","metadata":{"tag":"demo"}}',
    });
    expect(res.status).toBe(200);
    await flush();

    expect(usage).toHaveLength(1);
    expect(usage[0].finalCost).toBeCloseTo(0.02);
    expect(usage[0].billingMode).toBe("credits");

    expect(traces).toHaveLength(1);
    const t = traces[0];
    expect(t.ok).toBe(true);
    expect(t.status).toBe(200);
    expect(t.provider).toBe("openrouter");
    expect(t.accountId).toBe("a1");
    expect(t.projectId).toBe("p1");
    expect(t.usage.promptTokens).toBe(100);
    expect(t.finalCost).toBeCloseTo(0.02);
    expect(t.metadata).toEqual({ tag: "demo" });
    expect(t.request).toBeDefined();
    expect(t.response).toBeDefined();
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('BYOK billingMode "none" records zero final cost', async () => {
    const byok: UpstreamDescriptor = {
      ...managed,
      provider: "anthropic",
      billingMode: "none",
      markup: 2,
    };
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [byok] });
    const fetchImpl = okFetch({
      model: "anthropic/x",
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.5 },
    });
    await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"anthropic/x"}',
    });
    await flush();
    expect(usage[0].billingMode).toBe("none");
    expect(usage[0].finalCost).toBe(0);
  });

  test("fails over to the next candidate when the first provider is down", async () => {
    const down: UpstreamDescriptor = {
      ...managed,
      provider: "primary",
      baseUrl: "https://down.test/v1",
    };
    const up: UpstreamDescriptor = {
      ...managed,
      provider: "secondary",
      baseUrl: "https://up.test/v1",
    };
    const { hooks, traces } = makeHooks({
      resolveUpstream: async () => [down, up],
    });
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === "down.test"
        ? new Response("boom", { status: 500 })
        : new Response(
            JSON.stringify({
              model: "m",
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          );

    const res = await createGateway(
      hooks,
      { retry: { ...fastRetry, maxAttempts: 1 } },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(res.status).toBe(200);
    await flush();
    expect(traces[0].ok).toBe(true);
    expect(traces[0].provider).toBe("secondary");
    expect(traces[0].candidatesTried).toEqual(["primary", "secondary"]);
  });

  test("surfaces an upstream 4xx immediately without failover", async () => {
    const a: UpstreamDescriptor = {
      ...managed,
      provider: "a",
      baseUrl: "https://a.test/v1",
    };
    const b: UpstreamDescriptor = {
      ...managed,
      provider: "b",
      baseUrl: "https://b.test/v1",
    };
    let bCalled = false;
    const fetchImpl: FetchImpl = async (url) => {
      if (new URL(url).hostname === "b.test") {
        bCalled = true;
        return new Response("{}", { status: 200 });
      }
      return new Response("bad request", { status: 400 });
    };
    const { hooks } = makeHooks({ resolveUpstream: async () => [a, b] });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(res.status).toBe(400);
    expect(bCalled).toBe(false);
  });

  test("returns 502 when all candidates are down", async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response("boom", { status: 500 });
    const { hooks } = makeHooks();
    const res = await createGateway(
      hooks,
      { retry: { ...fastRetry, maxAttempts: 1 } },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("upstream_unreachable");
  });

  test("returns 503 once the provider circuit opens", async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response("boom", { status: 500 });
    const { hooks } = makeHooks();
    const gateway = createGateway(
      hooks,
      {
        retry: { ...fastRetry, maxAttempts: 1 },
        breaker: { failureThreshold: 1, cooldownMs: 10_000 },
      },
      { fetchImpl },
    );
    await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    const second = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(second.status).toBe(503);
    expect((await second.json()).code).toBe("upstream_unavailable");
  });

  // BYOK-out-of-quota → managed fallback. resolveUpstream queues a managed model
  // behind the user's own key; a 429/402/403 on the key falls over to it.
  const byok: UpstreamDescriptor = {
    provider: "anthropic",
    kind: "openai-compat",
    baseUrl: "https://byok.test/v1",
    apiKey: "user-key",
    billingMode: "none",
    markup: 0,
  };
  const completion = JSON.stringify({
    id: "x",
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const byokBody = '{"model":"anthropic/claude","messages":[]}';

  test("a BYOK rate-limit (429) falls over to the managed fallback", async () => {
    const { hooks, traces } = makeHooks({
      resolveUpstream: async () => [byok, managed],
    });
    const fetchImpl: FetchImpl = async (url) =>
      String(url).includes("byok.test")
        ? new Response('{"error":"rate_limit"}', { status: 429 })
        : new Response(completion, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: byokBody,
    });
    expect(res.status).toBe(200);
    await flush();
    const ok = traces.find((t) => t.ok);
    expect(ok?.provider).toBe("openrouter"); // fell over from byok(anthropic) → managed
    expect(ok?.candidatesTried).toEqual(["anthropic", "openrouter"]);
  });

  test("a quota error (402) also falls over to the fallback", async () => {
    const { hooks } = makeHooks({
      resolveUpstream: async () => [byok, managed],
    });
    const fetchImpl: FetchImpl = async (url) =>
      String(url).includes("byok.test")
        ? new Response('{"error":"insufficient_quota"}', { status: 402 })
        : new Response(completion, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: byokBody,
    });
    expect(res.status).toBe(200);
  });

  test("a non-limit BYOK 4xx (400 bad request) returns as-is — no fallback", async () => {
    const { hooks } = makeHooks({
      resolveUpstream: async () => [byok, managed],
    });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":"bad_request"}', { status: 400 });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: byokBody,
    });
    expect(res.status).toBe(400);
  });

  test("a 429 with no fallback candidate is returned, not swallowed", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [byok] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":"rate_limit"}', { status: 429 });
    const res = await createGateway(
      hooks,
      { retry: { ...fastRetry, maxAttempts: 1 } },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: byokBody,
    });
    expect(res.status).toBe(429);
  });

  // Regression guard for the cross-tenant breaker bug: a persistent 429 on a
  // BYOK key is this caller's quota, not the provider being down. With the
  // breaker keyed by provider and shared across tenants, repeated 429s must NOT
  // open it — otherwise one tenant's exhausted key 503s everyone else's healthy
  // key on the same provider.
  test("a persistent 429 never opens the shared provider breaker", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [byok] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":"rate_limit"}', { status: 429 });
    const gateway = createGateway(
      hooks,
      {
        retry: { ...fastRetry, maxAttempts: 1 },
        breaker: { failureThreshold: 1, cooldownMs: 10_000 },
      },
      { fetchImpl },
    );
    // First request: 429 passes straight through (would have tripped a threshold=1 breaker under the old logic).
    const first = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: byokBody,
    });
    expect(first.status).toBe(429);
    // Second request still reaches upstream and gets the upstream 429 — NOT a 503 circuit-open.
    const second = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: byokBody,
    });
    expect(second.status).toBe(429);
  });

  test("a persistent 5xx still opens the breaker (502 → 503)", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response("boom", { status: 500 });
    const gateway = createGateway(
      hooks,
      {
        retry: { ...fastRetry, maxAttempts: 1 },
        breaker: { failureThreshold: 1, cooldownMs: 10_000 },
      },
      { fetchImpl },
    );
    const first = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(first.status).toBe(502);
    const second = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(second.status).toBe(503);
  });
});

// The combined `authorize` hook folds authenticate + billing + budget into one
// call (the standalone gateway uses it to cut three cross-process RPCs to one).
// When present it fully replaces the three granular hooks; behavior + traces are
// identical to the granular path.
describe("gateway.chatCompletions — combined authorize hook", () => {
  test("authorize ok → proceeds to dispatch and records usage", async () => {
    const { hooks, usage } = makeHooks({
      authorize: async () => ({ ok: true, principal }),
      // authenticate/assertBillingActive must NOT be consulted when authorize is set.
      authenticate: async () => {
        throw new Error("authenticate should not be called");
      },
      assertBillingActive: async () => {
        throw new Error("assertBillingActive should not be called");
      },
    });
    const fetchImpl = okFetch({
      model: "kortix/x",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"kortix/x"}',
    });
    expect(res.status).toBe(200);
    await flush();
    expect(usage).toHaveLength(1);
  });

  test("authorize denies with 401 invalid_token", async () => {
    const { hooks } = makeHooks({
      authorize: async () => ({
        ok: false,
        status: 401,
        errorCode: "invalid_token",
        message: "Invalid token",
      }),
    });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer nope",
      rawBody: '{"model":"x"}',
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_token");
  });

  test("autoRouter resolves a synthetic model before resolveUpstream; trace keeps the requested id", async () => {
    let resolvedWith = "";
    const { hooks, traces } = makeHooks({
      resolveUpstream: async (_p, model) => {
        resolvedWith = model;
        return [managed];
      },
    });
    const fetchImpl = okFetch({
      model: "openrouter/fusion",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const res = await createGateway(
      hooks,
      {
        retry: fastRetry,
        autoRouter: (model) => (model === "auto" ? "fusion" : null),
      },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"auto"}',
    });
    expect(res.status).toBe(200);
    expect(resolvedWith).toBe("fusion"); // resolution saw the routed model, not "auto"
    await flush();
    expect(traces[0].requestedModel).toBe("auto"); // trace records what the client asked for
  });

  test("autoRouter is a no-op for a concrete model", async () => {
    let resolvedWith = "";
    const { hooks } = makeHooks({
      resolveUpstream: async (_p, model) => {
        resolvedWith = model;
        return [managed];
      },
    });
    const fetchImpl = okFetch({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await createGateway(
      hooks,
      {
        retry: fastRetry,
        autoRouter: (model) => (model === "auto" ? "fusion" : null),
      },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"claude-x"}',
    });
    expect(resolvedWith).toBe("claude-x");
  });

  test("authorize denies with 402 and the trace stays attributed to the principal", async () => {
    const { hooks, traces } = makeHooks({
      authorize: async () => ({
        ok: false,
        status: 402,
        errorCode: "budget_exceeded",
        message: "budget exhausted",
        principal,
      }),
    });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x"}',
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("budget_exceeded");
    expect(body.message).toBe("budget exhausted");
    await flush();
    expect(traces[0].ok).toBe(false);
    expect(traces[0].errorCode).toBe("budget_exceeded");
    expect(traces[0].accountId).toBe("a1"); // attributed even on denial
  });
});
