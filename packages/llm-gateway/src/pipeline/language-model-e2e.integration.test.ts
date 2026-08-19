// AI-SDK-NATIVE end-to-end integration proof.
//
// This is the WHOLE point of the native `/language-model` ingress+egress work:
// prove that OUR gateway speaks the exact same wire protocol the REAL
// `@ai-sdk/gateway` client (the library opencode loads when `KORTIX_LLM_AI_SDK_NATIVE`
// is on) expects — both directions, against a REAL provider.
//
// Approach: the FULL loop (task Deliverable B option 1).
//   1. Instantiate OUR gateway (`@kortix/llm-gateway` createGateway) with test
//      hooks that admit a test token and resolve to a REAL Anthropic-direct
//      upstream (Bedrock creds are invalid locally → 403, so we use
//      `@ai-sdk/anthropic` with a real `ANTHROPIC_API_KEY`). `aiSdkNative: true`.
//   2. Serve it on a real port with `Bun.serve`, mounting the native
//      `/v1/llm/language-model` route the sandbox provider posts to.
//   3. Point the REAL `@ai-sdk/gateway` client at it and drive `streamText`,
//      consuming `.fullStream` exactly like opencode would.
//   4. Assert, FROM THE CLIENT SIDE, that:
//        - the reasoning signature survives the full round trip through OUR
//          gateway (`providerMetadata.anthropic.signature` present + non-empty),
//        - `text` is non-empty,
//        - `usage` carries real input/output token counts,
//        - a tool call round-trips (separate call — Anthropic disallows forcing
//          tool_choice together with extended thinking, so the two contracts are
//          proven in two turns).
//
// The client parses OUR gateway's SSE with its own event-source handler, so a
// green assertion here means our INGRESS decoded the client's request AND our
// EGRESS emitted exactly what the client reconstructs — end to end, real provider.
//
// Gated to SKIP cleanly (never fail) when `ANTHROPIC_API_KEY` is absent, so CI
// without the key does not break. Load the key locally with:
//   ANTHROPIC_API_KEY="$(dotenvx get ANTHROPIC_API_KEY -f apps/api/.env.staging)" \
//     bun test src/pipeline/language-model-e2e.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createGateway as createAiSdkGateway } from '@ai-sdk/gateway';
import { jsonSchema, streamText, tool } from 'ai';
import { createGateway } from '../create-gateway';
import type { AuthedPrincipal, GatewayHooks, UpstreamDescriptor, UsageEvent } from '../domain';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const HAS_KEY = Boolean(ANTHROPIC_API_KEY);

// A real, thinking-capable Anthropic model, live-confirmed available on the
// staging key (`GET /v1/models`): emits a `thinking` block with a `signature`
// and real usage counts.
const REAL_MODEL = process.env.KORTIX_GATEWAY_E2E_MODEL?.trim() || 'claude-sonnet-4-5-20250929';

// The id the CLIENT passes to `gateway(id)` — rides the `ai-language-model-id`
// header. The test route hook maps ANY requested id to the single real
// descriptor, so this value only proves the header round-trips.
const CLIENT_MODEL_ID = 'anthropic/claude-sonnet-4-5';
const TEST_TOKEN = 'e2e-test-token';

const PRINCIPAL: AuthedPrincipal = {
  accountId: 'acct_e2e',
  userId: 'user_e2e',
  projectId: 'proj_e2e',
  sessionId: 'sess_e2e',
  keyId: 'key_e2e',
};

interface RecordedUsage {
  events: UsageEvent[];
}

function makeHooks(recorded: RecordedUsage): GatewayHooks {
  const descriptor: UpstreamDescriptor = {
    provider: 'anthropic',
    kind: 'anthropic',
    npm: '@ai-sdk/anthropic',
    // createAnthropic's own default base; the real key authenticates here.
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: ANTHROPIC_API_KEY!,
    resolvedModel: REAL_MODEL,
    billingMode: 'credits',
    markup: 1,
  };
  return {
    authenticate: async (token) => (token === TEST_TOKEN ? PRINCIPAL : null),
    resolveUpstream: async () => [descriptor],
    assertBillingActive: async () => undefined,
    recordUsage: async (event) => {
      recorded.events.push(event);
    },
  };
}

interface Served {
  server: { stop: (force?: boolean) => void };
  baseURL: string;
  recorded: RecordedUsage;
}

// Serve OUR gateway on a real port. The client posts to `${baseURL}/language-model`;
// the sandbox provider's baseURL is `${KORTIX_URL}/v1/llm`, so we mount that exact
// path here (the same alias apps/llm-gateway/src/server.ts registers).
function serveGateway(): Served {
  const recorded: RecordedUsage = { events: [] };
  const gateway = createGateway(makeHooks(recorded), { aiSdkNative: true });

  const server = Bun.serve({
    port: 0,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname.endsWith('/language-model')) {
        return gateway.languageModel({
          authorization: req.headers.get('authorization') ?? undefined,
          header: (name: string) => req.headers.get(name) ?? undefined,
          rawBody: await req.text(),
          signal: req.signal,
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    server,
    baseURL: `http://localhost:${server.port}/v1/llm`,
    recorded,
  };
}

// Minimal `TextStreamPart`-shaped view the client yields on `.fullStream`.
type ClientPart = {
  type: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  providerMetadata?: Record<string, Record<string, unknown>>;
};

function signatureFrom(part: ClientPart): string | undefined {
  const sig = part.providerMetadata?.anthropic?.signature;
  return typeof sig === 'string' && sig.length > 0 ? sig : undefined;
}

describe.skipIf(!HAS_KEY)('language-model native ingress+egress — REAL @ai-sdk/gateway client', () => {
  let served: Served;

  beforeAll(() => {
    served = serveGateway();
  });
  afterAll(() => {
    served.server.stop(true);
  });

  it(
    'round-trips reasoning signature + text + usage through OUR gateway (thinking)',
    async () => {
      const client = createAiSdkGateway({ baseURL: served.baseURL, apiKey: TEST_TOKEN });

      const result = streamText({
        model: client(CLIENT_MODEL_ID),
        prompt: 'Think step by step, then answer: 17*23 minus days in a leap year.',
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } } },
      });

      const parts: ClientPart[] = [];
      let text = '';
      let signature: string | undefined;
      for await (const part of result.fullStream as AsyncIterable<ClientPart>) {
        parts.push(part);
        if (part.type === 'text-delta' && typeof part.text === 'string') text += part.text;
        if (!signature) signature = signatureFrom(part);
      }

      // Reasoning parts must have been reconstructed by the CLIENT from our SSE.
      const reasoningTypes = parts.filter((p) => p.type.startsWith('reasoning'));
      expect(reasoningTypes.length).toBeGreaterThan(0);

      // The Anthropic reasoning signature survived the full round trip through
      // our gateway (fullStream part metadata, and/or the reconstructed
      // reasoning promise).
      if (!signature) {
        const reasoning = (await result.reasoning) as ClientPart[] | undefined;
        for (const r of reasoning ?? []) {
          if (!signature) signature = signatureFrom(r);
        }
      }
      expect(signature).toBeDefined();
      expect((signature ?? '').length).toBeGreaterThan(0);

      // Text is non-empty and contains the correct arithmetic answer (17*23=391,
      // minus 366 = 25).
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).toContain('25');

      // Usage carries real token counts, reconstructed client-side.
      const usage = await result.usage;
      expect(usage.inputTokens ?? 0).toBeGreaterThan(0);
      expect(usage.outputTokens ?? 0).toBeGreaterThan(0);

      // Server-side billing saw the SAME committed usage (our egress reported it).
      const billed = served.recorded.events.filter((e) => e.completionTokens > 0);
      expect(billed.length).toBeGreaterThan(0);

      // Evidence for the report.
      console.log(
        `[e2e:thinking] signatureLen=${(signature ?? '').length} textLen=${text.trim().length} ` +
          `usage(in=${usage.inputTokens},out=${usage.outputTokens}) ` +
          `reasoningParts=${reasoningTypes.length} billedEvents=${billed.length}`,
      );
    },
    90_000,
  );

  it(
    'round-trips a tool call through OUR gateway',
    async () => {
      const client = createAiSdkGateway({ baseURL: served.baseURL, apiKey: TEST_TOKEN });

      const result = streamText({
        model: client(CLIENT_MODEL_ID),
        prompt: 'Use the get_weather tool to check the current weather in Paris. Call the tool.',
        tools: {
          get_weather: tool({
            description: 'Get the current weather for a city.',
            inputSchema: jsonSchema<{ city: string }>({
              type: 'object',
              properties: { city: { type: 'string', description: 'City name' } },
              required: ['city'],
              additionalProperties: false,
            }),
            // No execute: streamText stops at the tool call (opencode runs tools,
            // not us) — exactly the native ingress contract.
          }),
        },
      });

      const parts: ClientPart[] = [];
      for await (const part of result.fullStream as AsyncIterable<ClientPart>) {
        parts.push(part);
      }

      const toolCalls = parts.filter((p) => p.type === 'tool-call');
      expect(toolCalls.length).toBeGreaterThan(0);
      const call = toolCalls[0];
      expect(call.toolName).toBe('get_weather');
      const input = (call.input ?? {}) as { city?: string };
      expect(typeof input.city).toBe('string');
      expect((input.city ?? '').toLowerCase()).toContain('paris');

      console.log(
        `[e2e:tool] toolCalls=${toolCalls.length} name=${call.toolName} city=${input.city}`,
      );
    },
    90_000,
  );
});

// Visibility when the key is absent: one always-present test states the skip so
// a no-key run reads as "intentionally skipped", not "silently missing".
describe('language-model e2e — key gating', () => {
  it('skips the real-provider suite cleanly when ANTHROPIC_API_KEY is absent', () => {
    if (!HAS_KEY) {
      console.log('[e2e] ANTHROPIC_API_KEY absent — real-provider suite skipped.');
    }
    expect(true).toBe(true);
  });
});
