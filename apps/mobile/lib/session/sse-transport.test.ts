import { describe, expect, test } from 'bun:test';
import { createSseTransport, type SseEventSource } from './sse-transport';

type Listener = (event: any) => void;

/** `react-native-sse`'s surface, driven by the test. */
class FakeEventSource implements SseEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Listener[]> = {};
  closed = 0;
  /** The library method the adapter redirects: called when a response finishes. */
  _pollAgain: (time: number, allowZero: boolean) => void = () => {
    this.reopened += 1;
  };
  reopened = 0;
  constructor(
    public url: string,
    public options: { headers?: Record<string, string>; pollingInterval?: number; timeoutBeforeConnection?: number },
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeAllEventListeners() {
    this.listeners = {};
  }
  close() {
    this.closed += 1;
    this.emit('close', { type: 'close' });
  }
  emit(type: string, event: unknown) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener(event);
  }
  message(data: string, lastEventId: string | null = null) {
    this.emit('message', { type: 'message', data, lastEventId, url: this.url });
  }
}

function open(options: { recycleBytes?: number; onUnauthorized?: () => void } = {}) {
  FakeEventSource.instances = [];
  const abort = new AbortController();
  const transport = createSseTransport({ EventSource: FakeEventSource, ...options });
  const iterator = transport({
    url: 'https://api.test/v1/p/sbx/8000/global/event',
    headers: new Headers({ Authorization: 'Bearer tok', 'Last-Event-ID': '7' }),
    signal: abort.signal,
  })[Symbol.asyncIterator]();
  // The generator body runs on the first `next()`.
  const first = iterator.next();
  return { abort, iterator, first, source: () => FakeEventSource.instances[0]! };
}

describe('createSseTransport', () => {
  test('opens one connection with the SDK headers and never lets the library re-open it', async () => {
    const { iterator, first, source } = open();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source().url).toBe('https://api.test/v1/p/sbx/8000/global/event');
    expect(source().options.headers).toEqual({ authorization: 'Bearer tok', 'last-event-id': '7' });
    expect(source().options.pollingInterval).toBe(0);

    source().message('{"n":1}', '8');
    source().message('{"n":2}');
    expect(await first).toEqual({ done: false, value: { data: '{"n":1}', id: '8' } });
    expect(await iterator.next()).toEqual({ done: false, value: { data: '{"n":2}' } });

    // The response finished: the library asks to poll again. That ends this
    // connection cleanly; the SDK decides when to reconnect.
    source()._pollAgain(0, false);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(source().reopened).toBe(0);
    expect(source().closed).toBe(1);
  });

  test('a frame without data is not a message', async () => {
    const { iterator, first, source } = open();
    source().emit('message', { type: 'message', data: null, lastEventId: null, url: '' });
    source().message('{"n":1}');
    expect(await first).toEqual({ done: false, value: { data: '{"n":1}' } });
    void iterator.return?.();
  });

  test('an HTTP error throws with its status after the queued messages', async () => {
    const { iterator, first, source } = open();
    source().message('{"n":1}');
    source().emit('error', { type: 'error', message: 'gone', xhrStatus: 503, xhrState: 4 });
    expect(await first).toEqual({ done: false, value: { data: '{"n":1}' } });
    const failure = await iterator.next().then(
      () => null,
      (error: unknown) => error as { status?: number; message?: string },
    );
    expect(failure?.status).toBe(503);
    expect(source().closed).toBe(1);
  });

  test('401 and 403 report the login check; other statuses do not', async () => {
    for (const [status, expected] of [[401, 1], [403, 1], [503, 0]] as const) {
      let reports = 0;
      const { first, source } = open({ onUnauthorized: () => reports++ });
      source().emit('error', { type: 'error', message: '', xhrStatus: status, xhrState: 4 });
      await first.catch(() => {});
      expect(reports).toBe(expected);
    }
  });

  test('a network error (no status) throws without a status', async () => {
    const { first, source } = open();
    source().emit('error', { type: 'error', message: '', xhrStatus: 0, xhrState: 4 });
    const failure = await first.then(
      () => null,
      (error: unknown) => error as { status?: number },
    );
    expect(failure).not.toBeNull();
    expect(failure?.status).toBeUndefined();
  });

  test('an abort ends the connection cleanly', async () => {
    const { abort, first, source } = open();
    abort.abort();
    expect(await first).toEqual({ done: true, value: undefined });
    expect(source().closed).toBe(1);
  });

  test('past the byte budget the connection ends, after the current chunk is delivered', async () => {
    const { iterator, first, source } = open({ recycleBytes: 10 });
    // One network chunk carries three frames; the library dispatches them in
    // one synchronous run. The budget is crossed by the second.
    source().message('123456');
    source().message('789012');
    source().message('tail');
    expect(await first).toEqual({ done: false, value: { data: '123456' } });
    expect(await iterator.next()).toEqual({ done: false, value: { data: '789012' } });
    expect(await iterator.next()).toEqual({ done: false, value: { data: 'tail' } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(source().closed).toBe(1);
  });

  test('a library close ends the connection cleanly', async () => {
    const { first, source } = open();
    source().emit('close', { type: 'close' });
    expect(await first).toEqual({ done: true, value: undefined });
  });
});
