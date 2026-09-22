import { afterEach, describe, expect, test } from 'bun:test';
import {
  getEventStreamTransport,
  setEventStreamTransport,
  type EventStreamTransport,
} from './event-stream-transport';
import {
  openEventStream,
  type EventStreamClient,
  type EventStreamTimerHandle,
  type EventStreamTimers,
  type OpenCodeEvent,
} from './event-stream';

// ─────────────────────────────────────────────────────────────────────────────
// The seam this file covers exists because the SDK's wire — `client.global
// .event()` in @opencode-ai/sdk — reads `response.body.pipeThrough(new
// TextDecoderStream())`. React Native's `fetch` has no `response.body` and
// Hermes has no `TextDecoderStream`, so that call can never resolve on RN.
// `apps/mobile` therefore carried its own 655-line copy of the reconnect,
// backoff, heartbeat and coalescing logic on `react-native-sse`.
//
// These tests pin the ONE property that makes the seam worth having: a
// registered transport changes only HOW BYTES ARRIVE. Every retry decision
// still comes from `openEventStream`. If a future change forks the reconnect
// loop per transport, the backoff test below goes red.
// ─────────────────────────────────────────────────────────────────────────────

function textEvent(id: string): OpenCodeEvent {
  return { type: 'message.part.updated', properties: { part: { id } } } as unknown as OpenCodeEvent;
}

/** Minimal push-driven async iterable — the shape a transport returns. */
class FakeChannel {
  private buffer: unknown[] = [];
  private waiter: { resolve: (r: IteratorResult<unknown>) => void } | null = null;
  private ended = false;

  push(event: unknown) {
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: event, done: false });
      return;
    }
    this.buffer.push(event);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift(), done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = { resolve };
        });
      },
    };
  }
}

async function tick(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface FakeClock extends EventStreamTimers {
  advance(ms: number): Promise<void>;
}

function createFakeClock(): FakeClock {
  let time = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; seq: number; fn: () => void }>();

  const setTimeoutFn: EventStreamTimers['setTimeout'] = (handler, ms = 0) => {
    const id = ++seq;
    timers.set(id, { at: time + ms, seq: id, fn: handler });
    return id as unknown as EventStreamTimerHandle;
  };
  const clearTimeoutFn: EventStreamTimers['clearTimeout'] = (handle) => {
    if (handle === undefined) return;
    timers.delete(handle as unknown as number);
  };

  async function advance(ms: number): Promise<void> {
    const target = time + ms;
    await tick();
    while (true) {
      let dueId: number | undefined;
      let due: { at: number; seq: number; fn: () => void } | undefined;
      for (const [id, entry] of timers) {
        if (
          entry.at <= target &&
          (!due || entry.at < due.at || (entry.at === due.at && entry.seq < due.seq))
        ) {
          due = entry;
          dueId = id;
        }
      }
      if (dueId === undefined || !due) break;
      timers.delete(dueId);
      time = due.at;
      due.fn();
      await tick();
    }
    time = target;
  }

  return { now: () => time, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, advance };
}

/** A vendor client that records whether its own wire was used. */
function createRecordingClient() {
  const channels: FakeChannel[] = [];
  let attempts = 0;
  const client: EventStreamClient = {
    global: {
      event: async (opts) => {
        attempts++;
        const channel = new FakeChannel();
        opts.signal.addEventListener('abort', () => channel.end(), { once: true });
        channels.push(channel);
        return { stream: channel };
      },
    },
  };
  return { client, channels, attempts: () => attempts };
}

afterEach(() => {
  setEventStreamTransport(null);
});

describe('event stream transport registration', () => {
  test('round-trips a registered transport and clears it with null', () => {
    expect(getEventStreamTransport()).toBeNull();

    const transport: EventStreamTransport = async () => ({ stream: new FakeChannel() });
    setEventStreamTransport(transport);
    expect(getEventStreamTransport()).toBe(transport);

    setEventStreamTransport(null);
    expect(getEventStreamTransport()).toBeNull();
  });
});

describe('openEventStream transport selection', () => {
  test('uses the registered transport — not the vendor client — when a url is supplied', async () => {
    const clock = createFakeClock();
    const recording = createRecordingClient();
    const seen: Array<{ url: string }> = [];
    const channel = new FakeChannel();
    setEventStreamTransport(async ({ url }) => {
      seen.push({ url });
      return { stream: channel };
    });

    const dispatched: OpenCodeEvent[] = [];
    const handle = openEventStream({
      client: recording.client,
      url: 'https://api.example.test/p/box-1/8000',
      onEvent: (e) => dispatched.push(e),
      timers: clock,
    });
    await tick();

    expect(seen).toEqual([{ url: 'https://api.example.test/p/box-1/8000' }]);
    expect(recording.attempts()).toBe(0);

    channel.push(textEvent('prt_1'));
    await clock.advance(20);
    expect(dispatched).toHaveLength(1);

    handle.close();
  });

  test('falls back to the vendor client when no transport is registered', async () => {
    const clock = createFakeClock();
    const recording = createRecordingClient();

    const handle = openEventStream({
      client: recording.client,
      url: 'https://api.example.test/p/box-1/8000',
      onEvent: () => {},
      timers: clock,
    });
    await tick();

    expect(recording.attempts()).toBe(1);
    handle.close();
  });

  test('falls back to the vendor client when a transport is registered but no url is known', async () => {
    const clock = createFakeClock();
    const recording = createRecordingClient();
    let transportCalls = 0;
    setEventStreamTransport(async () => {
      transportCalls++;
      return { stream: new FakeChannel() };
    });

    const handle = openEventStream({
      client: recording.client,
      onEvent: () => {},
      timers: clock,
    });
    await tick();

    // A transport opens a connection to a url. Without one there is nothing to
    // open, so the vendor wire stays the fallback rather than the stream
    // silently going dark.
    expect(transportCalls).toBe(0);
    expect(recording.attempts()).toBe(1);
    handle.close();
  });

  test('aborts the transport through the signal it was handed when the handle closes', async () => {
    const clock = createFakeClock();
    const recording = createRecordingClient();
    let aborted = false;
    const channel = new FakeChannel();
    setEventStreamTransport(async ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          channel.end();
        },
        { once: true },
      );
      return { stream: channel };
    });

    const handle = openEventStream({
      client: recording.client,
      url: 'https://api.example.test/p/box-1/8000',
      onEvent: () => {},
      timers: clock,
    });
    await tick();
    expect(aborted).toBe(false);

    handle.close();
    await tick();
    expect(aborted).toBe(true);
  });

  test('a failing transport retries through openEventStream’s own backoff, not its own', async () => {
    const clock = createFakeClock();
    const recording = createRecordingClient();
    const attemptTimes: number[] = [];
    setEventStreamTransport(async () => {
      attemptTimes.push(clock.now());
      throw new Error('RN EventSource refused the connection');
    });

    const handle = openEventStream({
      client: recording.client,
      url: 'https://api.example.test/p/box-1/8000',
      onEvent: () => {},
      timers: clock,
    });
    await tick();

    // First attempt is immediate; the retry waits out the shared backoff. This
    // is the whole point of the seam — the transport supplies bytes and
    // nothing else, so it never grows a reconnect loop of its own.
    expect(attemptTimes).toHaveLength(1);
    await clock.advance(1_000);
    expect(attemptTimes.length).toBeGreaterThan(1);
    expect(attemptTimes[1]).toBeGreaterThanOrEqual(1_000);
    expect(recording.attempts()).toBe(0);

    handle.close();
  });
});
