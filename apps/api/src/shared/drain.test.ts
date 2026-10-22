import { beforeEach, describe, expect, test } from 'bun:test';
import {
  beginWork,
  drainRequests,
  finishRequest,
  inflightCount,
  resetDrainForTests,
  trackDetached,
} from './drain';

beforeEach(resetDrainForTests);

function sse(path: string): { response: Response | undefined; end: () => void; push: (s: string) => void; finished: () => boolean } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const end = beginWork();
  const response = finishRequest(
    path,
    new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }),
    end,
  );
  return {
    response,
    end,
    push: (s) => controller.enqueue(new TextEncoder().encode(s)),
    finished: () => cancelled,
  };
}

describe('drain', () => {
  test('a buffered response ends its work unit at once', () => {
    const end = beginWork();
    expect(inflightCount()).toBe(1);
    const res = finishRequest('/v1/x', new Response('ok'), end);
    expect(inflightCount()).toBe(0);
    expect(res).toBeInstanceOf(Response);
  });

  test('a streamed response counts until its body ends', async () => {
    const s = sse('/v1/llm/chat');
    s.push('data: a\n\n');
    const reader = s.response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: a\n\n');
    expect(inflightCount()).toBe(1);
    await reader.cancel();
    expect(inflightCount()).toBe(0);
  });

  test('drain waits for a detached promise, then reports 0 remaining', async () => {
    let release!: () => void;
    trackDetached(new Promise<void>((resolve) => (release = resolve)));
    const drained = drainRequests({ propagationMs: 0, budgetMs: 2_000 });
    setTimeout(release, 30);
    expect(await drained).toEqual({ remaining: 0 });
  });

  test('drain gives up at the budget and reports what is left', async () => {
    trackDetached(new Promise(() => {}));
    expect(await drainRequests({ propagationMs: 0, budgetMs: 40 })).toEqual({ remaining: 1 });
  });

  test('a session event stream ends with a reconnect hint at drain', async () => {
    const s = sse('/v1/projects/p/sessions/s1/events');
    const reader = s.response!.body!.getReader();
    const drained = drainRequests({ propagationMs: 0, budgetMs: 2_000 });
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join('')).toBe('retry: 1000\n\n');
    expect(await drained).toEqual({ remaining: 0 });
    expect(s.finished()).toBe(true);
  });

  test('a stream opened after drain began is ended at once', async () => {
    await drainRequests({ propagationMs: 0, budgetMs: 10 });
    const s = sse('/v1/projects/p/sessions/s1/events');
    const { value, done } = await s.response!.body!.getReader().read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe('retry: 1000\n\n');
    expect(inflightCount()).toBe(0);
  });

  test('an LLM stream is waited on, not cut', async () => {
    const s = sse('/v1/llm/chat');
    const drained = drainRequests({ propagationMs: 0, budgetMs: 60 });
    expect(await drained).toEqual({ remaining: 1 });
    expect(s.finished()).toBe(false);
  });
});
