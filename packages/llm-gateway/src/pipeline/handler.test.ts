import { describe, expect, test } from "bun:test";

import { createGateway } from "../create-gateway";
import type {
  GatewayHooks,
  GatewayTrace,
  UpstreamDescriptor,
  UsageEvent,
} from "../domain";
import { GatewayResolutionError } from "../errors";
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

function expectErrorContract(body: any, code: string): void {
  expect(typeof body.message).toBe("string");
  expect(body.message === "").toBe(false);
  expect(typeof body.suggestion).toBe("string");
  expect(body.suggestion === "").toBe(false);
  expect(body).toMatchObject({
    message: expect.any(String),
    code,
    provider: expect.any(String),
    requested_model: expect.any(String),
    resolved_model: expect.any(String),
    request_id: expect.stringMatching(/^req_/),
    suggestion: expect.any(String),
    error: {
      message: expect.any(String),
      type: code,
      code: expect.anything(),
      provider: expect.any(String),
      requested_model: expect.any(String),
      resolved_model: expect.any(String),
      request_id: expect.stringMatching(/^req_/),
      suggestion: expect.any(String),
    },
  });
}

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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("subscription_required");
  });

  // A host's billing gate (e.g. apps/api's BillingGateError) can attach the
  // REAL reason as a `.reason` string on the thrown error — insufficient_credits
  // and no_account are just as real a 402 cause as subscription_required, and
  // used to always report the same hardcoded code regardless. admit() must
  // read it instead of hardcoding, without needing to import the host's class.
  test("402 surfaces the billing gate's real reason instead of hardcoding subscription_required", async () => {
    const { hooks } = makeHooks({
      assertBillingActive: async () => {
        const err = new Error("Out of credits. Top up to continue.");
        (err as Error & { reason: string }).reason = "insufficient_credits";
        throw err;
      },
    });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("insufficient_credits");
    expect(body.message).toBe("Out of credits. Top up to continue.");
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
      rawBody: '{"model":"ghost","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("model_unavailable");
  });

  // A host's resolveUpstream hook (e.g. apps/api's resolveCandidates) can throw
  // a GatewayResolutionError instead of returning [] when it knows exactly WHY
  // there's no upstream — "No upstream configured" used to be the ONE message
  // for every one of these causes. The specific code/message/suggestion must
  // survive into the response instead of collapsing to the generic fallback.
  test("400 surfaces a GatewayResolutionError's specific code/message/suggestion instead of the generic model_unavailable", async () => {
    const { hooks } = makeHooks({
      resolveUpstream: async () => {
        throw new GatewayResolutionError(
          "provider_not_connected",
          "No openai API key is connected for this project.",
          "Add an openai API key in project settings, then retry.",
        );
      },
    });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"openai/gpt-4.1","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("provider_not_connected");
    expect(body.message).toBe(
      "No openai API key is connected for this project.",
    );
    expect(body.suggestion).toBe(
      "Add an openai API key in project settings, then retry.",
    );
  });

  // Multiple fallback route models can each fail resolution for a different
  // reason — the FIRST (the model the caller actually asked for) should win,
  // not whichever fallback happened to run last.
  test("400 prefers the PRIMARY route model's resolution reason over a later fallback's", async () => {
    const { hooks } = makeHooks({
      resolveRoute: async () => ({
        policyId: "test",
        primaryModel: "primary",
        fallbackModels: ["secondary"],
        fallbackOn: "any-error",
      }),
      resolveUpstream: async (_p, model) => {
        if (model === "primary") {
          throw new GatewayResolutionError(
            "plan_upgrade_required",
            "primary requires a paid plan.",
            "Upgrade your plan.",
          );
        }
        throw new GatewayResolutionError(
          "model_not_found",
          "secondary is not a recognized model.",
          "Check the model id.",
        );
      },
    });
    const res = await createGateway(hooks, {
      retry: fastRetry,
    }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"primary","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("plan_upgrade_required");
  });

  test("200 success records usage and a full trace", async () => {
    const { hooks, usage, traces } = makeHooks();
    const fetchImpl = okFetch({
      model: "kortix/x",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 },
    });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"kortix/x","metadata":{"tag":"demo"},"messages":[{"role":"user","content":"hi"}]}',
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
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.5 },
    });
    await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"anthropic/x","messages":[{"role":"user","content":"hi"}]}',
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
              choices: [{ message: { content: "ok" } }],
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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      message: "bad request",
      code: "upstream_client_error",
      upstream_status: 400,
      provider: "a",
      requested_model: "x",
      resolved_model: "x",
    });
    expect(body.request_id).toMatch(/^req_/);
    expect(body.suggestion).toContain("switch to another model");
    expect(body.error).toMatchObject({
      message: "bad request",
      type: "upstream_client_error",
      provider: "a",
    });
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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      message: "boom",
      code: "upstream_unreachable",
      upstream_status: 500,
      provider: "openrouter",
      requested_model: "x",
      resolved_model: "x",
      suggestion: "Retry the request. If the error continues, switch to another model.",
    });
  });

  test("reports the last attempted descriptor when every upstream fails", async () => {
    const candidates: UpstreamDescriptor[] = [
      { ...managed, provider: "first", resolvedModel: "first/model" },
      { ...managed, provider: "last", resolvedModel: "last/model" },
    ];
    const { hooks } = makeHooks({ resolveUpstream: async () => candidates });
    const res = await createGateway(
      hooks,
      { retry: { ...fastRetry, maxAttempts: 1 } },
      { fetchImpl: async () => new Response("boom", { status: 500 }) },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      provider: "last",
      resolved_model: "last/model",
    });
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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    const second = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
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
    object: "chat.completion",
    model: "x",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const byokBody =
    '{"model":"anthropic/claude","messages":[{"role":"user","content":"hi"}]}';

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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(first.status).toBe(502);
    const second = await gateway.chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
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
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"kortix/x","messages":[{"role":"user","content":"hi"}]}',
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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_token");
  });

  test("control-plane route resolves a synthetic model before resolveUpstream; trace keeps the requested id", async () => {
    let resolvedWith = "";
    const { hooks, traces } = makeHooks({
      resolveRoute: async (_principal, input) => input.requestedModel === "auto"
        ? { policyId: "auto", primaryModel: "fusion" }
        : null,
      resolveUpstream: async (_p, model) => {
        resolvedWith = model;
        return [managed];
      },
    });
    const fetchImpl = okFetch({
      model: "openrouter/fusion",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const res = await createGateway(
      hooks,
      {
        retry: fastRetry,
      },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"auto","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(200);
    expect(resolvedWith).toBe("fusion"); // resolution saw the routed model, not "auto"
    await flush();
    expect(traces[0].requestedModel).toBe("auto"); // trace records what the client asked for
  });

  test("control-plane route is a no-op for a concrete model", async () => {
    let resolvedWith = "";
    const { hooks } = makeHooks({
      resolveRoute: async (_principal, input) => input.requestedModel === "auto"
        ? { policyId: "auto", primaryModel: "fusion" }
        : null,
      resolveUpstream: async (_p, model) => {
        resolvedWith = model;
        return [managed];
      },
    });
    const fetchImpl = okFetch({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await createGateway(
      hooks,
      {
        retry: fastRetry,
      },
      { fetchImpl },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"claude-x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(resolvedWith).toBe("claude-x");
  });

  test("control-plane route failure returns one bounded routing_unavailable error", async () => {
    let routeCalls = 0;
    let upstreamCalls = 0;
    const { hooks, traces } = makeHooks({
      resolveRoute: async () => {
        routeCalls += 1;
        throw new Error("control plane offline");
      },
      resolveUpstream: async () => {
        upstreamCalls += 1;
        return [managed];
      },
    });

    const res = await createGateway(hooks, { retry: fastRetry }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"auto","messages":[{"role":"user","content":"ping"}]}',
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "routing_unavailable",
      requested_model: "auto",
      resolved_model: "auto",
    });
    expect(routeCalls).toBe(1);
    expect(upstreamCalls).toBe(0);
    await flush();
    expect(traces.at(-1)).toMatchObject({
      status: 502,
      ok: false,
      errorCode: "routing_unavailable",
    });
  });

  test("bounded model fallback routes a failed primary to the next model", async () => {
    const primary = {
      ...managed,
      provider: "openai-codex",
      baseUrl: "https://codex.test/v1",
      resolvedModel: "gpt-5.6-sol",
    };
    const fallback = {
      ...managed,
      provider: "openrouter",
      baseUrl: "https://openrouter.test/v1",
      resolvedModel: "z-ai/glm-5.2",
    };
    const resolvedModels: string[] = [];
    const upstreamModels: string[] = [];
    const { hooks, traces } = makeHooks({
      resolveRoute: async (_principal, input) => ({
        policyId: "test-policy",
        primaryModel: input.requestedModel,
        fallbackModels: ["glm-5.2"],
        fallbackOn: "any-error",
      }),
      resolveUpstream: async (_p, model) => {
        resolvedModels.push(model);
        return model === "codex/gpt-5.6-sol" ? [primary] : model === "glm-5.2" ? [fallback] : [];
      },
    });
    const fetchImpl: FetchImpl = async (url, init) => {
      upstreamModels.push((JSON.parse(String(init.body)) as { model: string }).model);
      if (String(url).includes("codex.test")) return new Response("codex down", { status: 500 });
      return new Response(JSON.stringify({
        model: "z-ai/glm-5.2",
        choices: [{ message: { content: "fallback ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const res = await createGateway(hooks, {
      retry: { ...fastRetry, maxAttempts: 1 },
    }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"codex/gpt-5.6-sol","messages":[{"role":"user","content":"ping"}]}',
    });

    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("fallback ok");
    expect(resolvedModels).toEqual(["codex/gpt-5.6-sol", "glm-5.2"]);
    expect(upstreamModels).toEqual(["gpt-5.6-sol", "z-ai/glm-5.2"]);
    await flush();
    expect(traces.at(-1)?.metadata.gatewayRouting).toEqual({
      policy: "test-policy",
      models: ["codex/gpt-5.6-sol", "glm-5.2"],
      selected: "glm-5.2",
    });
  });

  test("any-error model policy falls back on a deterministic primary 400", async () => {
    const calls: string[] = [];
    const { hooks } = makeHooks({
      resolveRoute: async (_principal, input) => ({
        policyId: "test-any-error",
        primaryModel: input.requestedModel,
        fallbackModels: ["fallback"],
        fallbackOn: "any-error",
      }),
      resolveUpstream: async (_p, model) => [{
        ...managed,
        provider: model === "primary" ? "primary" : "fallback",
        baseUrl: `https://${model}.test/v1`,
        resolvedModel: model,
      }],
    });
    const res = await createGateway(hooks, {
      retry: { ...fastRetry, maxAttempts: 1 },
    }, {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return String(url).includes("primary.test")
          ? new Response('{"error":{"message":"model unavailable"}}', { status: 400 })
          : new Response(JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }).chatCompletions({ authorization: "Bearer good", rawBody: '{"model":"primary","messages":[{"role":"user","content":"hi"}]}' });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("model fallback chain is hard-capped and never loops", async () => {
    const resolvedModels: string[] = [];
    let calls = 0;
    const { hooks } = makeHooks({
      resolveRoute: async (_principal, input) => ({
        policyId: "test-bounded",
        primaryModel: input.requestedModel,
        fallbackModels: ["fallback-1", "fallback-2", "fallback-3", "primary"],
        fallbackOn: "any-error",
      }),
      resolveUpstream: async (_p, model) => {
        resolvedModels.push(model);
        return [{ ...managed, provider: model, resolvedModel: model }];
      },
    });
    const res = await createGateway(hooks, {
      retry: { ...fastRetry, maxAttempts: 1 },
      maxFallbackModels: 1,
    }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response("down", { status: 500 });
      },
    }).chatCompletions({ authorization: "Bearer good", rawBody: '{"model":"primary","messages":[{"role":"user","content":"hi"}]}' });

    expect(res.status).toBe(502);
    expect(resolvedModels).toEqual(["primary", "fallback-1"]);
    expect(calls).toBe(2);
  });

  test("an unavailable primary model can resolve directly to its configured fallback", async () => {
    const { hooks } = makeHooks({
      resolveRoute: async (_principal, input) => ({
        policyId: "test-unavailable",
        primaryModel: input.requestedModel,
        fallbackModels: ["fallback"],
        fallbackOn: "any-error",
      }),
      resolveUpstream: async (_p, model) => model === "primary" ? [] : [managed],
    });
    const res = await createGateway(hooks, {
      retry: { ...fastRetry, maxAttempts: 1 },
    }, { fetchImpl: okFetch({ choices: [{ message: { content: "ok" } }] }) })
      .chatCompletions({ authorization: "Bearer good", rawBody: '{"model":"primary","messages":[{"role":"user","content":"hi"}]}' });

    expect(res.status).toBe(200);
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
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
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

// Regression coverage for the empty-completion bug: an upstream 200 with
// syntactically valid but empty choices/content (seen from OpenRouter/z-ai) must
// be treated as a failed candidate — failed over to the next one, and only
// surfaced to the caller once every candidate has come back empty.
describe("gateway.chatCompletions — empty-completion failover", () => {
  const emptyJson = JSON.stringify({
    model: "m",
    choices: [],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });
  const goodJson = JSON.stringify({
    model: "m",
    choices: [{ message: { content: "real answer" } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });

  function sseResponse(body: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  const emptySse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const goodSse =
    'data: {"choices":[{"delta":{"content":"real answer"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
    'data: [DONE]\n\n';

  // The ai-sdk engine PARSES an upstream SSE stream (via the real
  // @ai-sdk/openai-compatible provider) and RE-SERIALIZES it through this
  // package's own `openAiSseFromFullStream` — unlike the retired native
  // transport, which relayed upstream SSE bytes verbatim. The client-facing
  // frame boundaries/fields (an `id`/`object`/`created` envelope, a leading
  // empty-content chunk, a trailing usage-only chunk...) therefore
  // legitimately differ from a hand-crafted upstream fixture byte-for-byte;
  // what must stay stable is the CONTENT — the concatenated text delta and
  // the finish_reason a real client actually reads.
  function sseText(raw: string): { content: string; finishReason: string | undefined } {
    let content = "";
    let finishReason: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
      };
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === "string") content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    return { content, finishReason };
  }

  test("non-streaming: a candidate that recovers after retries never fails over — the common case (matches the observed ~19% transient rate)", async () => {
    const { hooks, usage, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return new Response(calls < 2 ? emptyJson : goodJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("real answer");
    await flush();
    expect(usage).toHaveLength(1);
    expect(traces[0].ok).toBe(true);
    expect(traces[0].candidatesTried).toEqual(["openrouter", "openrouter"]); // retried in place, no failover needed
  });

  test("non-streaming: a candidate empty on every attempt exhausts its retry budget, then fails over to candidate B", async () => {
    const a: UpstreamDescriptor = { ...managed, provider: "a", baseUrl: "https://a.test/v1" };
    const b: UpstreamDescriptor = { ...managed, provider: "b", baseUrl: "https://b.test/v1" };
    const { hooks, traces, usage } = makeHooks({ resolveUpstream: async () => [a, b] });
    const fetchImpl: FetchImpl = async (url) =>
      new Response(new URL(url).hostname === "a.test" ? emptyJson : goodJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("real answer");
    await flush();
    expect(usage).toHaveLength(1); // the empty candidate never billed
    expect(traces[0].ok).toBe(true);
    expect(traces[0].provider).toBe("b");
    // "a" gets its full retry budget in place before failing over to "b"
    expect(traces[0].candidatesTried).toEqual(["a", "a", "a", "b"]);
  });

  test("non-streaming: every candidate empty on every attempt → 502 empty_completion, nothing forwarded to the caller", async () => {
    const { hooks, usage, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response(emptyJson, { status: 200, headers: { "content-type": "application/json" } });

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("empty_completion");
    await flush();
    expect(usage).toHaveLength(0);
    expect(traces[0].ok).toBe(false);
    expect(traces[0].errorCode).toBe("empty_completion");
    // the sole candidate was retried in place up to its full budget before giving up
    expect(traces[0].candidatesTried).toEqual(["openrouter", "openrouter", "openrouter"]);
  });

  test("streaming: a candidate that recovers after retries never fails over", async () => {
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return sseResponse(calls < 2 ? emptySse : goodSse);
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    expect(sseText(text)).toEqual({ content: "real answer", finishReason: "stop" });
    await flush();
    expect(traces[0].ok).toBe(true);
    expect(traces[0].candidatesTried).toEqual(["openrouter", "openrouter"]);
  });

  test("streaming: an empty stream from candidate A fails over to candidate B — A's bytes never reach the client", async () => {
    const a: UpstreamDescriptor = { ...managed, provider: "a", baseUrl: "https://a.test/v1" };
    const b: UpstreamDescriptor = { ...managed, provider: "b", baseUrl: "https://b.test/v1" };
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [a, b] });
    const fetchImpl: FetchImpl = async (url) =>
      sseResponse(new URL(url).hostname === "a.test" ? emptySse : goodSse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    // Candidate A's empty frame never reaches the client — only B's real content does.
    expect(sseText(text)).toEqual({ content: "real answer", finishReason: "stop" });
    await flush();
    expect(traces.find((t) => t.ok)?.provider).toBe("b");
  });

  test("streaming: every candidate's stream is empty → 502 empty_completion, not a fabricated SSE response", async () => {
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () => sseResponse(emptySse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).code).toBe("empty_completion");
    await flush();
    expect(traces[0].ok).toBe(false);
    expect(traces[0].errorCode).toBe("empty_completion");
  });

  // An otherwise-200 stream that carries a structured `{error:{...}}` frame and no
  // content is a real upstream failure (overloaded, request too large, ...). It
  // must surface the real error — not be retried in place and buried under a
  // generic empty_completion.
  const errorSse =
    'data: {"error":{"message":"Overloaded","type":"overloaded_error","code":"overloaded_error"}}\n\n' +
    "data: [DONE]\n\n";

  test("streaming: an upstream error frame surfaces as 502 upstream_error with the real message — no same-candidate retry storm", async () => {
    const { hooks, traces, usage } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return sseResponse(errorSse);
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("upstream_error");
    expect(body.message).toBe("Overloaded");
    expect(body.error).toMatchObject({
      message: "Overloaded",
      type: "upstream_error",
      code: "overloaded_error",
      provider: "openrouter",
    });
    expect(body.upstream_code).toBe("overloaded_error");
    expect(body.provider).toBe("openrouter");
    expect(body.requested_model).toBe("x");
    expect(body.resolved_model).toBe("x");
    expect(body.request_id).toMatch(/^req_/);
    expect(body.suggestion).toContain("switch to another model");
    expect(calls).toBe(1); // the error candidate is excluded at once, not retried 3×
    await flush();
    expect(usage).toHaveLength(0);
    expect(traces[0].ok).toBe(false);
    expect(traces[0].errorCode).toBe("upstream_error");
    expect(traces[0].candidatesTried).toEqual(["openrouter"]);
  });

  // A dead BYOK credential is one of the providers (e.g. OpenAI) that reports
  // an invalid-key failure as a 200-status stream carrying a `data:
  // {"error":{...}}` frame rather than a non-2xx HTTP response — so this never
  // throws an UpstreamHttpError, it lands here via probeStream's error-frame
  // detection. A blanket 502 (this branch's default for every other in-band
  // error frame — "Overloaded", request-too-large, ...) tells an OpenAI-
  // compatible client "transient, retry me", and a dead key never stops being
  // dead: the 2026-07-17 incident this guards against saw exactly that client-
  // side retry loop end in an empty, error-free turn with nothing surfaced to
  // the session. 401 is non-retryable to any spec-compliant client (retry
  // eligibility is keyed off HTTP status, not body), so the failure reaches
  // the session's error-surfacing path on the first attempt instead.
  const authErrorSse =
    'data: {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}\n\n' +
    "data: [DONE]\n\n";

  test("streaming: a terminal-auth error frame (dead BYOK key) surfaces as 401, not a retryable 502", async () => {
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return sseResponse(authErrorSse);
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("upstream_error");
    expect(body.message).toBe("Incorrect API key provided");
    expect(body.upstream_code).toBe("invalid_api_key");
    expect(calls).toBe(1); // no same-candidate retry storm on a dead key
    await flush();
    expect(traces[0].ok).toBe(false);
    expect(traces[0].status).toBe(401);
    expect(traces[0].errorCode).toBe("upstream_error");
  });

  // The ai-sdk transport (transports/ai-sdk/sse.ts) pre-classifies its own
  // upstream errors and embeds the real HTTP-equivalent status as a NUMERIC
  // `code` on the frame — e.g. a genuine 429 the provider itself returned
  // mid-stream, not just an auth failure. This branch must trust that
  // pre-computed status verbatim instead of falling back to a blanket 502.
  const numericCodeSse =
    'data: {"error":{"message":"Rate limit exceeded","code":429}}\n\n' + "data: [DONE]\n\n";

  test("streaming: a numeric error-frame code (ai-sdk transport's own classification) is trusted verbatim", async () => {
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () => sseResponse(numericCodeSse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.message).toBe("Rate limit exceeded");
    expect(body.upstream_code).toBe(429);
    await flush();
    expect(traces[0].status).toBe(429);
  });

  // A numeric code OUTSIDE the 4xx range (e.g. a provider that reports its own
  // 5xx mid-stream) must NOT override the branch's generic "transient" 502 —
  // trusting an arbitrary 5xx here wouldn't change anything meaningful, so the
  // classifier deliberately only trusts 4xx.
  const numeric5xxSse =
    'data: {"error":{"message":"Upstream had an internal error","code":503}}\n\n' + "data: [DONE]\n\n";

  test("streaming: a numeric 5xx error-frame code stays the branch's generic 502", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () => sseResponse(numeric5xxSse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(502);
  });

  test("streaming: an error frame from candidate A still fails over to a healthy candidate B", async () => {
    const a: UpstreamDescriptor = { ...managed, provider: "a", baseUrl: "https://a.test/v1" };
    const b: UpstreamDescriptor = { ...managed, provider: "b", baseUrl: "https://b.test/v1" };
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [a, b] });
    const fetchImpl: FetchImpl = async (url) =>
      sseResponse(new URL(url).hostname === "a.test" ? errorSse : goodSse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    expect(sseText(await new Response(res.body).text())).toEqual({
      content: "real answer",
      finishReason: "stop",
    });
    await flush();
    expect(traces.find((t) => t.ok)?.provider).toBe("b");
  });
});

describe("gateway.chatCompletions — BILLING-CORRECTNESS: discarded-attempt usage + zero-usage safeguard", () => {
  function sseResponse(body: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  test("non-streaming: a discarded empty-completion candidate that carried real usage is folded into the eventual billed usage — Kortix doesn't eat the upstream cost silently", async () => {
    // A malformed/empty completion that STILL reports real usage (the exact
    // OpenRouter/z-ai pattern the empty-completion retry loop exists for) —
    // the upstream may have already charged for it even though `choices` is
    // empty.
    const emptyButBilled = JSON.stringify({
      model: "m",
      choices: [],
      usage: { prompt_tokens: 40, completion_tokens: 0 },
    });
    const good = JSON.stringify({
      model: "m",
      choices: [{ message: { content: "real answer" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return new Response(calls < 2 ? emptyButBilled : good, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await flush();
    expect(usage).toHaveLength(1);
    // 40 (discarded) + 5 (billed candidate) = 45 — not just the 5 from the
    // candidate that actually won.
    expect(usage[0].promptTokens).toBe(45);
    expect(usage[0].completionTokens).toBe(3);
  });

  test("streaming: a discarded empty-stream candidate carrying a trailing usage-only frame is folded into the eventual billed usage", async () => {
    const emptyButBilled =
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":0}}\n\n' +
      "data: [DONE]\n\n";
    const good =
      'data: {"choices":[{"delta":{"content":"real answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
      "data: [DONE]\n\n";
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return sseResponse(calls < 2 ? emptyButBilled : good);
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await new Response(res.body).text();
    await flush();
    expect(usage).toHaveLength(1);
    expect(usage[0].promptTokens).toBe(45);
    expect(usage[0].completionTokens).toBe(3);
  });

  test("a genuinely empty discarded attempt (zero usage, no cost hint) contributes nothing — unchanged from prior behavior", async () => {
    const emptyZero = JSON.stringify({
      model: "m",
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    const good = JSON.stringify({
      model: "m",
      choices: [{ message: { content: "real answer" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [managed] });
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return new Response(calls < 2 ? emptyZero : good, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await flush();
    expect(usage[0].promptTokens).toBe(5);
    expect(usage[0].completionTokens).toBe(3);
  });

  test("a billable streaming route that settles with literally zero extracted usage logs a distinct warning and skips recordUsage", async () => {
    const warnCalls: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    };
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [managed] }); // managed.markup = 2 (billable)
    // A stream that produces real relayed content but never emits any `usage`
    // key anywhere (e.g. an upstream that silently omits it) — hasContent is
    // true so it's relayed, but extractUsageFromSseBuffer returns null.
    const noUsageSse =
      'data: {"choices":[{"delta":{"content":"real answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl: FetchImpl = async () => sseResponse(noUsageSse);

    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl, logger },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await new Response(res.body).text();
    await flush();
    expect(usage).toHaveLength(0); // nothing to bill — but NOT silent:
    expect(warnCalls.some((m) => m.includes("ZERO extracted usage"))).toBe(true);
  });

  test("a non-billable (billingMode 'none') route settling with zero usage does NOT trigger the zero-usage warning", async () => {
    const warnCalls: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    };
    const free: UpstreamDescriptor = { ...managed, billingMode: "none", markup: 0 };
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [free] });
    const noUsageSse =
      'data: {"choices":[{"delta":{"content":"real answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl: FetchImpl = async () => sseResponse(noUsageSse);

    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl, logger },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await new Response(res.body).text();
    await flush();
    expect(usage).toHaveLength(0);
    expect(warnCalls.some((m) => m.includes("ZERO extracted usage"))).toBe(false);
  });

  test("a stream that fails mid-flight (upstream error frame, zero usage) does NOT trigger the zero-usage-extraction warning — a failed turn legitimately bills $0, that's not a usage-extraction bug", async () => {
    const warnCalls: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    };
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [managed] }); // billable (markup 2)
    // Real content streamed, then the upstream dies mid-flight with a
    // structured error frame and no usage — exactly the "mid-stream failure"
    // case PR #4821 (streaming reliability) surfaces as a real error, not a
    // clean empty completion.
    const midStreamErrorSse =
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
      'data: {"error":{"message":"Overloaded","type":"overloaded_error","code":"overloaded_error"}}\n\n';
    const fetchImpl: FetchImpl = async () => sseResponse(midStreamErrorSse);

    const res = await createGateway(
      hooks,
      { retry: fastRetry },
      { fetchImpl, logger },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await new Response(res.body).text();
    await flush();
    // Nothing billable — but this must read as a FAILED turn, not silence.
    expect(usage).toHaveLength(0);
    expect(warnCalls.some((m) => m.includes("ZERO extracted usage"))).toBe(false);
  });
});

describe("gateway.chatCompletions — BILLING-CORRECTNESS: atomic admission-hold reconciliation", () => {
  test("a hold taken at admission is reconciled (topped up) against the real cost on a successful request", async () => {
    const { hooks, usage } = makeHooks({
      resolveUpstream: async () => [managed],
      assertBillingActive: async () => ({ holdUsd: 0.01 }),
    });
    const fetchImpl = okFetch({
      model: "m",
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });

    const res = await createGateway(hooks, {}, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(200);
    await flush();
    expect(usage).toHaveLength(1);
    expect(usage[0].billingHoldUsd).toBe(0.01);
  });

  test("a hold is refunded (a zero-usage recordUsage call carrying billingHoldUsd) when the request fails BEFORE dispatch — model_unavailable", async () => {
    const { hooks, usage } = makeHooks({
      resolveUpstream: async () => [], // → no candidates → model_unavailable, before any dispatch
      assertBillingActive: async () => ({ holdUsd: 0.01 }),
    });

    const res = await createGateway(hooks, {}, {}).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("model_unavailable");
    await flush();
    // The refund is its own recordUsage call — zero usage, zero cost, hold present.
    expect(usage).toHaveLength(1);
    expect(usage[0].billingHoldUsd).toBe(0.01);
    expect(usage[0].promptTokens).toBe(0);
    expect(usage[0].finalCost).toBe(0);
  });

  test("a hold is refunded when the budget gate denies the request AFTER billing already admitted it", async () => {
    const { hooks, usage } = makeHooks({
      resolveUpstream: async () => [managed],
      assertBillingActive: async () => ({ holdUsd: 0.01 }),
      assertBudget: async () => {
        throw new Error("Project budget exhausted");
      },
    });

    const res = await createGateway(hooks, {}, {}).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });

    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("budget_exceeded");
    await flush();
    expect(usage).toHaveLength(1);
    expect(usage[0].billingHoldUsd).toBe(0.01);
  });

  test("no hold, no refund noise — a request with no billingHold never emits a hold-refund event on failure", async () => {
    const { hooks, usage } = makeHooks({ resolveUpstream: async () => [] });
    const res = await createGateway(hooks, {}, {}).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(400);
    await flush();
    expect(usage).toHaveLength(0);
  });
});

describe("gateway.chatCompletions — request size guard", () => {
  test("a body over maxRequestBytes is rejected with 413 before any upstream dispatch", async () => {
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    let dispatched = false;
    const fetchImpl: FetchImpl = async () => {
      dispatched = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const rawBody = `{"model":"x","pad":"${"z".repeat(500)}"}`;
    const res = await createGateway(
      hooks,
      { maxRequestBytes: 100 },
      { fetchImpl },
    ).chatCompletions({ authorization: "Bearer good", rawBody });

    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("request_too_large");
    expect(dispatched).toBe(false); // rejected up front — no upstream call
    await flush();
    expect(traces[0].ok).toBe(false);
    expect(traces[0].errorCode).toBe("request_too_large");
  });

  test("the guard is off by default — a large body dispatches normally", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const res = await createGateway(
      hooks,
      {},
      { fetchImpl: okFetch({ choices: [{ message: { content: "ok" } }] }) },
    ).chatCompletions({
      authorization: "Bearer good",
      rawBody: `{"model":"x","messages":[{"role":"user","content":"hi"}],"pad":"${"z".repeat(5000)}"}`,
    });

    expect(res.status).toBe(200);
  });
});

// End-to-end regression coverage for the client-disconnect finding: the
// inbound request's own AbortSignal must reach both the upstream fetch (before
// any response is chosen) and the streaming relay (after headers are already
// committed), through the full createGateway → handleChatCompletions →
// runFailover/relayStream pipeline — not just the lower-level units in
// isolation.
describe("gateway.chatCompletions — client abort propagation", () => {
  test("an already-aborted signal short-circuits before dispatching to the upstream fetch", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const ac = new AbortController();
    ac.abort();

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
      signal: ac.signal,
    });

    expect(res.status).toBe(499);
    expect((await res.json()).code).toBe("client_disconnected");
    expect(fetchCalls).toBe(0); // never spent an upstream call on a caller already gone
  });

  // Native's own upstream cancellation was a DIRECT mechanism: callUpstream
  // returned the raw upstream Response, and pipeline/streaming.ts's
  // relayStream called `.cancel()` on ITS body reader the moment the client
  // disconnected. The ai-sdk engine returns a Response wrapping a SYNTHESIZED
  // SSE stream (transports/ai-sdk/sse.ts's `openAiSseFromFullStream`) rather
  // than the raw upstream body, so that direct mechanism no longer reaches
  // the real upstream fetch — instead, cancellation is SIGNAL-based:
  // `callUpstream`'s combined abort signal is threaded all the way down to
  // `streamText()`'s own `abortSignal` (see ai-sdk/index.ts), and a real
  // `fetch()` (undici/Bun) tears down the underlying connection itself when
  // that signal fires — this is native platform behavior, not something this
  // package implements. A test double therefore has to simulate that same
  // signal-driven teardown to exercise the real invariant this test cares
  // about ("does the abort signal actually reach the fetch call"), rather
  // than asserting on a `ReadableStream.cancel()` callback a plain mock
  // stream never receives just because a signal elsewhere fired.
  test("an abort mid-stream propagates the client's abort signal all the way to the upstream fetch call", async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    let upstreamCancelled = false;
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl: FetchImpl = async (_url, init) => {
      init.signal?.addEventListener("abort", () => {
        upstreamCancelled = true;
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            upstreamController = c;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const ac = new AbortController();
    const resPromise = createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
      signal: ac.signal,
    });
    // The probe phase needs at least one content chunk before chatCompletions
    // resolves with a Response — push it as soon as the mock fetch has handed
    // back its controller (a handful of hook/auth microtasks upstream of this).
    for (let i = 0; i < 100 && !upstreamController; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    upstreamController.enqueue(
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
    );
    const res = await resPromise;
    expect(res.status).toBe(200);

    // Drain the one chunk, then disconnect — the mock upstream never calls
    // close(), so if the abort weren't honored this would hang forever.
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(upstreamCancelled).toBe(true);
  });
});

describe("gateway error envelope contract", () => {
  test("all pre-dispatch rejection classes use the complete error envelope", async () => {
    const cases: Array<{ code: string; run: () => Promise<Response> }> = [
      {
        code: "missing_token",
        run: async () => createGateway(makeHooks().hooks).chatCompletions({
          authorization: undefined, rawBody: "{}",
        }),
      },
      {
        code: "invalid_token",
        run: async () => createGateway(makeHooks().hooks).chatCompletions({
          authorization: "Bearer bad", rawBody: "{}",
        }),
      },
      {
        code: "subscription_required",
        run: async () => createGateway(makeHooks({
          assertBillingActive: async () => { throw new Error("inactive"); },
        }).hooks).chatCompletions({ authorization: "Bearer good", rawBody: "{}" }),
      },
      {
        code: "budget_exceeded",
        run: async () => createGateway(makeHooks({
          authorize: async () => ({ ok: false, status: 402, errorCode: "budget_exceeded", principal }),
        }).hooks).chatCompletions({ authorization: "Bearer good", rawBody: "{}" }),
      },
      {
        code: "invalid_json",
        run: async () => createGateway(makeHooks().hooks).chatCompletions({
          authorization: "Bearer good", rawBody: "not-json",
        }),
      },
      {
        code: "request_too_large",
        run: async () => createGateway(makeHooks().hooks, { maxRequestBytes: 2 }).chatCompletions({
          authorization: "Bearer good", rawBody: "{}x",
        }),
      },
      {
        code: "model_unavailable",
        run: async () => createGateway(makeHooks({ resolveUpstream: async () => [] }).hooks)
          .chatCompletions({ authorization: "Bearer good", rawBody: '{"model":"missing","messages":[{"role":"user","content":"hi"}]}' }),
      },
    ];

    for (const entry of cases) {
      const response = await entry.run();
      expectErrorContract(await response.json(), entry.code);
    }
  });

  test("model catalog authentication and failure exits use the complete error envelope", async () => {
    const gateway = createGateway(makeHooks({
      listModels: async () => { throw new Error("catalog database detail"); },
    }).hooks, {}, { logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const cases = [
      { response: await gateway.listModels(undefined), code: "missing_token" },
      { response: await gateway.listModels("Bearer bad"), code: "invalid_token" },
      { response: await gateway.listModels("Bearer good"), code: "models_error" },
    ];
    for (const entry of cases) expectErrorContract(await entry.response.json(), entry.code);
  });

  test("model catalog catches authentication infrastructure failures", async () => {
    const gateway = createGateway(makeHooks({
      authenticate: async () => { throw new Error("auth database unavailable"); },
    }).hooks, {}, { logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const response = await gateway.listModels("Bearer good");
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.message).toBe("Model catalog unavailable");
    expectErrorContract(body, "models_error");
  });

  test("a reader failure before first content preserves the actual upstream error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw new Error("provider socket reset"); },
    });
    const res = await createGateway(makeHooks().hooks, { retry: fastRetry }, {
      fetchImpl: async () => new Response(stream, { status: 200 }),
    }).chatCompletions({
      authorization: "Bearer good", rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe("provider socket reset");
    expectErrorContract(body, "upstream_error");
  });

  test("a reader failure after content emits an in-band OpenAI-shaped error frame and settles as failed", async () => {
    const { hooks, traces } = makeHooks();
    // Enqueue the content chunk, then error the stream on a LATER microtask
    // (not synchronously back-to-back within the same `pull()`) — the ai-sdk
    // engine's own SSE decode/transform pipeline reads a ReadableStream a
    // chunk ahead of what it's flushed downstream, so a same-tick
    // enqueue-then-throw can lose an already-buffered chunk to the pipeline
    // erroring out before it's individually parsed/flushed; a real network
    // disruption is never that synchronous either.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        ));
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.error(new Error("provider stream disconnected"));
      },
    });
    const res = await createGateway(hooks, { retry: fastRetry }, {
      fetchImpl: async () => new Response(stream, { status: 200 }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }).chatCompletions({
      authorization: "Bearer good", rawBody: '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(200);
    const output = await new Response(res.body).text();
    const errorLine = output.split("\n").find((line) => line.startsWith("data: {") && line.includes('"error"'));
    expect(errorLine).toBeDefined();
    const body = JSON.parse(errorLine!.slice(6));
    // The ai-sdk engine normalizes EVERY upstream failure it sees mid-stream
    // — a genuine in-band `{"error":{...}}` frame the provider itself sent,
    // or (this case) a raw reader/connection failure the AI SDK's own stream
    // consumption caught — into the SAME OpenAI-shaped `{"error":{"message",
    // "code"}}` frame (see transports/ai-sdk/sse.ts's `case 'error'`) before
    // it ever reaches this package's own pipeline/streaming.ts. That's a
    // narrower, MORE uniform shape than native's own gatewayErrorBody()
    // full envelope (which only ever applied to a PRE-CONTENT failure that
    // becomes a top-level classified JSON response — see the sibling
    // "before first content" test above) — the full envelope was never a
    // promise for an ALREADY-STREAMING frame under native either; the
    // client here already got a 200 with real content, so this is
    // necessarily an in-band frame, not a fresh top-level response.
    expect(body.error?.message).toBe("provider stream disconnected");
    await flush();
    expect(traces.at(-1)).toMatchObject({ ok: false, errorCode: "upstream_stream_error" });
  });
});
