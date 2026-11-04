import { describe, expect, test } from 'bun:test';
import type { AdmitResult, GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import { GatewayResolutionError } from '../errors';
import type { FetchImpl } from '../http';
import { type AudioRequest, handleAudioRequest, handleVoicesRequest } from './audio';

const principal = { userId: 'user-1', accountId: 'account-1', projectId: 'project-1', sessionId: 'session-1' };
const managed: UpstreamDescriptor = {
  provider: 'platinum',
  kind: 'openai-compat',
  baseUrl: 'https://inference.example.test/v1/',
  apiKey: 'managed-key',
  billingMode: 'credits',
  markup: 1.5,
  resolvedModel: 'stt-1',
  publicProvider: 'kortix',
  headers: { 'x-platinum-session': 'session-1' },
};
const byok: UpstreamDescriptor = {
  provider: 'openai',
  kind: 'openai-compat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-own',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'whisper-1',
};
const silent = { info() {}, warn() {}, error() {} };

interface Call { url: string; init: RequestInit }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function setup(over: Partial<GatewayHooks> = {}, upstream: FetchImpl = async () => json({})) {
  const calls: Call[] = [];
  const traces: GatewayTrace[] = [];
  const usage: UsageEvent[] = [];
  const hooks: GatewayHooks = {
    authenticate: async () => principal,
    authorize: async () => ({ ok: true, principal }),
    resolveUpstream: async (_p, model) => [{ ...managed, resolvedModel: model }],
    assertBillingActive: async () => ({ holdUsd: 0.05 }),
    recordUsage: async (event) => { usage.push(event); },
    recordTrace: async (trace) => { traces.push(trace); },
    ...over,
  };
  const runtime = {
    hooks,
    logger: silent,
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return upstream(url, init);
    },
  };
  const audio = (operation: AudioRequest['operation'], body: Uint8Array<ArrayBuffer>, contentType: string, extra: Partial<AudioRequest> = {}) =>
    handleAudioRequest(runtime, { authorization: 'Bearer session-token', operation, body, contentType, ...extra });
  const speech = (body: unknown, extra: Partial<AudioRequest> = {}) =>
    audio('speech', new TextEncoder().encode(JSON.stringify(body)), 'application/json', extra);
  const transcribe = async (fields: Record<string, string | File>, extra: Partial<AudioRequest> = {}) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    const request = new Request('http://client.test', { method: 'POST', body: form });
    // Bun derives the multipart content type from the body: read it before the bytes.
    const contentType = request.headers.get('content-type')!;
    return audio('transcriptions', new Uint8Array(await request.arrayBuffer()), contentType, extra);
  };
  const voices = (model: string, authorization: string | undefined = 'Bearer session-token') =>
    handleVoicesRequest(runtime, { authorization, model });
  return { calls, traces, usage, speech, transcribe, voices, audio };
}

const clip = () => new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], 'turn.wav', { type: 'audio/wav' });
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);
const billed = (events: UsageEvent[]) => events.filter((event) => event.finalCost > 0);
/** A hold refund is the zero-cost event that carries only the hold. */
const refunds = (events: UsageEvent[]) => events.filter((event) => event.finalCost === 0 && event.billingHoldUsd !== undefined);
type ErrorBody = { code: string; message: string; provider: string };

describe('POST /audio/transcriptions', () => {
  test('forwards the upload to the managed upstream and bills its usage.cost with the markup', async () => {
    const { calls, usage, traces, transcribe } = setup({}, async () =>
      json({ text: 'hello there', usage: { type: 'duration', seconds: 10, cost: 0.000111 } }));
    const response = await transcribe({
      model: 'whisper-large-v3-turbo', file: clip(), language: 'en', prompt: 'Kortix', temperature: '0', timestamp_granularities: 'word',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    // The client gets the billed duration, never the upstream's price.
    expect(await response.json()).toEqual({ text: 'hello there', usage: { type: 'duration', seconds: 10 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://inference.example.test/v1/audio/transcriptions');
    expect(header(calls[0]!, 'authorization')).toBe('Bearer managed-key');
    expect(header(calls[0]!, 'x-platinum-session')).toBe('session-1');
    const sent = calls[0]!.init.body as FormData;
    expect([...sent.keys()].sort()).toEqual(['file', 'language', 'model', 'prompt', 'response_format', 'temperature']);
    expect(sent.get('model')).toBe('whisper-large-v3-turbo');
    expect(sent.get('response_format')).toBe('json');
    expect((sent.get('file') as File).name).toBe('turn.wav');
    expect(new Uint8Array(await (sent.get('file') as File).arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb, 0x90, 0x00]));

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      accountId: 'account-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      provider: 'kortix',
      model: 'whisper-large-v3-turbo',
      upstream: { provider: 'platinum', model: 'whisper-large-v3-turbo' },
      upstreamCost: 0.000111,
      billingMode: 'credits',
      streaming: false,
      operation: 'audio.transcriptions',
      billingHoldUsd: 0.05,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(usage[0]!.finalCost).toBeCloseTo(0.0001665, 12);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ ok: true, status: 200, provider: 'kortix', metadata: { operation: 'audio.transcriptions' } });
  });

  test('a text answer asks the upstream for json, bills it, and returns the text alone', async () => {
    const { calls, usage, transcribe } = setup({}, async () => json({ text: 'plain words', usage: { type: 'duration', seconds: 12, cost: 0.0004 } }));
    const response = await transcribe({ model: 'whisper-large-v3', file: clip(), response_format: 'text' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('plain words');
    expect((calls[0]!.init.body as FormData).get('response_format')).toBe('json');
    expect(billed(usage).map((event) => event.upstreamCost)).toEqual([0.0004]);
  });

  test('verbose_json keeps the segments and replaces the usage', async () => {
    const segments = [{ id: 0, start: 0, end: 1.2, text: ' hi' }];
    const { transcribe } = setup({}, async () =>
      json({ task: 'transcribe', language: 'english', duration: 1.2, text: ' hi', segments, usage: { type: 'duration', seconds: 10, cost: 0.0001 } }));
    const response = await transcribe({ model: 'whisper-large-v3', file: clip(), response_format: 'verbose_json' });
    expect(await response.json()).toEqual({
      task: 'transcribe', language: 'english', duration: 1.2, text: ' hi', segments, usage: { type: 'duration', seconds: 10 },
    });
  });

  test('an answer without a price is not delivered, and the hold is returned', async () => {
    const { usage, traces, transcribe } = setup({}, async () => json({ text: 'free?' }));
    const response = await transcribe({ model: 'whisper-large-v3', file: clip() });
    expect(response.status).toBe(502);
    expect(((await response.json()) as ErrorBody).code).toBe('audio_model_unpriced');
    expect(billed(usage)).toHaveLength(0);
    expect(refunds(usage).map((event) => event.billingHoldUsd)).toEqual([0.05]);
    expect(traces[0]).toMatchObject({ ok: false, errorCode: 'audio_model_unpriced' });
  });

  test('a body without `file` or with an unknown format is 400 before any upstream call or hold', async () => {
    let held = 0;
    const { calls, transcribe, audio } = setup({ assertBillingActive: async () => { held += 1; return { holdUsd: 0.05 }; } });
    for (const response of [
      await transcribe({ model: 'whisper-large-v3' }),
      await transcribe({ model: 'whisper-large-v3', file: clip(), response_format: 'srt' }),
      await audio('transcriptions', new TextEncoder().encode('{"model":"whisper-large-v3"}'), 'application/json'),
    ]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
    expect(held).toBe(0);
  });

  test("the upstream's refusal reaches the client without its text, and the hold is returned", async () => {
    const { usage, transcribe } = setup({}, async () =>
      json({ error: { message: 'The model whisper-large-v3 does not exist (upstream detail)', code: 'model_not_found' } }, 404));
    const response = await transcribe({ model: 'whisper-large-v3', file: clip() });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe('model_not_found');
    expect(body.message).toBe('Kortix does not serve whisper-large-v3 for transcription.');
    expect(JSON.stringify(body)).not.toContain('upstream detail');
    expect(refunds(usage)).toHaveLength(1);
  });
});

describe('POST /audio/speech', () => {
  /** An upstream stream the test feeds chunk by chunk. */
  function liveStream() {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    return { body, feed: () => feed };
  }

  test('relays each audio chunk as it arrives and bills x-platinum-cost with the markup', async () => {
    const stream = liveStream();
    const { calls, usage, traces, speech } = setup({}, async () => new Response(stream.body, {
      headers: { 'content-type': 'audio/pcm', 'x-platinum-cost': '0.00015', 'x-sample-rate': '16000', 'x-upstream-id': 'internal' },
    }));
    stream.feed().enqueue(new Uint8Array([1, 2]));
    const response = await speech({ model: 'tts-fast', input: 'Hello there.', voice: 'Ashley', sample_rate: 16_000, extra: 'dropped' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/pcm');
    expect(response.headers.get('x-sample-rate')).toBe('16000');
    expect(response.headers.get('x-platinum-cost')).toBeNull();
    expect(response.headers.get('x-upstream-id')).toBeNull();
    expect(calls[0]!.url).toBe('https://inference.example.test/v1/audio/speech');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: 'tts-fast', input: 'Hello there.', voice: 'Ashley', sample_rate: 16_000 });

    // The first chunk reaches the client while the upstream is still speaking.
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    stream.feed().enqueue(new Uint8Array([3]));
    expect((await reader.read()).value).toEqual(new Uint8Array([3]));
    stream.feed().close();
    expect((await reader.read()).done).toBe(true);

    expect(billed(usage)).toHaveLength(1);
    expect(usage[0]).toMatchObject({ upstreamCost: 0.00015, operation: 'audio.speech', streaming: true, provider: 'kortix', model: 'tts-fast', billingHoldUsd: 0.05 });
    expect(usage[0]!.finalCost).toBeCloseTo(0.000225, 12);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ ok: true, status: 200, streaming: true, metadata: { operation: 'audio.speech' } });
  });

  test('an upstream that fails before any audio is a typed error, not an empty 200', async () => {
    const { usage, speech } = setup({}, async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new Error('speech failed')); },
    }), { headers: { 'content-type': 'audio/pcm', 'x-platinum-cost': '0.0001' } }));
    const response = await speech({ model: 'tts-fast', input: 'Hi.', voice: 'Ashley' });
    expect(response.status).toBe(502);
    expect(((await response.json()) as ErrorBody).code).toBe('audio_upstream_error');
    expect(billed(usage)).toHaveLength(0);
    expect(refunds(usage)).toHaveLength(1);
  });

  test('a stream without x-platinum-cost is not delivered', async () => {
    const { usage, speech } = setup({}, async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/pcm' } }));
    const response = await speech({ model: 'tts-fast', input: 'Hi.', voice: 'Ashley' });
    expect(response.status).toBe(502);
    expect(((await response.json()) as ErrorBody).code).toBe('audio_model_unpriced');
    expect(billed(usage)).toHaveLength(0);
  });

  test('a client that hangs up mid-stream is still billed: the upstream already billed the audio', async () => {
    const stream = liveStream();
    const { usage, traces, speech } = setup({}, async () => new Response(stream.body, { headers: { 'content-type': 'audio/pcm', 'x-platinum-cost': '0.0002' } }));
    stream.feed().enqueue(new Uint8Array([9]));
    const response = await speech({ model: 'tts-fast', input: 'A long answer.', voice: 'Ashley' });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(billed(usage).map((event) => event.upstreamCost)).toEqual([0.0002]);
    expect(traces[0]).toMatchObject({ ok: false, status: 499, errorCode: 'client_aborted' });
  });

  test('field errors name the field, before any upstream call', async () => {
    const { calls, speech } = setup();
    const cases: [unknown, string][] = [
      [{ model: 'tts-fast', voice: 'Ashley' }, '`input` is required.'],
      [{ model: 'tts-fast', input: 'Hi.' }, '`voice` is required.'],
      [{ model: 'tts-fast', input: 'Hi.', voice: 'Ashley', response_format: 'wav' }, '`response_format` must be pcm or mp3.'],
      [{ model: 'tts-fast', input: 'Hi.', voice: 'Ashley', sample_rate: 44_100.5 }, '`sample_rate` must be an integer from 8000 to 48000.'],
      [{ model: 'tts-fast', input: 'Hi.', voice: 'Ashley', speed: 2 }, '`speed` must be from 0.5 to 1.5.'],
      [{ input: 'Hi.', voice: 'Ashley' }, '`model` is required.'],
    ];
    for (const [body, message] of cases) {
      const response = await speech(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).message).toBe(message);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('admission', () => {
  test('one admit call carries the principal, the upstream and the hold', async () => {
    const separate: string[] = [];
    const admitted: AdmitResult = {
      admission: { ok: true, principal },
      route: null,
      upstream: [{ ...managed, resolvedModel: 'tts-fast' }],
      billing: { holdUsd: 0.07 },
    };
    const { usage, speech } = setup({
      admit: async (_token, input) => {
        expect(input).toEqual({ requestedModel: 'tts-fast', requires: { imageInput: false } });
        return admitted;
      },
      authorize: async () => { separate.push('authorize'); return { ok: true, principal }; },
      resolveUpstream: async () => { separate.push('resolve'); return [managed]; },
      assertBillingActive: async () => { separate.push('billing'); return { holdUsd: 1 }; },
    }, async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/pcm', 'x-platinum-cost': '0.0001' } }));
    const response = await speech({ model: 'tts-fast', input: 'Hi.', voice: 'Ashley' });
    await response.arrayBuffer();
    expect(separate).toEqual([]);
    expect(billed(usage)[0]?.billingHoldUsd).toBe(0.07);
  });

  test('no bearer token is 401 before any hook runs', async () => {
    const { calls, audio } = setup({ authorize: async () => { throw new Error('must not run'); } });
    const response = await audio('speech', new TextEncoder().encode('{}'), 'application/json', { authorization: undefined });
    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorBody).code).toBe('missing_token');
    expect(calls).toHaveLength(0);
  });

  test('a refused token is answered with the refusal and never reaches the upstream', async () => {
    const { calls, traces, speech } = setup({ authorize: async () => ({ ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' }) });
    const response = await speech({ model: 'tts-fast', input: 'Hi.', voice: 'Ashley' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorBody).code).toBe('invalid_token');
    expect(calls).toHaveLength(0);
    expect(traces).toHaveLength(0);
  });

  test("a model on the caller's own key is not served: only the managed upstream reports a price", async () => {
    let held = 0;
    const { calls, speech } = setup({
      resolveUpstream: async () => [byok],
      assertBillingActive: async () => { held += 1; return {}; },
    });
    const response = await speech({ model: 'openai/tts-1', input: 'Hi.', voice: 'alloy' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).code).toBe('audio_model_unsupported');
    expect(calls).toHaveLength(0);
    expect(held).toBe(0);
  });

  test('a resolution refusal (a Free plan) is its own 400', async () => {
    const { calls, speech } = setup({
      resolveUpstream: async () => { throw new GatewayResolutionError('plan_upgrade_required', '"tts-fast" requires a paid plan.', 'Upgrade.'); },
    });
    const response = await speech({ model: 'tts-fast', input: 'Hi.', voice: 'Ashley' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).code).toBe('plan_upgrade_required');
    expect(calls).toHaveLength(0);
  });

  test('an inactive wallet is 402 before the upstream call', async () => {
    const { calls, speech } = setup({
      assertBillingActive: async () => { throw Object.assign(new Error('Insufficient credits'), { reason: 'insufficient_credits' }); },
    });
    const response = await speech({ model: 'tts-fast', input: 'Hi.', voice: 'Ashley' });
    expect(response.status).toBe(402);
    expect(((await response.json()) as ErrorBody).code).toBe('insufficient_credits');
    expect(calls).toHaveLength(0);
  });
});

describe('GET /audio/voices', () => {
  test('lists the documented fields of each voice from the managed upstream', async () => {
    const { calls, usage, voices } = setup({}, async () => json({
      object: 'list',
      data: [
        { id: 'Ashley', name: 'Ashley', description: 'Warm', languages: ['en'], tags: ['female'], internal: 'x' },
        { id: 'Dev', languages: 'en' },
        { name: 'no id' },
      ],
    }));
    const response = await voices('tts-fast');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        { id: 'Ashley', name: 'Ashley', description: 'Warm', languages: ['en'], tags: ['female'] },
        { id: 'Dev', name: 'Dev', description: '', languages: [], tags: [] },
      ],
    });
    expect(calls[0]!.url).toBe('https://inference.example.test/v1/audio/voices');
    expect(calls[0]!.init.method).toBe('GET');
    expect(header(calls[0]!, 'authorization')).toBe('Bearer managed-key');
    expect(usage).toHaveLength(0);
  });

  test('refuses a missing token, an unknown token and a missing model before the upstream', async () => {
    const { calls, voices } = setup({ authenticate: async (token) => (token === 'good' ? principal : null) });
    expect((await voices('tts-fast', undefined)).status).toBe(401);
    expect((await voices('tts-fast', 'Bearer bad')).status).toBe(401);
    const missing = await voices('', 'Bearer good');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ErrorBody).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});
