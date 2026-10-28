import { describe, expect, test } from 'bun:test';
import { createGateway } from '../create-gateway';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor } from '../domain';
import { requestFieldError } from './request-fields';
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
