import { describe, expect, test } from 'bun:test';
import type {
  ReadSessionStreamOptions,
  SessionStreamFrame,
} from '../rest/projects-client/session-stream';
import {
  HEARTBEAT_TIMEOUT_MS,
  connectSessionStream,
  runtimeFrameToOpenCodeEvent,
  type SessionStreamReader,
  type SessionStreamTimers,
} from './session-stream-controller';

// ── fakes ────────────────────────────────────────────────────────────────────

async function tick(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface FakeClock extends SessionStreamTimers {
  advance(ms: number): Promise<void>;
}

function createFakeClock(): FakeClock {
  let time = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; seq: number; fn: () => void }>();
  return {
    now: () => time,
    setTimeout: (handler, ms = 0) => {
      const id = ++seq;
      timers.set(id, { at: time + ms, seq: id, fn: handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      if (handle === undefined) return;
      timers.delete(handle as unknown as number);
    },
    async advance(ms: number): Promise<void> {
      const target = time + ms;
      await tick();
      for (;;) {
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
      await tick();
    },
  };
}

/** One scripted connection attempt: the test pushes frames, then ends/fails it. */
class FakeAttempt {
  readonly cursor: ReadSessionStreamOptions['cursor'];
  private buffer: SessionStreamFrame[] = [];
  private waiter: ((r: IteratorResult<SessionStreamFrame>) => void) | null = null;
  private rejecter: ((e: unknown) => void) | null = null;
  private ended = false;
  private error: unknown = null;
  aborted = false;

  constructor(options?: ReadSessionStreamOptions) {
    this.cursor = options?.cursor;
    options?.signal?.addEventListener('abort', () => {
      this.aborted = true;
      this.end();
    });
  }

  push(frame: SessionStreamFrame): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve({ value: frame, done: false });
      return;
    }
    this.buffer.push(frame);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.waiter) {
      const reject = this.rejecter;
      this.waiter = null;
      this.rejecter = null;
      reject?.(error);
      return;
    }
    this.error = error;
  }

  next(): Promise<IteratorResult<SessionStreamFrame>> {
    if (this.error) {
      const error = this.error;
      this.error = null;
      return Promise.reject(error);
    }
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift()!, done: false });
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.rejecter = reject;
    });
  }
}

function createFakeReader(): { read: SessionStreamReader; attempts: FakeAttempt[] } {
  const attempts: FakeAttempt[] = [];
  async function* read(
    _projectId: string,
    _sessionId: string,
    options?: ReadSessionStreamOptions,
  ): AsyncGenerator<SessionStreamFrame> {
    const attempt = new FakeAttempt(options);
    attempts.push(attempt);
    for (;;) {
      const { value, done } = await attempt.next();
      if (done) return;
      yield value;
    }
  }
  return { read, attempts };
}

const hello = (epoch: string): SessionStreamFrame =>
  ({ channel: 'runtime', type: 'kortix.hello', epoch, head_seq: 0 }) as SessionStreamFrame;

const runtimeFrame = (seq: number, epoch = 'ep1'): SessionStreamFrame =>
  ({
    channel: 'runtime',
    type: 'session.status',
    seq,
    epoch,
    payload: { sessionID: 'ses_x', status: { type: 'busy' } },
    session: 'ses_x',
  }) as SessionStreamFrame;

const controlFrame = (cseq: number, cepoch = 'capi1'): SessionStreamFrame =>
  ({
    channel: 'control',
    type: 'kortix.control.turn',
    cseq,
    cepoch,
    at: 1,
    payload: { known: true, turns: [] },
  }) as SessionStreamFrame;

function connect(
  overrides: Partial<Parameters<typeof connectSessionStream>[0]> = {},
): {
  connection: ReturnType<typeof connectSessionStream>;
  frames: SessionStreamFrame[];
  reader: ReturnType<typeof createFakeReader>;
  clock: FakeClock;
  connectionChanges: boolean[];
} {
  const clock = createFakeClock();
  const reader = createFakeReader();
  const frames: SessionStreamFrame[] = [];
  const connectionChanges: boolean[] = [];
  const connection = connectSessionStream({
    projectId: 'p1',
    sessionId: 's1',
    read: reader.read,
    timers: clock,
    onFrame: (frame) => frames.push(frame),
    onConnectionChange: (connected) => connectionChanges.push(connected),
    ...overrides,
  });
  return { connection, frames, reader, clock, connectionChanges };
}

// ── the contract ─────────────────────────────────────────────────────────────

describe('connectSessionStream', () => {
  test('forwards frames in order and tracks both cursors from seq/cseq frames', async () => {
    const { connection, frames, reader } = connect();
    await tick();
    const attempt = reader.attempts[0];
    attempt.push(hello('ep1'));
    attempt.push(controlFrame(1));
    attempt.push(runtimeFrame(7));
    attempt.push(controlFrame(2));
    await tick();

    expect(frames.map((f) => f.type)).toEqual([
      'kortix.hello',
      'kortix.control.turn',
      'session.status',
      'kortix.control.turn',
    ]);
    expect(connection.cursor()).toEqual({ epoch: 'ep1', seq: 7, cepoch: 'capi1', cseq: 2 });
    connection.close();
  });

  test('hello / heartbeat / resync never advance the runtime cursor', async () => {
    const { connection, reader } = connect();
    await tick();
    const attempt = reader.attempts[0];
    attempt.push(runtimeFrame(3));
    attempt.push({ channel: 'runtime', type: 'kortix.heartbeat', at: 1 } as SessionStreamFrame);
    attempt.push({ channel: 'stream', type: 'kortix.stream.heartbeat' } as SessionStreamFrame);
    await tick();
    expect(connection.cursor().seq).toBe(3);
    connection.close();
  });

  test('reconnects after a delivered stream ends: fast 250ms, resuming at the cursor', async () => {
    const { connection, reader, clock } = connect();
    await tick();
    reader.attempts[0].push(runtimeFrame(5));
    reader.attempts[0].push(controlFrame(4));
    await tick();
    reader.attempts[0].end();
    await tick();
    expect(reader.attempts.length).toBe(1);
    await clock.advance(250);
    expect(reader.attempts.length).toBe(2);
    expect(reader.attempts[1].cursor).toEqual({
      epoch: 'ep1',
      seq: 5,
      cepoch: 'capi1',
      cseq: 4,
    });
    connection.close();
  });

  test('frameless attempts back off exponentially, are reset by delivery, and never park', async () => {
    const { connection, reader, clock } = connect();
    await tick();
    reader.attempts[0].fail(new Error('boom'));
    await tick();
    expect(reader.attempts.length).toBe(1);
    await clock.advance(1000); // first retry after 1s
    expect(reader.attempts.length).toBe(2);
    reader.attempts[1].fail(new Error('boom'));
    await clock.advance(1999);
    expect(reader.attempts.length).toBe(2); // second retry waits 2s
    await clock.advance(1);
    expect(reader.attempts.length).toBe(3);
    // Never parks: after MANY failures it still retries, capped at 30s.
    for (let i = 3; i < 15; i++) {
      reader.attempts[i - 1].fail(new Error('boom'));
      await clock.advance(30_000);
      expect(reader.attempts.length).toBe(i + 1);
    }
    // A delivered frame resets the backoff to the fast path.
    reader.attempts[14].push(runtimeFrame(1));
    await tick();
    reader.attempts[14].end();
    await clock.advance(250);
    expect(reader.attempts.length).toBe(16);
    connection.close();
  });

  test('runtime kortix.resync drops the seq, adopts the resync epoch and reports the reason', async () => {
    const resyncs: Array<{ reason: string | null; epochChanged: boolean }> = [];
    const { connection, reader } = connect({
      onRuntimeResync: (info) => resyncs.push(info),
    });
    await tick();
    const attempt = reader.attempts[0];
    attempt.push(runtimeFrame(9));
    attempt.push({
      channel: 'runtime',
      type: 'kortix.resync',
      reason: 'epoch-changed',
      epoch: 'ep2',
      first_seq: 1,
      head_seq: 3,
    } as SessionStreamFrame);
    await tick();
    expect(resyncs).toEqual([{ reason: 'epoch-changed', epochChanged: true }]);
    expect(connection.cursor().seq).toBeNull();
    expect(connection.cursor().epoch).toBe('ep2');
    // Live frames after the resync re-establish the cursor.
    attempt.push(runtimeFrame(2, 'ep2'));
    await tick();
    expect(connection.cursor()).toMatchObject({ epoch: 'ep2', seq: 2 });
    connection.close();
  });

  test('a hello carrying a NEW epoch drops the stored seq before anything is applied', async () => {
    const { connection, reader } = connect({
      cursor: { epoch: 'ep1', seq: 40 },
    });
    await tick();
    reader.attempts[0].push(hello('ep2'));
    await tick();
    expect(connection.cursor().seq).toBeNull();
    expect(connection.cursor().epoch).toBe('ep2');
    connection.close();
  });

  test('a dense-seq gap fires onRuntimeGap; consecutive seqs do not', async () => {
    const gaps: Array<{ fromSeq: number; toSeq: number }> = [];
    const { connection, reader } = connect({
      onRuntimeGap: (info) => gaps.push({ fromSeq: info.fromSeq, toSeq: info.toSeq }),
    });
    await tick();
    const attempt = reader.attempts[0];
    attempt.push(runtimeFrame(1));
    attempt.push(runtimeFrame(2));
    attempt.push(runtimeFrame(5));
    await tick();
    expect(gaps).toEqual([{ fromSeq: 2, toSeq: 5 }]);
    // A gap across an epoch change is a resync's business, not a gap.
    attempt.push(runtimeFrame(90, 'ep9'));
    await tick();
    expect(gaps.length).toBe(1);
    connection.close();
  });

  test('control kortix.control.resync drops the cseq; following snapshots re-establish it', async () => {
    const { connection, reader } = connect({
      cursor: { cepoch: 'capi0', cseq: 12 },
    });
    await tick();
    const attempt = reader.attempts[0];
    attempt.push({
      channel: 'control',
      type: 'kortix.control.resync',
      cepoch: 'capi1',
      reason: 'epoch-changed',
    } as SessionStreamFrame);
    await tick();
    expect(connection.cursor().cseq).toBeNull();
    expect(connection.cursor().cepoch).toBe('capi1');
    attempt.push(controlFrame(1, 'capi1'));
    await tick();
    expect(connection.cursor()).toMatchObject({ cepoch: 'capi1', cseq: 1 });
    connection.close();
  });

  test('the heartbeat watchdog aborts a silent attempt and reconnects', async () => {
    const { connection, reader, clock } = connect();
    await tick();
    reader.attempts[0].push(runtimeFrame(1));
    await tick();
    expect(reader.attempts[0].aborted).toBe(false);
    await clock.advance(HEARTBEAT_TIMEOUT_MS + 1);
    expect(reader.attempts[0].aborted).toBe(true);
    await clock.advance(250);
    expect(reader.attempts.length).toBe(2);
    expect(reader.attempts[1].cursor).toMatchObject({ epoch: 'ep1', seq: 1 });
    connection.close();
  });

  test('close() tears everything down and stops reconnecting', async () => {
    const { connection, reader, clock, connectionChanges } = connect();
    await tick();
    reader.attempts[0].push(runtimeFrame(1));
    await tick();
    connection.close();
    await tick();
    expect(reader.attempts[0].aborted).toBe(true);
    await clock.advance(120_000);
    expect(reader.attempts.length).toBe(1);
    expect(connectionChanges).toEqual([true, false]);
  });

  test('a throwing onFrame handler never breaks the stream', async () => {
    const seen: string[] = [];
    const { connection, reader } = connect({
      onFrame: (frame) => {
        seen.push(frame.type);
        if (frame.type === 'kortix.hello') throw new Error('handler bug');
      },
    });
    await tick();
    reader.attempts[0].push(hello('ep1'));
    reader.attempts[0].push(runtimeFrame(1));
    await tick();
    expect(seen).toEqual(['kortix.hello', 'session.status']);
    connection.close();
  });

  test('onConnectionChange fires true on the first frame and false when the attempt ends', async () => {
    const { connection, reader, clock, connectionChanges } = connect();
    await tick();
    expect(connectionChanges).toEqual([]);
    reader.attempts[0].push(runtimeFrame(1));
    await tick();
    expect(connectionChanges).toEqual([true]);
    reader.attempts[0].end();
    await tick();
    expect(connectionChanges).toEqual([true, false]);
    await clock.advance(250);
    reader.attempts[1].push(runtimeFrame(2));
    await tick();
    expect(connectionChanges).toEqual([true, false, true]);
    connection.close();
  });
});

describe('runtimeFrameToOpenCodeEvent', () => {
  test('maps payload → properties verbatim, keeping the type', () => {
    const event = runtimeFrameToOpenCodeEvent({
      channel: 'runtime',
      type: 'message.part.updated',
      seq: 3,
      epoch: 'ep1',
      payload: { part: { id: 'prt_1' } },
      session: 'ses_x',
    } as SessionStreamFrame & { channel: 'runtime' });
    expect(event).toEqual({
      type: 'message.part.updated',
      properties: { part: { id: 'prt_1' } },
    } as never);
  });

  test('hello / resync / heartbeat map to null — they are not runtime events', () => {
    for (const type of ['kortix.hello', 'kortix.resync', 'kortix.heartbeat']) {
      expect(
        runtimeFrameToOpenCodeEvent({ channel: 'runtime', type } as SessionStreamFrame & {
          channel: 'runtime';
        }),
      ).toBeNull();
    }
  });
});
