import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, UpstreamDescriptor } from '../domain';
import { handleChatCompletions } from './simple-handler';

/**
 * Memory envelope for one mounted multimodal request.
 *
 * Reproduces the shape that OOM-killed the Essentia gateway on 2026-08-22:
 * 40 base64 screenshots, ~28 MB on the wire. The assertion is on resident
 * memory measured INSIDE the provider fetch — the moment every live copy
 * (parsed graph, provider payload, encoded request bytes) coexists — relative
 * to the wire size. Pre-fix numbers on the same machine: openai-compat ≈ 4x,
 * anthropic ≈ 13x (atob().split('') decode) + provider-utils re-encode.
 *
 * The bound is generous on purpose (RSS is noisy: allocator slack, GC timing).
 * It exists to catch a regression back into the 10x+ class, not to pin the
 * exact factor. The measured factor is printed for the PR record.
 */

const IMAGE_COUNT = 40;
const IMAGE_BYTES = 520 * 1024; // ≈ 700 KB base64 each → ≈ 28 MB request
const MAX_FACTOR = 6;

function base64Image(seed: number): string {
  const bytes = new Uint8Array(IMAGE_BYTES);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + seed) & 255;
  return Buffer.from(bytes).toString('base64');
}

function mountedBody(model: string, stream: boolean): string {
  const images = Array.from({ length: IMAGE_COUNT }, (_, i) => base64Image(i));
  const messages: unknown[] = [{ role: 'system', content: 'You are a vision agent.' }];
  for (const [i, data] of images.entries()) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `screenshot ${i}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      ],
    });
    messages.push({ role: 'assistant', content: `noted ${i}` });
  }
  messages.push({ role: 'user', content: 'what changed?' });
  return JSON.stringify({ model, stream, messages });
}

const principal = { userId: 'user', accountId: 'account', projectId: 'project' };
const hooks: GatewayHooks = {
  authenticate: async () => principal,
  authorize: async () => ({ ok: true, principal }),
  resolveRoute: async () => ({
    policyId: 'route',
    primaryModel: 'primary-model',
    fallbackModels: [],
    fallbackOn: 'any-error',
  }),
  resolveUpstream: async () => [descriptorRef.current],
  assertBillingActive: async () => {},
  recordUsage: async () => {},
  recordTrace: async () => {},
};
const descriptorRef: { current: UpstreamDescriptor } = {
  current: {
    provider: 'p',
    kind: 'openai-compat',
    baseUrl: 'https://p.example/v1',
    apiKey: 'k',
    billingMode: 'credits',
    markup: 1,
  },
};

function rssMiB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

interface Probe {
  peakDeltaMiB: number;
  wireMiB: number;
  factor: number;
  upstreamBodyBytes: number;
  upstreamHadInlineImages: number;
}

async function probe(
  descriptor: UpstreamDescriptor,
  upstreamResponse: () => Response,
  imageMarker: RegExp,
): Promise<{ probe: Probe; response: Response }> {
  descriptorRef.current = descriptor;
  const rawBody = mountedBody('primary-model', false);
  const wireBytes = Buffer.byteLength(rawBody);
  Bun.gc(true);
  const baseline = rssMiB();
  let peak = baseline;
  let upstreamBodyBytes = 0;
  let upstreamHadInlineImages = 0;
  const response = await handleChatCompletions(
    {
      hooks,
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (_input, init) => {
        peak = Math.max(peak, rssMiB());
        const body = typeof init.body === 'string' ? init.body : '';
        upstreamBodyBytes = Buffer.byteLength(body);
        upstreamHadInlineImages = (body.match(imageMarker) ?? []).length;
        return upstreamResponse();
      },
      // Window wide open so the test measures the raw passthrough cost, not
      // the pruning (which has its own tests).
      imageWindow: { maxImages: 0, keepOnOverflow: 0 },
    },
    { authorization: 'Bearer t', rawBody },
  );
  peak = Math.max(peak, rssMiB());
  const wireMiB = wireBytes / (1024 * 1024);
  const peakDeltaMiB = peak - baseline;
  return {
    probe: {
      peakDeltaMiB,
      wireMiB,
      factor: peakDeltaMiB / wireMiB,
      upstreamBodyBytes,
      upstreamHadInlineImages,
    },
    response,
  };
}

describe('memory envelope: 40-screenshot / ~28 MB request', () => {
  test('openai-compat passthrough stays within the envelope and forwards every image byte', async () => {
    const { probe: p, response } = await probe(
      descriptorRef.current,
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      /data:image\/png;base64,/g,
    );
    console.log(
      `[memory-envelope] openai-compat wire=${p.wireMiB.toFixed(1)} MiB peakΔ=${p.peakDeltaMiB.toFixed(0)} MiB factor=${p.factor.toFixed(2)}x`,
    );
    expect(response.status).toBe(200);
    expect(p.upstreamHadInlineImages).toBe(IMAGE_COUNT);
    // Provider payload equals the wire body plus the model rewrite — no image
    // was re-encoded or dropped.
    expect(p.upstreamBodyBytes).toBeGreaterThan(p.wireMiB * 1024 * 1024 * 0.99);
    expect(p.factor).toBeLessThan(MAX_FACTOR);
  });

  test('anthropic (ai-sdk) route forwards base64 without decode/re-encode and stays within the envelope', async () => {
    const { probe: p, response } = await probe(
      {
        provider: 'anthropic',
        kind: 'anthropic',
        baseUrl: 'https://anthropic.example/v1',
        apiKey: 'k',
        billingMode: 'credits',
        markup: 1,
        resolvedModel: 'claude-sonnet-4-6',
      },
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      /"type":"base64"/g,
    );
    console.log(
      `[memory-envelope] anthropic wire=${p.wireMiB.toFixed(1)} MiB peakΔ=${p.peakDeltaMiB.toFixed(0)} MiB factor=${p.factor.toFixed(2)}x`,
    );
    expect(response.status).toBe(200);
    expect(p.upstreamHadInlineImages).toBe(IMAGE_COUNT);
    expect(p.upstreamBodyBytes).toBeGreaterThan(p.wireMiB * 1024 * 1024 * 0.95);
    expect(p.factor).toBeLessThan(MAX_FACTOR);
  });

  test('streaming: once the relay is handed back, resident memory drops to the stream-only floor', async () => {
    descriptorRef.current = {
      provider: 'p',
      kind: 'openai-compat',
      baseUrl: 'https://p.example/v1',
      apiKey: 'k',
      billingMode: 'credits',
      markup: 1,
    };
    const rawBody = mountedBody('primary-model', true);
    const wireMiB = Buffer.byteLength(rawBody) / (1024 * 1024);
    Bun.gc(true);
    const baseline = rssMiB();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await handleChatCompletions(
      {
        hooks,
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
                );
                await gate;
                controller.enqueue(
                  enc.encode(
                    'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        imageWindow: { maxImages: 0, keepOnOverflow: 0 },
      },
      { authorization: 'Bearer t', rawBody },
    );
    expect(response.status).toBe(200);
    // The handler has returned; the parsed graph and the serialized payload
    // are unreachable. Only the relay + the (already-sent) fetch body remain.
    Bun.gc(true);
    const steady = rssMiB() - baseline;
    console.log(
      `[memory-envelope] streaming steady-state after handoff: ${steady.toFixed(0)} MiB over baseline for a ${wireMiB.toFixed(1)} MiB request (${(steady / wireMiB).toFixed(2)}x)`,
    );
    expect(steady / wireMiB).toBeLessThan(2);
    release!();
    const text = await response.text();
    expect(text).toContain('[DONE]');
  });
});
