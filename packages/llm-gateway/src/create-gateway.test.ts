import { describe, expect, test } from 'bun:test';

import { createGateway } from './create-gateway';
import type { GatewayHooks, UpstreamDescriptor } from './domain';
import type { FetchImpl } from './http';

// Piece B: the Anthropic Messages ingress (`gateway.messages`) must run
// through the SAME pipeline as `gateway.chatCompletions` — these tests drive
// it end to end (translate in -> pipeline -> translate out) rather than just
// the pure translation functions covered by ingress/anthropic-messages.test.ts.

const principal = { userId: 'u1', accountId: 'a1', projectId: 'p1', keyId: 'k1' };

const managed: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://up.test/v1',
  apiKey: 'sk',
  billingMode: 'credits',
  markup: 1,
};

const fastRetry = { sleep: async () => {}, rand: () => 0.5, baseDelayMs: 1, maxAttempts: 2 };

function makeHooks(over: Partial<GatewayHooks> = {}): GatewayHooks {
  return {
    authenticate: async (token) => (token === 'good' ? principal : null),
    resolveUpstream: async () => [managed],
    assertBillingActive: async () => {},
    recordUsage: async () => {},
    recordTrace: async () => {},
    ...over,
  };
}

describe('gateway.messages (Anthropic Messages ingress)', () => {
  test('401 without a bearer token, in the Anthropic error envelope (not the OpenAI-compat one)', async () => {
    const res = await createGateway(makeHooks(), { retry: fastRetry }).messages({
      authorization: undefined,
      rawBody: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    // Not the OpenAI-compat shape a bare chatCompletions() 401 would return.
    expect((body as unknown as { code?: unknown }).code).toBeUndefined();
  });

  test('400 on invalid JSON, in the Anthropic error envelope', async () => {
    const res = await createGateway(makeHooks(), { retry: fastRetry }).messages({
      authorization: 'Bearer good',
      rawBody: 'not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
  });

  test('non-streaming: translates an Anthropic request through the SAME pipeline as chatCompletions and back to an Anthropic message', async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = async (_url, init) => {
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'anthropic/claude-sonnet-4-6',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi there' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const res = await createGateway(makeHooks(), { retry: fastRetry }, { fetchImpl }).messages({
      authorization: 'Bearer good',
      rawBody: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        system: 'be nice',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    // Pipeline dispatched an OpenAI chat.completions body upstream, not an
    // Anthropic-shaped one — the translation happens only at the edges.
    expect(seenBody.messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hello' },
    ]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'anthropic/claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  });

  test('streaming: relays an Anthropic SSE event stream translated live from the upstream OpenAI chunks', async () => {
    const sseBody =
      `data: ${JSON.stringify({ id: 'c1', model: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'c1', model: 'x', choices: [{ index: 0, delta: { content: 'yo' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'c1', model: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    const fetchImpl: FetchImpl = async () =>
      new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const res = await createGateway(makeHooks(), { retry: fastRetry }, { fetchImpl }).messages({
      authorization: 'Bearer good',
      rawBody: JSON.stringify({
        model: 'x',
        max_tokens: 8,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await new Response(res.body).text();
    const events = text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => block.split('\n')[0].replace('event: ', ''));
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });
});
