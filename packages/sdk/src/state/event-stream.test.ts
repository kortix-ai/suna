import { describe, expect, test } from 'bun:test';
import {
  openEventStream,
  type EventStreamClient,
  type EventStreamTimerHandle,
  type EventStreamTimers,
  type OpenCodeEvent,
} from './event-stream';

const HEARTBEAT_MS = 15_000;

function sessionStatus(sessionID: string, statusType: string): OpenCodeEvent {
  return {
    type: 'session.status',
    properties: { sessionID, status: { type: statusType } },
  } as unknown as OpenCodeEvent;
}

function partUpdated(partId: string): OpenCodeEvent {
  return {
    type: 'message.part.updated',
    properties: { part: { id: partId } },
  } as unknown as OpenCodeEvent;
}

class FakeEventChannel {
  private buffer: unknown[] = [];
  private waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null =
    null;
  private ended = false;
  private pendingError: unknown = null;

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

  fail(err: unknown) {
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(err);
      return;
    }
    this.pendingError = err;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.pendingError) {
          const err = this.pendingError;
          this.pendingError = null;
          return Promise.reject(err);
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift(), done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
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
  callCount(): number;
}

function createFakeClock(): FakeClock {
  let time = 0;
  let seq = 0;
  let calls = 0;
  const timers = new Map<number, { at: number; seq: number; fn: () => void }>();

  const setTimeoutFn: EventStreamTimers['setTimeout'] = (handler, ms = 0) => {
    calls++;
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
        if (entry.at <= target && (!due || entry.at < due.at || (entry.at === due.at && entry.seq < due.seq))) {
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

  return { now: () => time, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, advance, callCount: () => calls };
}

function createConnectableClient(onConnect?: () => void) {
  const channels: FakeEventChannel[] = [];
  let attempts = 0;
  const client: EventStreamClient = {
    global: {
      event: async (opts) => {
        attempts++;
        onConnect?.();
        const channel = new FakeEventChannel();
        opts.signal.addEventListener('abort', () => channel.end(), { once: true });
        channels.push(channel);
        return { stream: channel };
      },
    },
  };
  return { client, channels, attempts: () => attempts };
}

function createLoggingTimers(clock: FakeClock): { timers: EventStreamTimers; log: string[] } {
  const log: string[] = [];
  const timers: EventStreamTimers = {
    now: clock.now,
    setTimeout: (handler, ms) => {
      log.push(`timeout:${ms ?? 0}`);
      return clock.setTimeout(handler, ms);
    },
    clearTimeout: clock.clearTimeout,
  };
  return { timers, log };
}

function reconnectDelaysFromLog(log: string[]): number[] {
  const delays: number[] = [];
  let pendingDelay: number | undefined;
  for (const entry of log) {
    if (entry.startsWith('timeout:')) {
      pendingDelay = Number(entry.slice('timeout:'.length));
    } else if (entry === 'connect') {
      if (pendingDelay !== undefined) delays.push(pendingDelay);
      pendingDelay = undefined;
    }
  }
  return delays;
}

describe('openEventStream coalescing', () => {
  test('replaces earlier same-key events within a flush window, leaves other types untouched', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: OpenCodeEvent[] = [];

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();

    channels[0].push(sessionStatus('s1', 'busy'));
    channels[0].push(sessionStatus('s1', 'idle'));
    channels[0].push(sessionStatus('s1', 'busy'));
    channels[0].push(partUpdated('p1'));
    channels[0].push(partUpdated('p2'));
    await tick();

    await clock.advance(16);

    expect(dispatched.map((e) => e.type)).toEqual([
      'session.status',
      'message.part.updated',
      'message.part.updated',
    ]);
    expect((dispatched[0].properties as any).status.type).toBe('busy');
    expect((dispatched[1].properties as any).part.id).toBe('p1');
    expect((dispatched[2].properties as any).part.id).toBe('p2');

    handle.close();
  });

  test('flushes on a 16ms cadence, not immediately on push', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: OpenCodeEvent[] = [];

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();

    channels[0].push(partUpdated('p1'));
    await tick();
    expect(dispatched.length).toBe(0);

    await clock.advance(15);
    expect(dispatched.length).toBe(0);

    await clock.advance(1);
    expect(dispatched.length).toBe(1);

    handle.close();
  });

  test('swallows a throwing onEvent handler and keeps dispatching later events', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: OpenCodeEvent[] = [];
    let throwOnce = true;

    const handle = openEventStream({
      client,
      onEvent: (e) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('handler blew up');
        }
        dispatched.push(e);
      },
      timers: clock,
    });
    await tick();

    channels[0].push(partUpdated('p1'));
    channels[0].push(partUpdated('p2'));
    await tick();
    await clock.advance(16);

    expect(dispatched.map((e) => (e.properties as any).part.id)).toEqual(['p2']);

    handle.close();
  });
});

describe('openEventStream reconnect backoff', () => {
  test('backs off exponentially from 1s, capped at 30s, across unhealthy disconnects', async () => {
    const clock = createFakeClock();
    const { timers, log } = createLoggingTimers(clock);
    const channels: FakeEventChannel[] = [];
    let attempts = 0;
    const client: EventStreamClient = {
      global: {
        event: async () => {
          attempts++;
          log.push('connect');
          const channel = new FakeEventChannel();
          channels.push(channel);
          return { stream: channel };
        },
      },
    };

    const handle = openEventStream({ client, onEvent: () => {}, timers });
    await tick();

    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const expectedDelay of expectedDelays) {
      const beforeAttempts = attempts;
      channels[channels.length - 1].end();
      await clock.advance(expectedDelay);
      expect(attempts).toBe(beforeAttempts + 1);
    }

    expect(reconnectDelaysFromLog(log)).toEqual(expectedDelays);

    handle.close();
  });

  test('resets to a fast 250ms reconnect after a healthy stream, then re-backs-off from 1s', async () => {
    const clock = createFakeClock();
    const { timers, log } = createLoggingTimers(clock);
    const { client, channels } = createConnectableClient(() => log.push('connect'));

    const dispatched: OpenCodeEvent[] = [];
    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers });
    await tick();

    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);
    expect(dispatched.length).toBe(1);

    channels[0].end();
    await clock.advance(250);
    expect(channels.length).toBe(2);

    channels[1].end();
    await clock.advance(1000);
    expect(channels.length).toBe(3);

    channels[2].end();
    await clock.advance(2000);
    expect(channels.length).toBe(4);

    expect(reconnectDelaysFromLog(log)).toEqual([250, 1000, 2000]);

    handle.close();
  });

  test('backs off identically when the connect call itself rejects', async () => {
    const clock = createFakeClock();
    const { timers, log } = createLoggingTimers(clock);
    let attempts = 0;
    const client: EventStreamClient = {
      global: {
        event: async () => {
          attempts++;
          log.push('connect');
          throw new Error('network down');
        },
      },
    };

    const handle = openEventStream({ client, onEvent: () => {}, timers });
    await tick();

    await clock.advance(1000);
    expect(attempts).toBe(2);
    await clock.advance(2000);
    expect(attempts).toBe(3);

    expect(reconnectDelaysFromLog(log)).toEqual([1000, 2000]);

    handle.close();
  });
});

describe('openEventStream heartbeat watchdog', () => {
  test('forces a reconnect and drops the event that surfaces after the 15s deadline', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: OpenCodeEvent[] = [];

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();

    channels[0].push(sessionStatus('s1', 'busy'));
    await tick();
    await clock.advance(16);
    expect(dispatched.length).toBe(1);

    await clock.advance(HEARTBEAT_MS - 16);

    channels[0].push(sessionStatus('s1', 'idle'));
    await tick();

    expect(dispatched.length).toBe(1);
    expect(channels.length).toBe(1);

    await clock.advance(250);
    expect(channels.length).toBe(2);

    handle.close();
  });
});

describe('openEventStream gap rehydrate', () => {
  test('calls onGapRehydrate when the reconnect gap exceeds 5s', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const gaps: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onGapRehydrate: (gapMs) => gaps.push(gapMs),
      timers: clock,
    });
    await tick();

    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);

    await clock.advance(6000);
    channels[0].end();
    await tick();

    expect(gaps).toEqual([6000]);

    handle.close();
  });

  test('does not call onGapRehydrate when the reconnect gap is under 5s', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const gaps: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onGapRehydrate: (gapMs) => gaps.push(gapMs),
      timers: clock,
    });
    await tick();

    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);

    await clock.advance(1000);
    channels[0].end();
    await tick();

    expect(gaps).toEqual([]);

    handle.close();
  });
});

describe('openEventStream close()', () => {
  test('tears down cleanly: no further connects, timers, or dispatches', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: OpenCodeEvent[] = [];

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();

    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);
    expect(dispatched.length).toBe(1);

    handle.close();
    await tick();

    channels[0].push(partUpdated('p2'));
    await tick();
    await clock.advance(60_000);

    expect(dispatched.length).toBe(1);
    expect(channels.length).toBe(1);
  });

  test('unblocks a live connection stuck awaiting the next event', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();

    const handle = openEventStream({ client, onEvent: () => {}, timers: clock });
    await tick();
    expect(channels.length).toBe(1);

    handle.close();
    await tick();
    await clock.advance(60_000);

    expect(channels.length).toBe(1);
  });

  test('close() is idempotent', async () => {
    const clock = createFakeClock();
    const { client } = createConnectableClient();

    const handle = openEventStream({ client, onEvent: () => {}, timers: clock });
    await tick();

    handle.close();
    handle.close();
    await tick();
  });
});
