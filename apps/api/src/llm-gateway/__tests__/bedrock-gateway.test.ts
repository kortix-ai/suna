import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createLlmGateway } from '..';
import type { LlmGatewayConfig, LlmGatewayHooks, UsageEvent } from '../types';
import { __setSenders } from '../services/bedrock-client';
import { resolveBedrockModel, isBedrockModel, BEDROCK_MODELS } from '../services/bedrock-models';
import { calculateCost } from '../services/pricing';

function makeHooks(): { hooks: LlmGatewayHooks; recorded: UsageEvent[] } {
  const recorded: UsageEvent[] = [];
  const hooks: LlmGatewayHooks = {
    authenticateToken: async (token) =>
      token === 'good' ? { userId: 'u1', accountId: 'a1' } : null,
    assertBillingActive: async () => {},
    recordUsage: async (e) => {
      recorded.push(e);
    },
  };
  return { hooks, recorded };
}

const bedrockConfig: LlmGatewayConfig = {
  enabled: true,
  openrouterApiKey: 'sk-or-test',
  baseUrl: 'https://test.openrouter.example/v1',
  markup: 1.5,
  bedrock: { enabled: true, region: 'us-west-2' },
};

function req(body: unknown): Request {
  return new Request('http://local.test/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer good' },
    body: JSON.stringify(body),
  });
}

let restore = () => {};
afterEach(() => restore());

describe('bedrock model registry', () => {
  test('isBedrockModel keys off the bedrock/ prefix', () => {
    expect(isBedrockModel('bedrock/anthropic/claude-opus-4.8')).toBe(true);
    expect(isBedrockModel('anthropic/claude-opus-4.8')).toBe(false);
  });

  test('resolveBedrockModel returns the inference profile id', () => {
    const entry = resolveBedrockModel('bedrock/anthropic/claude-opus-4.8');
    expect(entry?.bedrockId).toContain('anthropic.claude-opus');
    expect(resolveBedrockModel('bedrock/nope/nope')).toBeNull();
    expect(resolveBedrockModel('anthropic/claude-opus-4.8')).toBeNull();
  });

  test('pricing uses the bedrock registry entry', () => {
    const m = 'bedrock/anthropic/claude-sonnet-4.6';
    const entry = BEDROCK_MODELS['anthropic/claude-sonnet-4.6'];
    const { upstreamCost, finalCost } = calculateCost(
      m,
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 },
      1.5,
    );
    expect(upstreamCost).toBeCloseTo(entry.inputPerMillion, 6);
    expect(finalCost).toBeCloseTo(entry.inputPerMillion * 1.5, 6);
  });
});

describe('gateway — bedrock routing (non-streaming)', () => {
  test('routes a bedrock/ model to Bedrock and records usage with provider=bedrock', async () => {
    let sentReq: any = null;
    restore = __setSenders({
      converse: async (_cfg, r) => {
        sentReq = r;
        return {
          output: { message: { role: 'assistant', content: [{ text: 'hi from bedrock' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 4 },
        };
      },
    });

    const { hooks, recorded } = makeHooks();
    const app = createLlmGateway(bedrockConfig, hooks);
    const res = await app.fetch(
      req({
        model: 'bedrock/anthropic/claude-opus-4.8',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].message.content).toBe('hi from bedrock');

    // It hit Bedrock with the resolved inference-profile id, not OpenRouter.
    expect(sentReq.modelId).toContain('anthropic.claude-opus');

    await new Promise((r) => setTimeout(r, 5));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].provider).toBe('bedrock');
    expect(recorded[0].promptTokens).toBe(20);
    expect(recorded[0].completionTokens).toBe(10);
    expect(recorded[0].cachedTokens).toBe(4);
    expect(recorded[0].model).toBe('bedrock/anthropic/claude-opus-4.8');
  });

  test('does NOT route to bedrock when bedrock.enabled is false', async () => {
    const originalFetch = globalThis.fetch;
    let fetchUrl = '';
    globalThis.fetch = (async (url: any) => {
      fetchUrl = String(url);
      return new Response(JSON.stringify({ model: 'm', usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };

    const { hooks } = makeHooks();
    const app = createLlmGateway({ ...bedrockConfig, bedrock: { enabled: false, region: 'us-west-2' } }, hooks);
    const res = await app.fetch(
      req({ model: 'bedrock/anthropic/claude-opus-4.8', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    // fell through to OpenRouter
    expect(fetchUrl).toContain('openrouter');
  });

  test('400 on unknown bedrock model id', async () => {
    restore = __setSenders({ converse: async () => ({}) });
    const { hooks } = makeHooks();
    const app = createLlmGateway(bedrockConfig, hooks);
    const res = await app.fetch(
      req({ model: 'bedrock/made/up', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('gateway — bedrock routing (streaming)', () => {
  test('streams OpenAI SSE chunks and records usage at the end', async () => {
    async function* fakeStream() {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0 } } };
    }
    restore = __setSenders({
      converseStream: async () => ({ stream: fakeStream() }),
    });

    const { hooks, recorded } = makeHooks();
    const app = createLlmGateway(bedrockConfig, hooks);
    const res = await app.fetch(
      req({
        model: 'bedrock/anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trim().endsWith('[DONE]')).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].provider).toBe('bedrock');
    expect(recorded[0].streaming).toBe(true);
    expect(recorded[0].promptTokens).toBe(3);
    expect(recorded[0].completionTokens).toBe(2);
  });
});
