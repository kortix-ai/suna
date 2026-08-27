/**
 * The client half of `GET /projects/:pid/sessions/:sid/stream`.
 *
 * This module is deliberately LOW-LEVEL: a URL builder, a cursor codec, and a
 * frame reader. The session controller that consumes it is a separate change,
 * and building the controller first would have meant guessing at the wire
 * instead of reading it.
 *
 * The properties under test are the ones a controller must be able to rely on:
 *   1. the two cursors are carried and restored SEPARATELY — a control `cseq`
 *      must never be sent where a runtime `seq` belongs;
 *   2. a frame is classified by its channel, not by its event name, so a future
 *      OpenCode event type needs no change here;
 *   3. frames arrive incrementally — the reader must never wait for a stream
 *      that by construction never ends.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  formatSessionStreamCursor,
  parseSessionStreamCursor,
  readSessionStream,
  sessionStreamPath,
} from './session-stream';

const PROJECT = 'proj-1';
const SESSION = 'sess-1';

describe('sessionStreamPath', () => {
  test('with no cursor it asks for a fresh stream', () => {
    expect(sessionStreamPath(PROJECT, SESSION)).toBe(
      `/projects/${PROJECT}/sessions/${SESSION}/events`,
    );
  });

  test('both cursors are carried in their OWN parameters', () => {
    const path = sessionStreamPath(PROJECT, SESSION, {
      epoch: 'bmtaokkdb0piayh',
      seq: 2016,
      cepoch: 'capi_abc',
      cseq: 41,
    });
    const query = new URLSearchParams(path.split('?')[1]);
    expect(query.get('since')).toBe('2016');
    expect(query.get('epoch')).toBe('bmtaokkdb0piayh');
    expect(query.get('since_control')).toBe('41');
    expect(query.get('cepoch')).toBe('capi_abc');
  });

  test('a seq without its epoch is NOT sent — a cursor from an unknown epoch is meaningless', () => {
    const path = sessionStreamPath(PROJECT, SESSION, { seq: 2016, epoch: null });
    expect(path).not.toContain('since=');
  });

  test('a cseq without its cepoch is NOT sent, for the same reason', () => {
    const path = sessionStreamPath(PROJECT, SESSION, { cseq: 41, cepoch: null });
    expect(path).not.toContain('since_control=');
  });

  test('seq 0 is a real position and survives the falsy trap', () => {
    const path = sessionStreamPath(PROJECT, SESSION, { seq: 0, epoch: 'ep' });
    expect(new URLSearchParams(path.split('?')[1]).get('since')).toBe('0');
  });
});

describe('the composite cursor codec', () => {
  test('round-trips both channels', () => {
    const cursor = { epoch: 'ep_1', seq: 7, cepoch: 'capi_1', cseq: 3 };
    expect(parseSessionStreamCursor(formatSessionStreamCursor(cursor))).toEqual(cursor);
  });

  test('a half-populated cursor keeps its blanks distinguishable from zero', () => {
    const encoded = formatSessionStreamCursor({ epoch: null, seq: null, cepoch: 'c', cseq: 0 });
    expect(encoded).toBe('||c|0');
    expect(parseSessionStreamCursor(encoded)).toEqual({
      epoch: null,
      seq: null,
      cepoch: 'c',
      cseq: 0,
    });
  });

  test('garbage decodes to "no position", never to a wrong one', () => {
    const empty = { epoch: null, seq: null, cepoch: null, cseq: null };
    expect(parseSessionStreamCursor('nonsense')).toEqual(empty);
    expect(parseSessionStreamCursor('a|b|c')).toEqual(empty);
    expect(parseSessionStreamCursor(null)).toEqual(empty);
    expect(parseSessionStreamCursor('ep|not-a-number|c|1')).toEqual({
      epoch: 'ep',
      seq: null,
      cepoch: 'c',
      cseq: 1,
    });
  });
});

describe('readSessionStream', () => {
  const originalFetch = globalThis.fetch;
  let requested: Array<{ url: string; accept: string | null; cacheControl?: string | null }> = [];

  function serve(chunks: string[], keepOpen = false): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push({
        url: input instanceof Request ? input.url : String(input),
        accept: new Headers(init?.headers ?? {}).get('accept'),
        cacheControl: new Headers(init?.headers ?? {}).get('cache-control'),
      });
      const encoder = new TextEncoder();
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(encoder.encode(chunks[index]!));
            index += 1;
            return;
          }
          if (!keepOpen) controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
  }

  beforeEach(() => {
    requested = [];
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'kortix_pat_test' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('asks the right URL with an SSE Accept header', async () => {
    serve(['event: kortix.stream.hello\ndata: {"type":"kortix.stream.hello"}\n\n']);
    for await (const _frame of readSessionStream(PROJECT, SESSION)) break;
    expect(requested[0]!.url).toBe(`http://api.test/v1/projects/${PROJECT}/sessions/${SESSION}/events`);
    expect(requested[0]!.accept).toBe('text/event-stream');
    // No `Cache-Control` REQUEST header: it is not CORS-safelisted, so sending it
    // makes the browser preflight fail cross-origin and the stream never opens
    // (dev, 2026-08-27). The only header on this GET is `Accept`.
    expect(requested[0]!.cacheControl).toBeNull();
  });

  test('classifies frames by CHANNEL, not by event name', async () => {
    serve([
      'event: kortix.stream.hello\ndata: {"type":"kortix.stream.hello","channel":"stream"}\n\n',
      'event: some.future.opencode.event\nid: ep|9|capi|2\ndata: {"channel":"runtime","seq":9,"epoch":"ep","type":"some.future.opencode.event","at":1,"payload":{"a":1}}\n\n',
      'event: kortix.control.queue\nid: ep|9|capi|2\ndata: {"channel":"control","cseq":2,"cepoch":"capi","type":"kortix.control.queue","at":1,"payload":{"prompts":[]}}\n\n',
    ]);
    const frames = [];
    for await (const frame of readSessionStream(PROJECT, SESSION)) frames.push(frame);

    expect(frames.map((frame) => frame.channel)).toEqual(['stream', 'runtime', 'control']);
    // An event type this SDK has never heard of still routes correctly.
    expect(frames[1]).toMatchObject({ channel: 'runtime', seq: 9, epoch: 'ep' });
    expect(frames[2]).toMatchObject({ channel: 'control', cseq: 2, cepoch: 'capi' });
  });

  test('tracks the cursor as it reads, so a reconnect resumes from what was APPLIED', async () => {
    serve([
      'event: a\nid: ep|5|capi|1\ndata: {"channel":"runtime","seq":5,"epoch":"ep","type":"a","at":1,"payload":{}}\n\n',
      'event: kortix.control.turn\nid: ep|5|capi|4\ndata: {"channel":"control","cseq":4,"cepoch":"capi","type":"kortix.control.turn","at":1,"payload":{}}\n\n',
    ]);
    const cursor = { epoch: null as string | null, seq: null as number | null, cepoch: null as string | null, cseq: null as number | null };
    for await (const frame of readSessionStream(PROJECT, SESSION, {
      onCursor: (next) => Object.assign(cursor, next),
    })) {
      void frame;
    }
    expect(cursor).toEqual({ epoch: 'ep', seq: 5, cepoch: 'capi', cseq: 4 });
  });

  test('a frame is yielded BEFORE the stream ends', async () => {
    serve(['event: first\ndata: {"channel":"stream","type":"first"}\n\n'], true);
    const controller = new AbortController();
    const iterator = readSessionStream(PROJECT, SESSION, { signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'first' });
    controller.abort();
    await iterator.return?.(undefined);
  });

  test('a non-200 raises rather than yielding an empty stream that looks healthy', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(async () => {
      for await (const _frame of readSessionStream(PROJECT, SESSION)) break;
    }).toThrow();
  });
});
