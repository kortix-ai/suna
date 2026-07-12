import { describe, expect, test } from 'bun:test';
import {
  openEventStream,
  type EventStreamClient,
  type EventStreamTimerHandle,
  type EventStreamTimers,
  type RuntimeEvent,
} from './event-stream';

// Mirrors event-stream.ts's default idle-watchdog budget (raised from 15s —
// the server emits no idle keepalives, so a 15s budget killed healthy idle
// sessions on a timer by design; see the HEARTBEAT_MS comment there).
const HEARTBEAT_MS = 60_000;

function sessionStatus(sessionID: string, statusType: string): RuntimeEvent {
  return {
    type: 'session.status',
    properties: { sessionID, status: { type: statusType } },
  } as unknown as RuntimeEvent;
}

function partUpdated(partId: string): RuntimeEvent {
  return {
    type: 'message.part.updated',
    properties: { part: { id: partId } },
  } as unknown as RuntimeEvent;
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

// Mirrors event-stream.ts's default `connectTimeoutMs`. Every connect attempt
// now schedules a connect-timeout timer right as it starts (before the
// connect call resolves) — that's a second `timeout:` log entry ahead of each
// `connect`, distinct from the real reconnect/backoff delay timer logged just
// before it. Filtered out below so `reconnectDelaysFromLog` still reports
// only genuine backoff delays.
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

function reconnectDelaysFromLog(log: string[]): number[] {
  const delays: number[] = [];
  let pendingDelay: number | undefined;
  for (const entry of log) {
    if (entry.startsWith('timeout:')) {
      const ms = Number(entry.slice('timeout:'.length));
      if (ms === DEFAULT_CONNECT_TIMEOUT_MS) continue;
      pendingDelay = ms;
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
    const dispatched: RuntimeEvent[] = [];

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
    const dispatched: RuntimeEvent[] = [];

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
    const dispatched: RuntimeEvent[] = [];
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

    // This walks 7 consecutive event-less fast disconnects — exactly one shy
    // of the default park threshold (8). Raise the threshold so this stays a
    // pure backoff test, decoupled from the give-up feature (covered by its
    // own describe block below).
    const handle = openEventStream({
      client,
      onEvent: () => {},
      timers,
      maxConsecutiveHardFailures: 100,
    });
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

    const dispatched: RuntimeEvent[] = [];
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

describe('openEventStream connect timeout', () => {
  test('a connect call that never resolves times out, aborts the attempt, and retries with backoff', async () => {
    const clock = createFakeClock();
    let attempts = 0;
    const abortedSignals: boolean[] = [];
    const client: EventStreamClient = {
      global: {
        event: async (opts) => {
          attempts++;
          const idx = abortedSignals.length;
          abortedSignals.push(false);
          opts.signal.addEventListener('abort', () => {
            abortedSignals[idx] = true;
          });
          // Never resolves, rejects, or closes — models a black-holed proxy
          // that silently swallows the connect request.
          return new Promise<{ stream: AsyncIterable<unknown> }>(() => {});
        },
      },
    };

    const handle = openEventStream({
      client,
      onEvent: () => {},
      timers: clock,
      connectTimeoutMs: 20_000,
    });
    await tick();
    expect(attempts).toBe(1);
    expect(abortedSignals[0]).toBe(false);

    // Short of the connect-timeout deadline: still hung, no abort, no retry.
    await clock.advance(19_999);
    await tick();
    expect(abortedSignals[0]).toBe(false);
    expect(attempts).toBe(1);

    // Crossing the deadline aborts the hung attempt...
    await clock.advance(1);
    await tick();
    expect(abortedSignals[0]).toBe(true);

    // ...and reconnects through the normal (unhealthy) backoff path — min 1s,
    // same as any other connect failure.
    await clock.advance(1000);
    await tick();
    expect(attempts).toBe(2);

    handle.close();
  });

  test('a connect that resolves within the budget is unaffected — no spurious abort or retry', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: RuntimeEvent[] = [];

    const handle = openEventStream({
      client,
      onEvent: (e) => dispatched.push(e),
      timers: clock,
      connectTimeoutMs: 20_000,
    });
    await tick();
    expect(channels.length).toBe(1);

    // Advance most of the way toward the connect-timeout budget (short of the
    // separate 15s heartbeat deadline, covered by its own tests) — since
    // connect already resolved (synchronously, in this fake client), the
    // connect-timeout timer must already be cleared and this must not force a
    // reconnect or drop the connection.
    await clock.advance(10_000);
    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);

    expect(dispatched.length).toBe(1);
    expect(channels.length).toBe(1);

    handle.close();
  });

  test('a slow-but-successful connect (just under budget) keeps the same attempt — no reconnect', async () => {
    const clock = createFakeClock();
    let resolveConnect: ((v: { stream: AsyncIterable<unknown> }) => void) | undefined;
    let attempts = 0;
    const client: EventStreamClient = {
      global: {
        event: () => {
          attempts++;
          return new Promise<{ stream: AsyncIterable<unknown> }>((resolve) => {
            resolveConnect = resolve;
          });
        },
      },
    };

    const handle = openEventStream({
      client,
      onEvent: () => {},
      timers: clock,
      connectTimeoutMs: 20_000,
    });
    await tick();
    expect(attempts).toBe(1);

    await clock.advance(19_999);
    expect(attempts).toBe(1);

    resolveConnect?.(({ stream: createParkingChannel([]) }));
    await tick();

    // Advance past where the (now-cleared) connect-timeout budget would have
    // fired, but short of the 15s heartbeat deadline (a separate watchdog,
    // covered by its own tests) — isolates that the connect timer specifically
    // didn't leak into a second attempt.
    await clock.advance(2000);
    expect(attempts).toBe(1);

    handle.close();
  });
});

function createParkingChannel(chunks: unknown[]): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          if (index < chunks.length) {
            const value = chunks[index++];
            return Promise.resolve({ value, done: false });
          }
          // Parks forever: no further value, no error, no `done`. Models a
          // stalled socket that just sits there with nothing observable —
          // the underlying fetch/read never settles on its own.
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
  };
}

describe('openEventStream heartbeat watchdog', () => {
  test('forces a reconnect and drops the event that surfaces after the idle deadline', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: RuntimeEvent[] = [];

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

  test('reconnects off a permanently parked read that never resolves, errors, or closes', async () => {
    const clock = createFakeClock();
    const dispatched: RuntimeEvent[] = [];
    let attempts = 0;

    const client: EventStreamClient = {
      global: {
        event: async () => {
          attempts++;
          return { stream: createParkingChannel([sessionStatus('s1', 'busy')]) };
        },
      },
    };

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();

    await clock.advance(16);
    expect(dispatched.length).toBe(1);
    expect(attempts).toBe(1);

    await clock.advance(HEARTBEAT_MS - 16);
    expect(attempts).toBe(1);

    await clock.advance(250);
    expect(attempts).toBe(2);

    handle.close();
  });

  test('aborts the previous connection signal on a heartbeat reconnect (no leaked stream)', async () => {
    const clock = createFakeClock();
    const abortedSignals: boolean[] = [];
    const client: EventStreamClient = {
      global: {
        event: async (opts) => {
          const idx = abortedSignals.length;
          abortedSignals.push(false);
          opts.signal.addEventListener('abort', () => {
            abortedSignals[idx] = true;
          });
          // Park so only the heartbeat can end this attempt.
          return { stream: createParkingChannel([]) };
        },
      },
    };

    const handle = openEventStream({ client, onEvent: () => {}, timers: clock });
    await tick();
    expect(abortedSignals.length).toBe(1);
    expect(abortedSignals[0]).toBe(false);

    // Cross the heartbeat deadline → the first attempt's own signal must fire
    // (that's what cancels the vendor reader), then reconnect.
    await clock.advance(HEARTBEAT_MS);
    await tick();
    expect(abortedSignals[0]).toBe(true);

    // This connection delivered NO events, so a watchdog kill is NOT a
    // "stable" disconnect — the reconnect rides the exponential backoff path
    // (min 1s), not the 250ms fast-resume (see the storm fix in
    // event-stream.ts).
    await clock.advance(1000);
    await tick();
    expect(abortedSignals.length).toBe(2);
    expect(abortedSignals[1]).toBe(false);

    handle.close();
  });

  test('a genuine mid-stream rejection reconnects with backoff', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: RuntimeEvent[] = [];

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();

    channels[0].push(sessionStatus('s1', 'busy'));
    await tick();
    await clock.advance(16);
    expect(dispatched.length).toBe(1);

    channels[0].fail(new Error('ERR_STREAM_ABORTED'));
    await tick();
    expect(channels.length).toBe(1);

    // A thrown stream skips the stable-connection computation, so it reconnects
    // on the exponential path (min 1s), not the 250ms fast-resume — the point
    // is that the rejection is handled and retried, not swallowed.
    await clock.advance(1000);
    await tick();
    expect(channels.length).toBe(2);

    handle.close();
  });
});

// ── Backoff classification (the prod reconnect-storm fix): an idle
// disconnect — watchdog kill or natural end with no events — must NEVER
// count as "stable". Only a stream that actually delivered events resets
// backoff to the 250ms fast path. The old time-based OR-branch ("open >10s
// counts as stable") locked idle streams killed on any period above 10s
// into 250ms reconnects forever. ─────────────────────────────────────────

describe('openEventStream idle-disconnect backoff (reconnect-storm fix)', () => {
  test('repeated watchdog kills of idle (event-less) connections back off exponentially, not at 250ms', async () => {
    const clock = createFakeClock();
    const { client } = createConnectableClient();
    let attempts = 0;
    const countingClient: EventStreamClient = {
      global: {
        event: async (opts) => {
          attempts++;
          return client.global.event(opts);
        },
      },
    };

    const handle = openEventStream({ client: countingClient, onEvent: () => {}, timers: clock });
    await tick();
    expect(attempts).toBe(1);

    // Cycle 1: idle 60s → watchdog kill → reconnect must wait the FULL 1s
    // exponential base, not 250ms.
    await clock.advance(HEARTBEAT_MS);
    await tick();
    await clock.advance(999);
    expect(attempts).toBe(1);
    await clock.advance(1);
    expect(attempts).toBe(2);

    // Cycle 2: still idle → delay GROWS to 2s.
    await clock.advance(HEARTBEAT_MS);
    await tick();
    await clock.advance(1999);
    expect(attempts).toBe(2);
    await clock.advance(1);
    expect(attempts).toBe(3);

    // Cycle 3: still idle → delay GROWS to 4s.
    await clock.advance(HEARTBEAT_MS);
    await tick();
    await clock.advance(3999);
    expect(attempts).toBe(3);
    await clock.advance(1);
    expect(attempts).toBe(4);

    handle.close();
  });

  test('a genuinely eventful connection still resets backoff to the 250ms fast path', async () => {
    const clock = createFakeClock();
    const { client, channels } = createConnectableClient();
    const dispatched: RuntimeEvent[] = [];

    const handle = openEventStream({ client, onEvent: (e) => dispatched.push(e), timers: clock });
    await tick();
    expect(channels.length).toBe(1);

    // Grow backoff with two idle watchdog kills (1s, then 2s delays).
    await clock.advance(HEARTBEAT_MS);
    await tick();
    await clock.advance(1000);
    expect(channels.length).toBe(2);
    await clock.advance(HEARTBEAT_MS);
    await tick();
    await clock.advance(2000);
    expect(channels.length).toBe(3);

    // The third connection delivers a REAL event → stable → backoff resets.
    channels[2].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);
    expect(dispatched.length).toBe(1);

    channels[2].end();
    await tick();
    await clock.advance(250);
    expect(channels.length).toBe(4);

    handle.close();
  });

  test('idle heartbeat tolerance: 59s of quiet does not kill the stream; crossing 60s does, into backoff', async () => {
    const clock = createFakeClock();
    const abortedSignals: boolean[] = [];
    let attempts = 0;
    const client: EventStreamClient = {
      global: {
        event: async (opts) => {
          attempts++;
          const idx = abortedSignals.length;
          abortedSignals.push(false);
          opts.signal.addEventListener('abort', () => {
            abortedSignals[idx] = true;
          });
          return { stream: createParkingChannel([]) };
        },
      },
    };

    const handle = openEventStream({ client, onEvent: () => {}, timers: clock });
    await tick();
    expect(attempts).toBe(1);

    // 59s idle (short of the 60s budget): still alive, no watchdog abort.
    await clock.advance(59_000);
    await tick();
    expect(abortedSignals[0]).toBe(false);
    expect(attempts).toBe(1);

    // Crossing the 60s budget: watchdog kills it...
    await clock.advance(1_000);
    await tick();
    expect(abortedSignals[0]).toBe(true);

    // ...and the reconnect rides the 1s backoff path (idle kill ≠ stable),
    // NOT the 250ms fast-resume: nothing for 999ms, reconnect at 1s.
    await clock.advance(999);
    expect(attempts).toBe(1);
    await clock.advance(1);
    expect(attempts).toBe(2);

    handle.close();
  });

  test('heartbeatTimeoutMs is configurable per stream (a 5s budget kills at 5s idle)', async () => {
    const clock = createFakeClock();
    const abortedSignals: boolean[] = [];
    const client: EventStreamClient = {
      global: {
        event: async (opts) => {
          const idx = abortedSignals.length;
          abortedSignals.push(false);
          opts.signal.addEventListener('abort', () => {
            abortedSignals[idx] = true;
          });
          return { stream: createParkingChannel([]) };
        },
      },
    };

    const handle = openEventStream({
      client,
      onEvent: () => {},
      timers: clock,
      heartbeatTimeoutMs: 5_000,
    });
    await tick();

    await clock.advance(4_999);
    await tick();
    expect(abortedSignals[0]).toBe(false);

    await clock.advance(1);
    await tick();
    expect(abortedSignals[0]).toBe(true);

    handle.close();
  });
});

// ── Give-up (parked) terminal state: streams pointed at DEAD sandboxes
// (archived/stopped sessions) used to retry forever — prod showed continuous
// 503 loops from /p/{sandbox}/8000/global/event for multiple dead sandboxes
// at once. After `maxConsecutiveHardFailures` consecutive event-less
// HTTP/fast failures the stream parks: onParked fires once, no further
// connect attempts, close() stays safe. ────────────────────────────────────

/** A client whose connect always rejects instantly, like a proxy 503ing a
 *  dead sandbox. The error carries the vendor client's `cause.status` shape. */
function createDeadSandboxClient() {
  let attempts = 0;
  const client: EventStreamClient = {
    global: {
      event: async () => {
        attempts++;
        throw new Error('GET /global/event → 503 Service Unavailable', {
          cause: { body: 'sandbox gone', status: 503 },
        });
      },
    },
  };
  return { client, attempts: () => attempts };
}

describe('openEventStream parked state (dead-sandbox give-up)', () => {
  test('parks after the default 8 consecutive hard failures: onParked fires once, retries stop for good', async () => {
    const clock = createFakeClock();
    const { client, attempts } = createDeadSandboxClient();
    const parkedReasons: { consecutiveFailures: number; lastError: unknown }[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onParked: (reason) => parkedReasons.push(reason),
      timers: clock,
    });
    await tick();

    // Walk the whole backoff ladder (1+2+4+8+16+30+30 = 91s of delays — the
    // give-up is spread over ~2 minutes, not instant).
    await clock.advance(200_000);
    await tick();

    expect(attempts()).toBe(8);
    expect(parkedReasons).toHaveLength(1);
    expect(parkedReasons[0].consecutiveFailures).toBe(8);
    expect(String(parkedReasons[0].lastError)).toContain('503');

    // Terminal: no matter how much more time passes, no further attempts,
    // no second onParked.
    await clock.advance(600_000);
    await tick();
    expect(attempts()).toBe(8);
    expect(parkedReasons).toHaveLength(1);

    // close() on a parked handle stays safe/idempotent.
    expect(() => handle.close()).not.toThrow();
    expect(() => handle.close()).not.toThrow();
  });

  test('maxConsecutiveHardFailures is configurable (parks after 3)', async () => {
    const clock = createFakeClock();
    const { client, attempts } = createDeadSandboxClient();
    const parked: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onParked: (r) => parked.push(r.consecutiveFailures),
      timers: clock,
      maxConsecutiveHardFailures: 3,
    });
    await tick();

    await clock.advance(60_000);
    await tick();

    expect(attempts()).toBe(3);
    expect(parked).toEqual([3]);

    handle.close();
  });

  test('an eventful connection resets the hard-failure streak', async () => {
    const clock = createFakeClock();
    let attempts = 0;
    const channels: FakeEventChannel[] = [];
    // Attempts 1-2 fail fast (503); attempt 3 connects and streams an event;
    // attempts 4+ fail fast again.
    const client: EventStreamClient = {
      global: {
        event: async (opts) => {
          attempts++;
          if (attempts === 3) {
            const channel = new FakeEventChannel();
            opts.signal.addEventListener('abort', () => channel.end(), { once: true });
            channels.push(channel);
            return { stream: channel };
          }
          throw new Error('GET /global/event → 503', { cause: { body: '', status: 503 } });
        },
      },
    };
    const parked: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onParked: (r) => parked.push(r.consecutiveFailures),
      timers: clock,
      maxConsecutiveHardFailures: 3,
    });
    await tick();

    // Failures 1 and 2 (streak = 2, one short of the threshold)...
    await clock.advance(1000);
    await tick();
    expect(attempts).toBe(2);
    await clock.advance(2000);
    await tick();
    expect(attempts).toBe(3);
    expect(parked).toEqual([]);

    // ...then attempt 3 delivers a REAL event — streak resets to 0.
    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);
    channels[0].end();
    await tick();

    // It now takes a FULL fresh streak of 3 to park (attempts 4, 5, 6) — if
    // the eventful connection hadn't reset the counter, attempt 4 alone
    // would have tripped it.
    await clock.advance(60_000);
    await tick();
    expect(parked).toEqual([3]);
    expect(attempts).toBe(6);

    handle.close();
  });

  test('parks even after prior successful streaming (sandbox died later)', async () => {
    const clock = createFakeClock();
    let attempts = 0;
    const channels: FakeEventChannel[] = [];
    // Attempt 1 streams events fine; the sandbox then dies — every later
    // connect 503s.
    const client: EventStreamClient = {
      global: {
        event: async (opts) => {
          attempts++;
          if (attempts === 1) {
            const channel = new FakeEventChannel();
            opts.signal.addEventListener('abort', () => channel.end(), { once: true });
            channels.push(channel);
            return { stream: channel };
          }
          throw new Error('GET /global/event → 503', { cause: { body: '', status: 503 } });
        },
      },
    };
    const parked: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onParked: (r) => parked.push(r.consecutiveFailures),
      timers: clock,
      maxConsecutiveHardFailures: 3,
    });
    await tick();

    channels[0].push(partUpdated('p1'));
    await tick();
    await clock.advance(16);
    channels[0].end();
    await tick();

    await clock.advance(60_000);
    await tick();

    expect(parked).toEqual([3]);
    expect(attempts).toBe(4); // 1 healthy + 3 hard failures

    handle.close();
  });

  test('a slow failure without an HTTP status (hung connect → connect timeout) never counts toward the park streak', async () => {
    const clock = createFakeClock();
    let attempts = 0;
    // Every connect hangs forever — the 20s connect timeout kills each one.
    // 20s > HARD_FAILURE_WINDOW_MS and the synthetic timeout error carries no
    // cause.status, so these are NOT hard failures and must never park.
    const client: EventStreamClient = {
      global: {
        event: () => {
          attempts++;
          return new Promise<{ stream: AsyncIterable<unknown> }>(() => {});
        },
      },
    };
    const parked: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onParked: (r) => parked.push(r.consecutiveFailures),
      timers: clock,
      maxConsecutiveHardFailures: 2,
    });
    await tick();

    // Enough time for well over 2 hung-connect cycles (20s timeout + backoff
    // each) — with maxConsecutiveHardFailures: 2, a single miscount parks.
    await clock.advance(200_000);
    await tick();

    expect(parked).toEqual([]);
    expect(attempts).toBeGreaterThan(3); // still retrying, never gave up

    handle.close();
  });

  test('an HTTP-status failure counts as hard even when it arrives slowly (>2s)', async () => {
    const clock = createFakeClock();
    let attempts = 0;
    // Each connect rejects with a 503 — but only after 5s (a slow edge), past
    // the fast-fail window. The cause.status branch must still classify it.
    const client: EventStreamClient = {
      global: {
        event: () => {
          attempts++;
          return new Promise<{ stream: AsyncIterable<unknown> }>((_resolve, reject) => {
            clock.setTimeout(() => {
              reject(new Error('GET /global/event → 503', { cause: { body: '', status: 503 } }));
            }, 5_000);
          });
        },
      },
    };
    const parked: number[] = [];

    const handle = openEventStream({
      client,
      onEvent: () => {},
      onParked: (r) => parked.push(r.consecutiveFailures),
      timers: clock,
      maxConsecutiveHardFailures: 2,
    });
    await tick();

    await clock.advance(60_000);
    await tick();

    expect(parked).toEqual([2]);
    expect(attempts).toBe(2);

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
    const dispatched: RuntimeEvent[] = [];

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
