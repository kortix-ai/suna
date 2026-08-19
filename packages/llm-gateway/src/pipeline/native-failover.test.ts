import { describe, expect, it } from 'bun:test';
import { UpstreamHttpError } from '../errors';
import { aiGatewaySseFromFullStream } from '../transports/ai-sdk';
import type { FullStreamPart } from '../transports/ai-sdk';
import { toTransportError } from '../transports/ai-sdk';
import { runNativeFailover } from './native-failover';

// A candidate is anything with a provider label + a resolvedModel — the core is
// generic; the handler passes `{ descriptor, routeModel }`. Here a tiny shape.
interface Cand {
  provider: string;
  model: string;
}

const silentLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
};

// Build a fresh async-iterable fullStream from a list of parts. `onReturn` fires
// when the consumer cancels the iterator (the core's failover/retry cancel path)
// — used to assert a skipped candidate's stream is actually torn down.
function partsStream(
  parts: FullStreamPart[],
  onReturn?: () => void,
): AsyncIterable<FullStreamPart> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<FullStreamPart> {
      let i = 0;
      return {
        async next() {
          if (i >= parts.length) return { done: true, value: undefined };
          return { done: false, value: parts[i++] };
        },
        async return() {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// A stream that yields `head`, then withholds `tail` until `delayMs` — used to
// drive the commit-deadline (slow-but-live) path deterministically.
function slowStream(
  head: FullStreamPart[],
  tail: FullStreamPart[],
  delayMs: number,
): AsyncIterable<FullStreamPart> {
  const seq = [...head];
  let released = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<FullStreamPart> {
      let i = 0;
      return {
        async next() {
          if (i < seq.length) return { done: false, value: seq[i++] };
          if (!released) {
            released = true;
            await new Promise((r) => setTimeout(r, delayMs));
            for (const t of tail) seq.push(t);
            if (i < seq.length) return { done: false, value: seq[i++] };
          }
          if (i < seq.length) return { done: false, value: seq[i++] };
          return { done: true, value: undefined };
        },
      };
    },
  };
}

const baseDeps = {
  providerOf: (c: Cand) => c.provider,
  toTransportError,
  maxInvalidAttempts: 3,
  logger: silentLogger,
  requestId: 'req_test',
};

async function drain(stream: AsyncIterable<FullStreamPart>): Promise<FullStreamPart[]> {
  const out: FullStreamPart[] = [];
  for await (const p of stream) out.push(p);
  return out;
}

describe('runNativeFailover — candidate loop + probe-commit', () => {
  it('commits the first candidate that streams content', async () => {
    const A: Cand = { provider: 'pa', model: 'ma' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      candidates: [A],
      startStream: () =>
        partsStream([
          { type: 'start' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', text: 'Hello' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 2 } },
        ]),
    });
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    expect(result.candidate).toBe(A);
    expect(result.slowCommit).toBe(false);
    const relayed = await drain(result.stream);
    // The buffered probe parts (start, text-start, text-delta) plus the rest
    // (finish) are all replayed — nothing lost at the commit seam.
    expect(relayed.map((p) => p.type)).toEqual(['start', 'text-start', 'text-delta', 'finish']);
    expect(relayed.find((p) => p.type === 'text-delta')?.text).toBe('Hello');
  });

  it('a 429 error part on the first candidate fails over to the second, which serves', async () => {
    let aCancelled = false;
    let bStarted = false;
    const A: Cand = { provider: 'pa', model: 'ma' };
    const B: Cand = { provider: 'pb', model: 'mb' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      candidates: [A, B],
      startStream: (c) => {
        if (c === A) {
          return partsStream(
            [
              { type: 'start' },
              {
                type: 'error',
                error: { statusCode: 429, responseBody: '{"error":{"message":"rate limited"}}' },
              },
            ],
            () => {
              aCancelled = true;
            },
          );
        }
        bStarted = true;
        return partsStream([
          { type: 'text-delta', id: 't', text: 'from B' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      },
    });
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    // The SECOND candidate is the one committed (== the one that will be billed).
    expect(result.candidate).toBe(B);
    expect(bStarted).toBe(true);
    // The failed-over candidate's stream was torn down.
    expect(aCancelled).toBe(true);
    const relayed = await drain(result.stream);
    expect(relayed.find((p) => p.type === 'text-delta')?.text).toBe('from B');
  });

  it('an empty completion retries the SAME candidate up to MAX, then fails over', async () => {
    let aAttempts = 0;
    let bAttempts = 0;
    const A: Cand = { provider: 'pa', model: 'ma' };
    const B: Cand = { provider: 'pb', model: 'mb' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      maxInvalidAttempts: 3,
      candidates: [A, B],
      startStream: (c) => {
        if (c === A) {
          aAttempts += 1;
          // start + finish, no content part — the empty-completion shape.
          return partsStream([
            { type: 'start' },
            {
              type: 'finish',
              finishReason: 'stop',
              totalUsage: { inputTokens: 1, outputTokens: 0 },
            },
          ]);
        }
        bAttempts += 1;
        return partsStream([
          { type: 'text-delta', id: 't', text: 'B content' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      },
    });
    // Candidate A was retried exactly MAX times before failover.
    expect(aAttempts).toBe(3);
    // Then B served on its first attempt.
    expect(bAttempts).toBe(1);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    expect(result.candidate).toBe(B);
  });

  it('all candidates empty → fails with reason "empty"', async () => {
    const A: Cand = { provider: 'pa', model: 'ma' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      maxInvalidAttempts: 2,
      candidates: [A],
      startStream: () =>
        partsStream([
          { type: 'start' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 0 } },
        ]),
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('empty');
  });

  it('a terminal 400 fails FAST — no failover even when a fallback exists', async () => {
    let bStarted = false;
    const A: Cand = { provider: 'pa', model: 'ma' };
    const B: Cand = { provider: 'pb', model: 'mb' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      candidates: [A, B],
      startStream: (c) => {
        if (c === A) {
          return partsStream([
            {
              type: 'error',
              error: {
                statusCode: 400,
                responseBody: '{"error":{"message":"bad request","code":"invalid"}}',
              },
            },
          ]);
        }
        bStarted = true;
        return partsStream([{ type: 'text-delta', id: 't', text: 'B' }]);
      },
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('error');
    expect(result.transportError).toBeInstanceOf(UpstreamHttpError);
    expect((result.transportError as UpstreamHttpError).status).toBe(400);
    // The fallback candidate was NEVER dispatched — fail fast means fail fast.
    expect(bStarted).toBe(false);
  });

  it('a mid-stream error AFTER content commits is relayed, NOT failed over', async () => {
    let bStarted = false;
    const A: Cand = { provider: 'pa', model: 'ma' };
    const B: Cand = { provider: 'pb', model: 'mb' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      candidates: [A, B],
      startStream: (c) => {
        if (c === A) {
          return partsStream([
            { type: 'text-delta', id: 't', text: 'partial' },
            // Upstream dies AFTER content already streamed.
            { type: 'error', error: { statusCode: 529, message: 'overloaded' } },
            {
              type: 'finish',
              finishReason: 'error',
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            },
          ]);
        }
        bStarted = true;
        return partsStream([{ type: 'text-delta', id: 't', text: 'B' }]);
      },
    });
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    // Committed to A even though a 529 followed — a post-commit error never
    // switches candidates.
    expect(result.candidate).toBe(A);
    expect(bStarted).toBe(false);
    // The error part rides through to the serialized output as an error frame.
    const sse = await new Response(
      aiGatewaySseFromFullStream(result.stream, {
        model: 'ma',
        provider: 'pa',
      }),
    ).text();
    const frames = sse
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((p) => p && p !== '[DONE]')
      .map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(frames.some((f) => f.type === 'text-delta' && f.delta === 'partial')).toBe(true);
    const errFrame = frames.find((f) => f.type === 'error') as Record<string, unknown> | undefined;
    expect(errFrame).toBeDefined();
    expect((errFrame?.error as Record<string, unknown>).code).toBe(529);
  });

  it('commits a slow-but-live candidate on the deadline instead of failing over', async () => {
    const A: Cand = { provider: 'pa', model: 'ma' };
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      commitDeadlineMs: 20,
      candidates: [A],
      startStream: () =>
        // Emits `start` immediately, then withholds the first content part for
        // 60ms — well past the 20ms commit deadline.
        slowStream(
          [{ type: 'start' }],
          [
            { type: 'text-delta', id: 't', text: 'late token' },
            {
              type: 'finish',
              finishReason: 'stop',
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            },
          ],
          60,
        ),
    });
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    expect(result.slowCommit).toBe(true);
    // The read that was in flight at the deadline is adopted — the late content
    // part is NOT dropped at the commit seam.
    const relayed = await drain(result.stream);
    expect(relayed.find((p) => p.type === 'text-delta')?.text).toBe('late token');
  });

  it('preserves the reasoning signature + usage through the committed path (regression)', async () => {
    const A: Cand = { provider: 'anthropic', model: 'claude-fable-5' };
    let billed:
      | {
          promptTokens: number;
          completionTokens: number;
          cachedTokens: number;
          cacheWriteTokens: number;
          totalTokens: number;
        }
      | undefined;
    const result = await runNativeFailover<Cand>({
      ...baseDeps,
      candidates: [A],
      startStream: () =>
        partsStream([
          { type: 'reasoning-start', id: 'r1' },
          {
            type: 'reasoning-delta',
            id: 'r1',
            text: 'thinking',
            providerMetadata: { anthropic: { signature: 'SIG-xyz' } },
          },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'text-delta', id: 't1', text: 'answer' },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: {
              inputTokens: 100,
              outputTokens: 50,
              inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 10 },
              outputTokenDetails: { reasoningTokens: 10 },
            },
          },
        ]),
    });
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    const sse = await new Response(
      aiGatewaySseFromFullStream(
        result.stream,
        { model: 'claude-fable-5', provider: 'anthropic' },
        {
          onUsage: (u) => {
            billed = u;
          },
        },
      ),
    ).text();
    const frames = sse
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((p) => p && p !== '[DONE]')
      .map((p) => JSON.parse(p) as Record<string, unknown>);
    const reasoning = frames.find((f) => f.type === 'reasoning-delta') as Record<string, unknown>;
    expect(reasoning.providerMetadata).toEqual({ anthropic: { signature: 'SIG-xyz' } });
    expect(billed).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 150,
    });
  });
});
