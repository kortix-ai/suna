import { describe, expect, test } from 'bun:test';
import {
  openEventStream,
  type EventStreamClient,
  type EventStreamTimerHandle,
  type EventStreamTimers,
  type OpenCodeEvent,
} from '../../core/stream/event-stream';
import { rehydrateHeldTranscripts, reserveMessageRehydrate } from './helpers';

/**
 * The stream's resync floor and the hook's transcript floor, together.
 *
 * `openEventStream` stamps its floor, then calls every subscriber. Each
 * subscriber runs `hydrateCore`, which reserves the transcript read after its
 * own setup, so a reservation lands some ms after the stamp. The stream
 * dispatches a resync the floor held back exactly when its floor ends. An equal
 * hook floor then dropped that read: the read that repairs the frames lost in
 * the second of two quick reconnects.
 */

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createClock() {
  let time = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: EventStreamTimers = {
    now: () => time,
    setTimeout: (fn, ms = 0) => {
      const id = ++seq;
      pending.set(id, { at: time + ms, fn });
      return id as unknown as EventStreamTimerHandle;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) pending.delete(handle as unknown as number);
    },
  };
  return {
    timers,
    now: () => time,
    /** Time a synchronous callback spends. No timer runs. */
    spend: (ms: number) => {
      time += ms;
    },
    async advance(ms: number): Promise<void> {
      const target = time + ms;
      await settle();
      for (;;) {
        let nextId: number | undefined;
        for (const [id, entry] of pending) {
          if (entry.at > target) continue;
          if (nextId === undefined || entry.at < pending.get(nextId)!.at) nextId = id;
        }
        if (nextId === undefined) break;
        const entry = pending.get(nextId)!;
        pending.delete(nextId);
        time = Math.max(time, entry.at);
        entry.fn();
        await settle();
      }
      time = target;
    },
  };
}

function createChannel() {
  const buffer: unknown[] = [];
  let waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  let ended = false;
  return {
    push(value: unknown) {
      if (!waiter) {
        buffer.push(value);
        return;
      }
      const resolve = waiter;
      waiter = null;
      resolve({ value, done: false });
    },
    end() {
      ended = true;
      if (!waiter) return;
      const resolve = waiter;
      waiter = null;
      resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: () => {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
      };
    },
  };
}

function createClient() {
  const channels: Array<ReturnType<typeof createChannel>> = [];
  const client: EventStreamClient = {
    global: {
      event: async (opts) => {
        const channel = createChannel();
        opts.signal.addEventListener('abort', () => channel.end(), { once: true });
        channels.push(channel);
        return { stream: channel };
      },
    },
  };
  return { client, channels };
}

const partUpdated = (id: string) =>
  ({ type: 'message.part.updated', properties: { part: { id } } }) as unknown as OpenCodeEvent;
const serverConnected = () => ({ type: 'server.connected', properties: {} }) as unknown as OpenCodeEvent;
const keepalive = () => ({ type: 'kortix.keepalive', properties: {} }) as unknown as OpenCodeEvent;

/**
 * The read rate of a flapping stream, per held transcript.
 *
 * Three held transcripts: one running session and two idle ones. Each read
 * takes 10 s, longer than the stream's 5 s resync floor. The host path is the
 * real one from `hydrateCore`: `rehydrateHeldTranscripts` over the resync's
 * `contentLost`. The test counts the reads the hook issues; the controller's
 * own coalescing of overlapping reads is not modelled here.
 */
async function flapFor60s(input: {
  /** What each attempt delivers before it drops. */
  frame: () => OpenCodeEvent;
  /** How long each attempt stays up. */
  upMs: number;
  prefix: string;
}) {
  const clock = createClock();
  const { client, channels } = createClient();
  const busy = `${input.prefix}_busy`;
  const idleA = `${input.prefix}_idle_a`;
  const idleB = `${input.prefix}_idle_b`;
  const readsAt: Record<string, number[]> = { [busy]: [], [idleA]: [], [idleB]: [] };
  const dispatchedAt: number[] = [];
  const handle = openEventStream({
    client,
    onEvent: () => {},
    onGapRehydrate: (_gapMs, info) => {
      dispatchedAt.push(clock.now());
      rehydrateHeldTranscripts({
        sessionIds: [busy, idleA, idleB],
        contentLost: info.contentLost,
        statusOf: (sessionID) => (sessionID === busy ? { type: 'busy' } : { type: 'idle' }),
        read: (sessionID) => {
          readsAt[sessionID].push(clock.now());
          return new Promise<void>((resolve) => {
            clock.timers.setTimeout(resolve, 10_000);
          });
        },
        nowMs: clock.now(),
      });
    },
    timers: clock.timers,
  });
  await settle();

  // Each cycle: the attempt delivers its frame, stays up, drops, and the
  // stream reconnects 250 ms later (the fast path after a stream with frames).
  for (let i = 0; clock.now() + input.upMs + 250 <= 60_000; i++) {
    channels[i].push(input.frame());
    await settle();
    await clock.advance(input.upMs);
    channels[i].end();
    await settle();
    await clock.advance(250);
  }
  handle.close();
  return {
    dispatchedAt,
    reads: {
      busy: readsAt[busy],
      idleA: readsAt[idleA],
      idleB: readsAt[idleB],
    },
  };
}

describe('stream resync floor and transcript read floor', () => {
  test('a resync the stream holds to the end of its floor still re-reads a transcript whose first read reserved late', async () => {
    const clock = createClock();
    const { client, channels } = createClient();
    const sessionId = 'ses_floor_boundary';
    // Worst case: the first dispatch reserves 2 ms after the stream's stamp,
    // the trailing dispatch reserves with no delay.
    const setupMs = [2, 0];
    const dispatchedAt: number[] = [];
    const reads: boolean[] = [];
    const handle = openEventStream({
      client,
      onEvent: () => {},
      onGapRehydrate: () => {
        dispatchedAt.push(clock.now());
        clock.spend(setupMs[dispatchedAt.length - 1] ?? 0);
        reads.push(reserveMessageRehydrate(sessionId, { urgent: true, nowMs: clock.now() }));
      },
      timers: clock.timers,
    });
    await settle();

    // Attempt 1 carries content and drops. Attempt 2's first frame resyncs.
    channels[0].push(partUpdated('p1'));
    await settle();
    await clock.advance(1016);
    channels[0].end();
    await settle();
    await clock.advance(250);
    channels[1].push(partUpdated('p2'));
    await settle();
    expect(reads).toEqual([true]);

    // Attempt 2 carries content and drops 1 s later. The floor holds attempt
    // 3's resync until 5 s after the first.
    await clock.advance(1000);
    channels[1].end();
    await settle();
    await clock.advance(250);
    channels[2].push(serverConnected());
    await settle();
    expect(reads).toEqual([true]);

    await clock.advance(dispatchedAt[0] + 5_000 - clock.now());

    expect(dispatchedAt).toHaveLength(2);
    expect(dispatchedAt[1] - dispatchedAt[0]).toBe(5_000);
    expect(reads).toEqual([true, true]);

    handle.close();
  });

  test('a flapping busy stream re-reads the running transcript per resync, and idle ones once per 30 s', async () => {
    // Content every attempt; each attempt is up 1 s. Reconnects land every
    // 1.25 s, so the stream's floor spaces resyncs 5 s apart from 1.25 s.
    const { dispatchedAt, reads } = await flapFor60s({
      frame: () => partUpdated('p'),
      upMs: 1_000,
      prefix: 'ses_flap_content',
    });

    expect(dispatchedAt).toEqual([
      1_250, 6_250, 11_250, 16_250, 21_250, 26_250, 31_250, 36_250, 41_250, 46_250, 51_250, 56_250,
    ]);
    // The running session: one read per resync (12), the lost frames of each
    // reconnect are re-read.
    expect(reads.busy).toEqual(dispatchedAt);
    // Idle sessions: the first read (in flight to 11.25 s), then the first
    // resync at least 30 s after it. HEAD of this branch issued 12 each.
    expect(reads.idleA).toEqual([1_250, 31_250]);
    expect(reads.idleB).toEqual([1_250, 31_250]);
  });

  test('a flapping stream with no content re-reads every transcript at most once per 30 s', async () => {
    // Keepalive-only attempts up 6 s: every reconnect is a gap-only resync.
    const { dispatchedAt, reads } = await flapFor60s({
      frame: keepalive,
      upMs: 6_000,
      prefix: 'ses_flap_idle',
    });

    expect(dispatchedAt).toEqual([6_250, 12_500, 18_750, 25_000, 31_250, 37_500, 43_750, 50_000]);
    expect(reads.busy).toEqual([6_250, 37_500]);
    expect(reads.idleA).toEqual([6_250, 37_500]);
    expect(reads.idleB).toEqual([6_250, 37_500]);
  });
});
