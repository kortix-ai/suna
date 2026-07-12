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
      choices: [{ message: { content: "ok" } }],
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
      choices: [{ message: { content: "ok" } }],
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
      rawBody: '{"model":"x"}',
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
      rawBody: '{"model":"x"}',
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
      choices: [{ message: { content: "ok" } }],
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
      choices: [{ message: { content: "ok" } }],
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
      choices: [{ message: { content: "ok" } }],
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
      rawBody: '{"model":"x"}',
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
      rawBody: '{"model":"x"}',
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
      rawBody: '{"model":"x"}',
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
      rawBody: '{"model":"x","stream":true}',
    });

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    expect(text).toBe(goodSse);
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
      rawBody: '{"model":"x","stream":true}',
    });

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    expect(text).toBe(goodSse);
    expect(text).not.toContain('"finish_reason":"stop"}]}\n\ndata: [DONE]'); // candidate A's empty frame absent
    await flush();
    expect(traces.find((t) => t.ok)?.provider).toBe("b");
  });

  test("streaming: every candidate's stream is empty → 502 empty_completion, not a fabricated SSE response", async () => {
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () => sseResponse(emptySse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true}',
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
      rawBody: '{"model":"x","stream":true}',
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

  test("streaming: an error frame from candidate A still fails over to a healthy candidate B", async () => {
    const a: UpstreamDescriptor = { ...managed, provider: "a", baseUrl: "https://a.test/v1" };
    const b: UpstreamDescriptor = { ...managed, provider: "b", baseUrl: "https://b.test/v1" };
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [a, b] });
    const fetchImpl: FetchImpl = async (url) =>
      sseResponse(new URL(url).hostname === "a.test" ? errorSse : goodSse);

    const res = await createGateway(hooks, { retry: fastRetry }, { fetchImpl }).chatCompletions({
      authorization: "Bearer good",
      rawBody: '{"model":"x","stream":true}',
    });

    expect(res.status).toBe(200);
    expect(await new Response(res.body).text()).toBe(goodSse);
    await flush();
    expect(traces.find((t) => t.ok)?.provider).toBe("b");
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
      rawBody: `{"model":"x","pad":"${"z".repeat(5000)}"}`,
    });

    expect(res.status).toBe(200);
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
          .chatCompletions({ authorization: "Bearer good", rawBody: '{"model":"missing"}' }),
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
      authorization: "Bearer good", rawBody: '{"model":"x","stream":true}',
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe("provider socket reset");
    expectErrorContract(body, "upstream_error");
  });

  test("a reader failure after content emits a complete SSE error envelope and settles as failed", async () => {
    const { hooks, traces } = makeHooks();
    let pull = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        if (pull === 1) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          ));
          return;
        }
        throw new Error("provider stream disconnected");
      },
    });
    const res = await createGateway(hooks, { retry: fastRetry }, {
      fetchImpl: async () => new Response(stream, { status: 200 }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }).chatCompletions({
      authorization: "Bearer good", rawBody: '{"model":"x","stream":true}',
    });
    expect(res.status).toBe(200);
    const output = await new Response(res.body).text();
    const errorLine = output.split("\n").find((line) => line.startsWith("data: {") && line.includes('"error"'));
    expect(errorLine).toBeDefined();
    const body = JSON.parse(errorLine!.slice(6));
    expect(body.message).toBe("provider stream disconnected");
    expectErrorContract(body, "upstream_stream_error");
    await flush();
    expect(traces.at(-1)).toMatchObject({ ok: false, errorCode: "upstream_stream_error" });
  });
});
