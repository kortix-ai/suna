import { describe, expect, test } from 'bun:test';
import { createGateway } from '../create-gateway';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import { requestFieldError } from './request-fields';
import { createRouteMemory, routeMemoryKey, type RouteMemory } from './route-memory';
import { handleChatCompletions } from './simple-handler';

// KRTX-3410: `stream: "true"` and `stream: 1` answered a buffered JSON body, so
// an SSE client waited for events that never came; `max_tokens: -1` was dropped.
describe('requestFieldError', () => {
  test('a well-typed body, or one without the fields, has no error', () => {
    expect(requestFieldError({ model: 'm', messages: [] })).toBeNull();
    expect(requestFieldError({ stream: true, max_tokens: 5 })).toBeNull();
    expect(requestFieldError({ stream: false, max_completion_tokens: 1, max_output_tokens: 4096 })).toBeNull();
    // OpenAI's API accepts an explicit null for both.
    expect(requestFieldError({ stream: null, max_tokens: null })).toBeNull();
  });

  test('a messages value that is not an array of objects is refused; an empty array is a type-valid body', () => {
    for (const messages of ['hi', 1, {}, [null], [1], [[]], ['user']]) {
      expect({ messages, error: requestFieldError({ messages }) }).toEqual({ messages, error: '`messages` must be an array of message objects' });
    }
    for (const messages of [[], [{ role: 'user', content: 'hi' }], null]) {
      expect({ messages, error: requestFieldError({ messages }) }).toEqual({ messages, error: null });
    }
  });

  test('a Responses input that is not a string or an array of objects is refused', () => {
    for (const input of [5, {}, [null], [1], ['hi']]) {
      expect({ input, error: requestFieldError({ input }) }).toEqual({ input, error: '`input` must be a string or an array of input items' });
    }
    for (const input of ['hi', [], [{ type: 'message', role: 'user', content: 'hi' }], null]) {
      expect({ input, error: requestFieldError({ input }) }).toEqual({ input, error: null });
    }
  });

  // Strix on #11455: a body nested ~50,000 levels deep overflowed JSON.stringify
  // in the translators before authentication (a 503 counted toward /health).
  test('a body nested more than 128 levels deep is refused without overflowing', () => {
    const nest = (depth: number) => JSON.parse('{"a":'.repeat(depth) + '1' + '}'.repeat(depth)) as Record<string, unknown>;
    expect(requestFieldError({ messages: [{ role: 'user', content: 'hi' }], tools: [nest(100)] })).toBeNull();
    for (const depth of [130, 50_000]) {
      expect({ depth, error: requestFieldError({ messages: [{ role: 'user', content: 'hi' }], tools: [nest(depth)] }) })
        .toEqual({ depth, error: 'The request body is nested more than 128 levels deep' });
    }
  });

  test('a non-boolean stream is refused', () => {
    for (const stream of ['true', 'false', 1, 0, {}]) {
      expect(requestFieldError({ stream })).toBe('`stream` must be true or false');
    }
  });

  test('a token cap that is not a positive integer is refused', () => {
    for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      for (const value of [-1, 0, 2.5, '5', Number.NaN]) {
        expect(requestFieldError({ [field]: value })).toBe(`\`${field}\` must be a positive integer`);
      }
    }
  });
});

describe('handleChatCompletions refuses a mistyped field before any upstream call', () => {
  const principal = { userId: 'user', accountId: 'account', projectId: 'project' };
  const descriptor: UpstreamDescriptor = {
    provider: 'provider-a',
    kind: 'openai-compat',
    baseUrl: 'https://provider-a.example/v1',
    apiKey: 'key',
    billingMode: 'credits',
    markup: 1,
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  };

  test('stream: "true" → 400 invalid_request, one failed trace, no upstream fetch', async () => {
    const traces: GatewayTrace[] = [];
    let fetched = 0;
    const hooks: GatewayHooks = {
      authenticate: async () => principal,
      authorize: async () => ({ ok: true, principal }),
      resolveRoute: async () => ({ policyId: 'route', primaryModel: 'm', fallbackModels: [], fallbackOn: 'transient' }),
      resolveUpstream: async () => [descriptor],
      assertBillingActive: async () => {},
      recordUsage: async () => {},
      recordTrace: async (trace) => {
        traces.push(trace);
      },
    };
    const response = await handleChatCompletions(
      {
        hooks,
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          fetched++;
          return new Response('{}', { status: 200 });
        },
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', messages: [{ role: 'user', content: 'hi' }], stream: 'true' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request', message: '`stream` must be true or false' });
    expect(fetched).toBe(0);
    for (let i = 0; i < 20 && traces.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 400, ok: false, errorCode: 'invalid_request' });
  });

  // KRTX-3421: a body with no user or assistant message reached the model's
  // transport (or, during a fallback hold, the fallback's upstream), so one body
  // got different errors; a non-object element crashed the transport.
  const NO_CONVERSATION = 'The request has no user or assistant message to answer.';
  const run = async (patch: Record<string, unknown>, extra: Partial<GatewayHooks> = {}, routeMemory?: RouteMemory) => {
    let fetched = 0;
    const usage: UsageEvent[] = [];
    const hooks: GatewayHooks = {
      authenticate: async () => principal,
      authorize: async () => ({ ok: true, principal }),
      resolveRoute: async () => ({ policyId: 'route', primaryModel: 'm', fallbackModels: ['fb'], fallbackOn: 'transient' }),
      resolveUpstream: async () => [descriptor],
      assertBillingActive: async () => {},
      recordUsage: async (event) => {
        usage.push(event);
      },
      recordTrace: async () => {},
      ...extra,
    };
    const response = await handleChatCompletions(
      {
        hooks,
        routeMemory,
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          fetched++;
          return new Response('{}', { status: 200 });
        },
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', ...patch }) },
    );
    const body = (await response.json()) as { error?: Record<string, unknown> } & Record<string, unknown>;
    await Bun.sleep(0);
    return { status: response.status, details: body.error ?? body, fetched, usage };
  };

  test('no user or assistant message → the gateway 400 with a request_id, no upstream fetch', async () => {
    for (const patch of [
      {},
      { messages: [] },
      { messages: null },
      { messages: [{ role: 'system', content: 'be brief' }] },
      { messages: [{ role: 'developer', content: 'be brief' }] },
      { messages: [{ role: 'tool', tool_call_id: 'c1', content: 'x' }] },
    ]) {
      const { status, details, fetched } = await run(patch);
      expect({ patch, status, fetched }).toEqual({ patch, status: 400, fetched: 0 });
      expect(details).toMatchObject({ code: 'invalid_request', message: NO_CONVERSATION, requested_model: 'requested-model' });
      expect(typeof details.request_id).toBe('string');
    }
  });

  test('a messages value that is not an array of objects → 400 naming `messages`, no upstream fetch', async () => {
    for (const patch of [{ messages: 'hi' }, { messages: [null] }, { messages: [{ role: 'user', content: 'hi' }, 1] }]) {
      const { status, details, fetched } = await run(patch);
      expect({ patch, status, fetched }).toEqual({ patch, status: 400, fetched: 0 });
      expect(details).toMatchObject({ code: 'invalid_request', message: '`messages` must be an array of message objects' });
    }
  });

  test('the admission hold taken by admit is refunded on that 400', async () => {
    const { status, fetched, usage } = await run({ messages: [] }, {
      admit: async () => ({
        admission: { ok: true, principal },
        route: { policyId: 'route', primaryModel: 'm', fallbackModels: [] },
        upstream: [descriptor],
        billing: { holdUsd: 0.01 },
      }),
    });
    expect({ status, fetched }).toEqual({ status: 400, fetched: 0 });
    expect(usage).toEqual([expect.objectContaining({ billingHoldUsd: 0.01, finalCost: 0 })]);
  });

  test('a fallback hold on the routed model does not send the body to the fallback', async () => {
    const routeMemory = createRouteMemory();
    routeMemory.hold(routeMemoryKey(principal, 'm'), {
      fallbackModel: 'fb',
      failure: { attempt: 1, provider: 'provider-a', routeModel: 'm', resolvedModel: 'm', stage: 'dispatch', status: 503, code: 'upstream_error', message: 'down' },
      byok: false,
    }, 60);
    const { status, details, fetched } = await run({ messages: [] }, {}, routeMemory);
    expect({ status, fetched }).toEqual({ status: 400, fetched: 0 });
    expect(details).toMatchObject({ code: 'invalid_request', message: NO_CONVERSATION });
  });
});

describe('the Anthropic and Responses ingresses refuse a mistyped field in their own envelope', () => {
  const hooks: GatewayHooks = {
    authenticate: async () => ({ userId: 'u', accountId: 'a', projectId: 'p' }),
    resolveUpstream: async () => [],
    assertBillingActive: async () => {},
    recordUsage: async () => {},
    recordTrace: async () => {},
  };

  test('messages: stream "true" and max_tokens -1 → 400 with the field named', async () => {
    const gateway = createGateway(hooks);
    for (const [patch, message] of [
      [{ stream: 'true' }, '`stream` must be true or false'],
      [{ max_tokens: -1 }, '`max_tokens` must be a positive integer'],
    ] as const) {
      const res = await gateway.messages({
        authorization: 'Bearer good',
        rawBody: JSON.stringify({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], ...patch }),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(message);
    }
  });

  // KRTX-3421: the same rule as chat, answered after authentication.
  const NO_CONVERSATION = 'The request has no user or assistant message to answer.';

  test('messages: no user message, even with a system prompt → 400; without a token → 401 first', async () => {
    const gateway = createGateway(hooks);
    for (const patch of [{ messages: [] }, { messages: [], system: 'be brief' }, {}]) {
      const res = await gateway.messages({
        authorization: 'Bearer good',
        rawBody: JSON.stringify({ model: 'm', max_tokens: 16, ...patch }),
      });
      expect({ patch, status: res.status }).toEqual({ patch, status: 400 });
      expect(JSON.stringify(await res.json())).toContain(NO_CONVERSATION);
    }
    const anonymous = await gateway.messages({ authorization: undefined, rawBody: '{}' });
    expect(anonymous.status).toBe(401);
  });

  test('messages: an element that is not an object → 400 naming `messages`', async () => {
    const gateway = createGateway(hooks);
    const res = await gateway.messages({
      authorization: 'Bearer good',
      rawBody: JSON.stringify({ model: 'm', max_tokens: 16, messages: [null] }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('`messages` must be an array of message objects');
  });

  // These threw a TypeError in the translators before authentication: a 503.
  test('a malformed input item or content block is a 400, never a crash', async () => {
    const gateway = createGateway(hooks);
    for (const input of [[null], 5]) {
      const res = await gateway.responses({ authorization: 'Bearer good', rawBody: JSON.stringify({ model: 'm', input }) });
      expect({ input, status: res.status }).toEqual({ input, status: 400 });
      expect(JSON.stringify(await res.json())).toContain('`input` must be a string or an array of input items');
    }
    const res = await gateway.messages({
      authorization: 'Bearer good',
      rawBody: JSON.stringify({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: [null, { type: 'text', text: 'hi' }] }] }),
    });
    // The null block is skipped; the text reaches routing, where this test's hooks have no provider.
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('TypeError');
  });

  test('a body nested 50,000 levels deep is a 400 on both ingresses, never a stack overflow', async () => {
    const gateway = createGateway(hooks);
    const deep = '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000);
    const bodies = [
      [gateway.messages, `{"model":"m","max_tokens":16,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"f","input":${deep}}]},{"role":"user","content":"go"}]}`],
      [gateway.responses, `{"model":"m","input":[{"type":"message","role":"user","content":"hi"},{"type":"function_call_output","call_id":"c","output":${deep}}]}`],
    ] as const;
    for (const [send, rawBody] of bodies) {
      const res = await send({ authorization: undefined, rawBody });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('nested more than 128 levels deep');
    }
  });

  test('responses: an empty input, with or without instructions → 400', async () => {
    const gateway = createGateway(hooks);
    for (const patch of [{ input: [] }, { instructions: 'be brief', input: [] }]) {
      const res = await gateway.responses({ authorization: 'Bearer good', rawBody: JSON.stringify({ model: 'm', ...patch }) });
      expect({ patch, status: res.status }).toEqual({ patch, status: 400 });
      expect(JSON.stringify(await res.json())).toContain(NO_CONVERSATION);
    }
  });

  test('responses: stream 1 and max_output_tokens 0 → 400 with the field named', async () => {
    const gateway = createGateway(hooks);
    for (const [patch, message] of [
      [{ stream: 1 }, '`stream` must be true or false'],
      [{ max_output_tokens: 0 }, '`max_output_tokens` must be a positive integer'],
    ] as const) {
      const res = await gateway.responses({
        authorization: 'Bearer good',
        rawBody: JSON.stringify({ model: 'm', input: 'hi', ...patch }),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(message);
    }
  });

  // Valid JSON that is not an object (`null`, `1`, `"x"`, `[]`) used to throw
  // a TypeError on `body.stream`: a 500 for the caller's own malformed body.
  test('a JSON body that is not an object → 400 Invalid JSON body on both ingresses', async () => {
    const gateway = createGateway(hooks);
    for (const rawBody of ['null', '1', '"x"', '[]']) {
      for (const send of [gateway.messages, gateway.responses]) {
        const res = await send({ authorization: 'Bearer good', rawBody });
        expect({ rawBody, status: res.status }).toEqual({ rawBody, status: 400 });
        expect(JSON.stringify(await res.json())).toContain('Invalid JSON body');
      }
    }
  });
});
