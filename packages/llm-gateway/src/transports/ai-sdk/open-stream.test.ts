import { describe, expect, it } from 'bun:test';
import type { UpstreamDescriptor } from '../../domain';
import { UpstreamHttpError } from '../../errors';
import { callUpstreamViaAiSdk, openStream } from './index';

type Part = { type: string; [k: string]: unknown };

// An async iterable that yields `items`, then waits forever when `stall` is set.
function source(items: Part[], stall = false): AsyncIterable<Part> & { returned: boolean } {
  const state = { returned: false };
  return Object.assign(state, {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<Part>> => {
          if (index < items.length) return Promise.resolve({ done: false, value: items[index++]! });
          return stall ? new Promise(() => {}) : Promise.resolve({ done: true, value: undefined });
        },
        return: async (): Promise<IteratorResult<Part>> => {
          state.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  });
}

async function collect(iterable: AsyncIterable<Part>, count: number): Promise<string[]> {
  const iterator = iterable[Symbol.asyncIterator]();
  const types: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = await iterator.next();
    if (next.done) break;
    types.push(next.value.type);
  }
  return types;
}

describe('openStream: the pre-output signal of an AI SDK stream', () => {
  it('throws an error that arrives before any output and closes the provider stream', async () => {
    const stream = source([
      { type: 'start' },
      { type: 'error', error: { statusCode: 429, responseBody: 'limited', responseHeaders: { 'retry-after': '3' } } },
    ]);
    const opened = openStream(stream, 'anthropic', 1_000);
    await expect(opened).rejects.toBeInstanceOf(UpstreamHttpError);
    await expect(opened).rejects.toMatchObject({ status: 429, headers: { 'retry-after': '3' } });
    expect(stream.returned).toBe(true);
  });

  it('replays every part it read once output starts', async () => {
    const opened = await openStream(
      source([{ type: 'start' }, { type: 'start-step' }, { type: 'text-delta', text: 'hi' }, { type: 'finish' }]),
      'anthropic',
      1_000,
    );
    expect(await collect(opened, 10)).toEqual(['start', 'start-step', 'text-delta', 'finish']);
  });

  it('leaves an error after the first output in the stream', async () => {
    const opened = await openStream(
      source([{ type: 'start' }, { type: 'text-delta', text: 'hi' }, { type: 'error', error: new Error('late') }]),
      'anthropic',
      1_000,
    );
    expect(await collect(opened, 10)).toEqual(['start', 'text-delta', 'error']);
  });

  it('answers after the commit window when the provider has not produced output', async () => {
    const started = Date.now();
    const opened = await openStream(source([{ type: 'start' }], true), 'bedrock', 20);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await collect(opened, 1)).toEqual(['start']);
  });
});

describe('callUpstreamViaAiSdk streaming', () => {
  const anthropic: UpstreamDescriptor = {
    provider: 'anthropic',
    kind: 'anthropic',
    npm: '@ai-sdk/anthropic',
    baseUrl: 'https://anthropic.example/v1',
    apiKey: 'key',
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'claude-probe',
  };
  const body = { model: 'anthropic/claude-probe', stream: true, messages: [{ role: 'user', content: 'hi' }] };

  it('throws a provider HTTP error instead of answering 200 with an error frame', async () => {
    const call = callUpstreamViaAiSdk(body, anthropic, {
      fetch: async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(call).rejects.toMatchObject({ status: 529 });
  });

  it('answers with synthetic headers when the provider holds its headers past the commit window', async () => {
    const provider = new AbortController();
    const response = await callUpstreamViaAiSdk(body, anthropic, {
      commitAfterMs: 20,
      signal: provider.signal,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    provider.abort();
    await response.body?.cancel();
  });
});
