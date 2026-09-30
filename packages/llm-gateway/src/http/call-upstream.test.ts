import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import { UpstreamHttpError } from '../errors';
import { callUpstream, openDirectStream } from './call-upstream';

const descriptor: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://provider.example/v1/',
  apiKey: 'secret',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'provider-model',
};

describe('callUpstream OpenAI-compatible passthrough', () => {
  test('performs one fetch and returns the provider response unchanged', async () => {
    let calls = 0;
    let received: { input: string; init: RequestInit } | undefined;
    const provider = new Response('provider failure', {
      status: 503,
      headers: { 'x-provider': 'exact' },
    });
    const response = await callUpstream(
      { model: 'requested', messages: [{ role: 'user', content: 'hello' }] },
      descriptor,
      {
        requestId: 'req_1',
        fetchImpl: async (input, init) => {
          calls += 1;
          received = { input, init };
          return provider;
        },
      },
    );

    expect(calls).toBe(1);
    expect(response).toBe(provider);
    expect(received?.input).toBe('https://provider.example/v1/chat/completions');
    expect(received?.init.headers).toMatchObject({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
      'x-request-id': 'req_1',
    });
    expect(JSON.parse(String(received?.init.body))).toMatchObject({ model: 'provider-model' });
  });

  test('does not dispatch when the client already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      callUpstream({}, descriptor, {
        signal: controller.signal,
        fetchImpl: async () => {
          calls += 1;
          return new Response();
        },
      }),
    ).rejects.toThrow('client disconnected');
    expect(calls).toBe(0);
  });

  // A resolution-time configuration defect: refused before any network call,
  // naming the provider so the log says which descriptor is broken.
  test.each([
    ['', 'missing baseUrl'],
    ['ftp://provider.example/v1', 'invalid baseUrl "ftp://provider.example/v1"'],
  ])('a descriptor with baseUrl %p is refused without a fetch', async (baseUrl, reason) => {
    let calls = 0;
    await expect(
      callUpstream({}, { ...descriptor, baseUrl }, {
        fetchImpl: async () => {
          calls += 1;
          return new Response();
        },
      }),
    ).rejects.toThrow(`upstream misconfigured for provider "openrouter": ${reason}`);
    expect(calls).toBe(0);
  });
});

// OpenRouter answers 200 and then reports an endpoint's rejection as the first
// `data:` frame. This is the frame Decart sent for a GLM request whose prompt
// plus max_tokens passed 1,048,576 (probed 2026-09-30).
const OVERFLOW_FRAME =
  '{"id":"gen-1","object":"chat.completion.chunk","model":"vendor/model","provider":"Decart","choices":[],' +
  '"error":{"code":400,"message":"Upstream error from Decart: Requested token count exceeds the model\'s maximum context length of 1048576 tokens.","metadata":{"error_type":"invalid_request"}}}';

function sse(chunks: string[], gapMs = 0): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
          if (gapMs) await Bun.sleep(gapMs);
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('callUpstream streamed direct responses', () => {
  const stream = { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] };

  test('an error as the first data frame throws its status before the client gets a byte', async () => {
    const error = await callUpstream(stream, descriptor, {
      fetchImpl: async () => sse([': OPENROUTER PROCESSING\n\n', `data: ${OVERFLOW_FRAME}\n\n`, 'data: [DONE]\n\n']),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).status).toBe(400);
    expect((error as UpstreamHttpError).body).toContain("exceeds the model's maximum context length");
  });

  test('an error frame without an HTTP code throws 502', async () => {
    const error = await callUpstream(stream, descriptor, {
      fetchImpl: async () => sse(['data: {"error":{"code":"server_error","message":"boom"}}\n\n']),
    }).catch((e: unknown) => e);
    expect((error as UpstreamHttpError).status).toBe(502);
  });

  test('comments then output replay every byte in order', async () => {
    const chunks = [': OPENROUTER PROCESSING\n\n', 'data: {"choices":[{"delta":{"con', 'tent":"hi"}}]}\n\n', 'data: [DONE]\n\n'];
    const response = await callUpstream(stream, descriptor, { fetchImpl: async () => sse(chunks) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(chunks.join(''));
  });

  test('an error after output stays in the stream', async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', `data: ${OVERFLOW_FRAME}\n\n`];
    const response = await callUpstream(stream, descriptor, { fetchImpl: async () => sse(chunks) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(chunks.join(''));
  });

  test('a stream that sends only comments is answered at the commit deadline', async () => {
    const started = Date.now();
    const response = await openDirectStream(
      sse([': OPENROUTER PROCESSING\n\n', 'data: {"choices":[{"delta":{"content":"late"}}]}\n\n'], 300),
      'openrouter',
      { commitAfterMs: 20 },
    );
    expect(Date.now() - started).toBeLessThan(250);
    expect(await response.text()).toContain('late');
  });

  test('a client abort during the wait answers at once, so the relay can settle the stop', async () => {
    const client = new AbortController();
    const pending = openDirectStream(
      new Response(new ReadableStream<Uint8Array>({ pull() {} }), { status: 200 }),
      'openrouter',
      { signal: client.signal },
    );
    client.abort();
    const response = await pending;
    expect(response.status).toBe(200);
    await response.body!.cancel();
  });

  test('a non-streaming request is returned unchanged', async () => {
    const provider = new Response(`data: ${OVERFLOW_FRAME}\n\n`, { status: 200 });
    const response = await callUpstream({ ...stream, stream: false }, descriptor, { fetchImpl: async () => provider });
    expect(response).toBe(provider);
  });
});

// OpenCode Go serves each model on the wire format its models.dev entry names:
// MiniMax/Qwen on Anthropic `/messages`, Grok/GPT/Muse on OpenAI `/responses`.
// A catalog model override resolves to these descriptors (apps/api's
// provider-registry.ts). Each must reach its own endpoint with the session header.
describe('callUpstream per-model wire format (OpenCode Go)', () => {
  const opencodeGo = {
    provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-go',
    billingMode: 'none', markup: 0, headers: { 'x-opencode-session': 'ses_1' },
  } as const;

  async function captured(descriptor: UpstreamDescriptor) {
    let seen: { input: string; init: RequestInit } | undefined;
    await callUpstream(
      { model: 'opencode-go/x', messages: [{ role: 'user', content: 'hi' }] },
      descriptor,
      { fetchImpl: async (input, init) => { seen = { input, init }; return new Response('no', { status: 500 }); } },
    ).catch(() => {});
    return {
      url: seen?.input,
      headers: new Headers(seen?.init.headers),
      body: JSON.parse(String(seen?.init.body)) as Record<string, unknown>,
    };
  }

  test('an @ai-sdk/anthropic model posts to /messages', async () => {
    const { url, headers, body } = await captured({
      ...opencodeGo, kind: 'anthropic', npm: '@ai-sdk/anthropic', resolvedModel: 'minimax-m3',
    });
    expect(url).toBe('https://opencode.ai/zen/go/v1/messages');
    expect(headers.get('x-opencode-session')).toBe('ses_1');
    expect(body.model).toBe('minimax-m3');
  });

  // Anthropic's API wants `claude-haiku-4-5` for `claude-haiku-4.5`; other
  // Anthropic-format providers take their own dotted ids verbatim.
  test('a dotted non-Claude id reaches an Anthropic-format provider unchanged', async () => {
    const { body } = await captured({
      ...opencodeGo, kind: 'anthropic', npm: '@ai-sdk/anthropic', resolvedModel: 'qwen3.8-flash',
    });
    expect(body.model).toBe('qwen3.8-flash');
  });

  test('a dotted Claude id is still dashed for Anthropic', async () => {
    const { body } = await captured({
      ...opencodeGo, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic',
      npm: '@ai-sdk/anthropic', resolvedModel: 'claude-haiku-4.5',
    });
    expect(body.model).toBe('claude-haiku-4-5');
  });

  test('an @ai-sdk/openai model posts to /responses without Codex defaults', async () => {
    const { url, headers, body } = await captured({
      ...opencodeGo, kind: 'openai-responses', npm: '@ai-sdk/openai', resolvedModel: 'gpt-5.6-luna',
    });
    expect(url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(headers.get('x-opencode-session')).toBe('ses_1');
    expect(body.model).toBe('gpt-5.6-luna');
    // Codex-only quirks (forced 'low' effort, store:false) stay on Codex.
    expect(body.reasoning).toBeUndefined();
    expect(body.store).toBeUndefined();
  });

  test('an OpenAI-compatible model posts to /chat/completions with the session header', async () => {
    const { url, headers } = await captured({
      ...opencodeGo, kind: 'openai-compat', npm: '@ai-sdk/openai-compatible', resolvedModel: 'glm-5.3',
    });
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(headers.get('x-opencode-session')).toBe('ses_1');
  });
});
