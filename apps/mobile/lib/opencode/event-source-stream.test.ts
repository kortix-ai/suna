import { describe, expect, test } from 'bun:test';
import {
  openEventSourceStream,
  type EventSourceLike,
  type EventSourceListener,
} from './event-source-stream';

// ─────────────────────────────────────────────────────────────────────────────
// This bridge is the ONLY mobile-specific part of live streaming that survives.
//
// React Native's `fetch` has no `response.body`, so `@opencode-ai/sdk`'s
// `client.global.event()` — which reads `response.body.pipeThrough(new
// TextDecoderStream())` — can never resolve here. The SDK's
// `EventStreamTransport` seam exists so a host can supply the bytes and nothing
// else: reconnect, backoff, heartbeat and coalescing all stay in
// `openEventStream`.
//
// So these tests pin exactly two things — that events arrive, and that failures
// are reported in the shape the SDK's own classifier reads. Anything resembling
// a retry loop appearing in this file means the seam is being re-forked.
// ─────────────────────────────────────────────────────────────────────────────

/** A scriptable stand-in for `react-native-sse`'s EventSource. */
class FakeEventSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  private listeners: Record<string, EventSourceListener[]> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

function setup() {
  const created: FakeEventSource[] = [];
  const controller = new AbortController();
  const stream = openEventSourceStream({
    url: 'https://api.example.test/p/box-1/8000',
    signal: controller.signal,
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      created.push(es);
      return es;
    },
  });
  return { created, controller, stream };
}

describe('openEventSourceStream', () => {
  test('connects to the runtime’s /global/event endpoint', async () => {
    const { created } = setup();
    expect(created).toHaveLength(1);
    expect(created[0]!.url).toBe('https://api.example.test/p/box-1/8000/global/event');
  });

  test('yields each message parsed, leaving the GlobalEvent envelope intact', async () => {
    const { created, stream } = setup();
    const source = created[0]!;
    const iterator = stream[Symbol.asyncIterator]();

    const pending = iterator.next();
    // The wire shape is GlobalEvent: { directory, payload: { type, properties } }.
    // The SDK's openEventStream unwraps `payload` itself, so the transport must
    // hand it over verbatim rather than unwrapping a second time.
    source.emit('message', {
      data: JSON.stringify({
        directory: '/workspace',
        payload: { type: 'message.part.updated', properties: { part: { id: 'prt_1' } } },
      }),
    });

    const result = await pending;
    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      directory: '/workspace',
      payload: { type: 'message.part.updated', properties: { part: { id: 'prt_1' } } },
    });
  });

  test('buffers events that arrive before the consumer asks for them', async () => {
    const { created, stream } = setup();
    const source = created[0]!;
    source.emit('message', { data: JSON.stringify({ payload: { type: 'a' } }) });
    source.emit('message', { data: JSON.stringify({ payload: { type: 'b' } }) });

    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ payload: { type: 'a' } });
    expect((await iterator.next()).value).toEqual({ payload: { type: 'b' } });
  });

  test('skips keepalives and malformed frames instead of ending the stream', async () => {
    const { created, stream } = setup();
    const source = created[0]!;
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    source.emit('message', { data: '' });
    source.emit('message', {});
    source.emit('message', { data: 'not json' });
    source.emit('message', { data: JSON.stringify({ payload: { type: 'real' } }) });

    expect((await pending).value).toEqual({ payload: { type: 'real' } });
  });

  test('surfaces an http status as `cause.status` so the SDK can classify a hard failure', async () => {
    const { created, stream } = setup();
    const source = created[0]!;
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    // `openEventStream` reads `(error as { cause?: { status?: unknown } }).cause?.status`
    // to decide whether an attempt was a HARD failure — the signature of a dead
    // or unauthorized sandbox, which is what drives its give-up/park path.
    // Without this shape a 403 looks like an ordinary blip and retries forever,
    // which is the bespoke `authFailedUrlRef` halt this transport replaces.
    source.emit('error', { xhrStatus: 403, message: 'Forbidden' });

    await expect(pending).rejects.toMatchObject({ cause: { status: 403 } });
    expect(source.closed).toBe(true);
  });

  test('rejects a statusless transport error too, so the shared backoff owns the retry', async () => {
    const { created, stream } = setup();
    const source = created[0]!;
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    source.emit('error', { message: 'Network request failed' });

    await expect(pending).rejects.toThrow(/Network request failed/);
  });

  test('closes the connection and ends the stream when the attempt is aborted', async () => {
    const { created, controller, stream } = setup();
    const source = created[0]!;
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort();

    expect(source.closed).toBe(true);
    expect((await pending).done).toBe(true);
  });

  test('opens nothing when the attempt is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const created: FakeEventSource[] = [];

    openEventSourceStream({
      url: 'https://api.example.test/p/box-1/8000',
      signal: controller.signal,
      createEventSource: (url) => {
        const es = new FakeEventSource(url);
        created.push(es);
        return es;
      },
    });

    expect(created).toHaveLength(0);
  });
});
