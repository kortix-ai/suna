import { describe, expect, test } from 'bun:test';

import {
  PTY_KEEPALIVE_MS,
  PTY_MAX_RECONNECTS,
  PtySession,
  type PtySessionState,
  type PtySocket,
  type PtyTimers,
  ptyBackoffMs,
  ptyPanelTitle,
} from './pty-session.ts';

/** A clock the test advances by hand. Nothing here waits on wall time. */
class FakeTimers implements PtyTimers {
  now = 0;
  private id = 1;
  private readonly timeouts = new Map<number, { at: number; fn: () => void }>();
  private readonly intervals = new Map<number, { every: number; next: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.id++;
    this.timeouts.set(handle, { at: this.now + ms, fn });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const handle = this.id++;
    this.intervals.set(handle, { every: ms, next: this.now + ms, fn });
    return handle;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  /** Move the clock and run everything that comes due. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [
        ...[...this.timeouts.entries()].map(([h, t]) => ({
          at: t.at,
          run: () => {
            this.timeouts.delete(h);
            t.fn();
          },
        })),
        ...[...this.intervals.entries()].map(([, i]) => ({
          at: i.next,
          run: () => {
            i.next += i.every;
            i.fn();
          },
        })),
      ]
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next) break;
      this.now = next.at;
      next.run();
    }
    this.now = target;
  }

  get pendingTimeouts(): number {
    return this.timeouts.size;
  }
  get pendingIntervals(): number {
    return this.intervals.size;
  }
}

class FakeSocket implements PtySocket {
  binaryType = 'blob';
  readyState = 0;
  sent: (string | ArrayBufferView | ArrayBuffer)[] = [];
  pings = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  ping(): void {
    this.pings += 1;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

interface Harness {
  timers: FakeTimers;
  sockets: FakeSocket[];
  states: PtySessionState[];
  output: string[];
  urls: { wake: boolean }[];
  session: PtySession;
}

function harness(overrides: { maxReconnects?: number } = {}): Harness {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const states: PtySessionState[] = [];
  const output: string[] = [];
  const urls: { wake: boolean }[] = [];
  const session = new PtySession({
    resolveUrl: async (options) => {
      urls.push(options);
      return `ws://pty.test/${urls.length}`;
    },
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onOutput: (text) => output.push(text),
    onState: (state) => states.push(state),
    timers,
    ...overrides,
  });
  return { timers, sockets, states, output, urls, session };
}

/** `resolveUrl` is async, so one microtask turn separates `start()` from the socket. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('backoff', () => {
  test('is 1s, 2s, 4s, 8s and then capped at 10s', () => {
    expect([1, 2, 3, 4, 5, 6, 99].map(ptyBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
  });
});

describe('panel title', () => {
  test('names the phase and the attempt', () => {
    const base = { attempt: 0, reason: null, needsReplacement: false };
    expect(ptyPanelTitle({ ...base, phase: 'connecting' })).toBe('Terminal · connecting');
    expect(ptyPanelTitle({ ...base, phase: 'connected' })).toBe('Terminal · connected');
    expect(ptyPanelTitle({ ...base, phase: 'reconnecting', attempt: 3 })).toBe(
      'Terminal · reconnecting (3)',
    );
    expect(ptyPanelTitle({ ...base, phase: 'closed' })).toBe('Terminal · closed');
  });
});

// The close classifier and the output sanitizer are the SDK's
// (`classifyPtyClose` / `sanitizePtyChunk`, `packages/sdk/src/core/runtime/pty.ts`,
// covered by `pty.test.ts` there). `PtySession` below exercises them through
// the close handler rather than re-asserting their table here.

describe('PtySession', () => {
  test('open → connected, and the first dial arms the sandbox wake', async () => {
    const h = harness();
    h.session.start();
    expect(h.session.state.phase).toBe('connecting');
    await flush();
    expect(h.urls).toEqual([{ wake: true }]);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]?.binaryType).toBe('arraybuffer');

    h.sockets[0]?.open();
    expect(h.session.state).toEqual({
      phase: 'connected',
      attempt: 0,
      reason: null,
      needsReplacement: false,
    });
  });

  test('output is sanitized and handed to the emulator', async () => {
    const h = harness();
    h.session.start();
    await flush();
    h.sockets[0]?.open();
    h.sockets[0]?.message(
      new TextEncoder().encode('\x1b]697;A=1\x07kortix@sandbox:/workspace$ ').buffer,
    );
    expect(h.output).toEqual(['kortix@sandbox:/workspace$ ']);
  });

  test('keystrokes reach the socket only while it is open', async () => {
    const h = harness();
    h.session.start();
    await flush();
    const socket = h.sockets[0] as FakeSocket;
    h.session.send('before-open');
    expect(socket.sent).toHaveLength(0);
    socket.open();
    h.session.send(new TextEncoder().encode('echo hi\r'));
    expect(socket.sent).toHaveLength(1);
  });

  test('a close reconnects on the backoff sequence, and each retry drops the wake flag', async () => {
    const h = harness();
    h.session.start();
    await flush();
    h.sockets[0]?.open();
    h.sockets[0]?.drop(1006, '');

    expect(h.session.state.phase).toBe('reconnecting');
    expect(h.session.state.attempt).toBe(1);

    // Nothing dials before the backoff elapses.
    h.timers.advance(999);
    expect(h.sockets).toHaveLength(1);
    h.timers.advance(1);
    await flush();
    expect(h.sockets).toHaveLength(2);
    // The wake was consumed by the successful open; a background retry must
    // not resurrect a box nobody asked for.
    expect(h.urls[1]).toEqual({ wake: false });

    h.sockets[1]?.drop(1006, '');
    expect(h.session.state.attempt).toBe(2);
    h.timers.advance(2_000);
    await flush();
    expect(h.sockets).toHaveLength(3);

    h.sockets[2]?.drop(1006, '');
    h.timers.advance(4_000);
    await flush();
    expect(h.sockets).toHaveLength(4);

    h.sockets[3]?.drop(1006, '');
    h.timers.advance(8_000);
    await flush();
    expect(h.sockets).toHaveLength(5);
  });

  test('five failed reconnects stop at closed', async () => {
    const h = harness();
    h.session.start();
    await flush();
    h.sockets[0]?.open();

    for (let attempt = 1; attempt <= PTY_MAX_RECONNECTS; attempt += 1) {
      h.sockets.at(-1)?.drop(1006, '');
      expect(h.session.state.phase).toBe('reconnecting');
      expect(h.session.state.attempt).toBe(attempt);
      h.timers.advance(ptyBackoffMs(attempt));
      await flush();
    }
    expect(h.sockets).toHaveLength(PTY_MAX_RECONNECTS + 1);

    h.sockets.at(-1)?.drop(1006, 'upstream error');
    expect(h.session.state.phase).toBe('closed');
    expect(h.session.state.reason).toBe('upstream error');
    expect(h.timers.pendingTimeouts).toBe(0);
  });

  test('a clean shell exit closes without reconnecting', async () => {
    const h = harness();
    h.session.start();
    await flush();
    h.sockets[0]?.open();
    h.sockets[0]?.drop(1000, 'pty exited');
    expect(h.session.state.phase).toBe('closed');
    h.timers.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  test('a lost pty id asks for a replacement instead of reconnecting', async () => {
    const h = harness();
    h.session.start();
    await flush();
    h.sockets[0]?.open();
    h.sockets[0]?.drop(1000, 'pty not found');
    expect(h.session.state).toMatchObject({ phase: 'closed', needsReplacement: true });
  });

  test('the keepalive pings on the API proxy cadence, and only while open', async () => {
    const h = harness();
    h.session.start();
    await flush();
    const socket = h.sockets[0] as FakeSocket;
    expect(h.timers.pendingIntervals).toBe(0);

    socket.open();
    expect(h.timers.pendingIntervals).toBe(1);
    h.timers.advance(PTY_KEEPALIVE_MS - 1);
    expect(socket.pings).toBe(0);
    h.timers.advance(1);
    expect(socket.pings).toBe(1);
    h.timers.advance(PTY_KEEPALIVE_MS * 3);
    expect(socket.pings).toBe(4);
    // A ping is a CONTROL frame. Nothing may ever be sent as data: an upstream
    // byte is typed into the user's live shell.
    expect(socket.sent).toHaveLength(0);

    socket.drop(1006, '');
    expect(h.timers.pendingIntervals).toBe(0);
  });

  test('reconnectNow skips the armed backoff and re-arms the wake', async () => {
    const h = harness();
    h.session.start();
    await flush();
    h.sockets[0]?.open();
    h.sockets[0]?.drop(1006, '');
    expect(h.timers.pendingTimeouts).toBe(1);

    h.session.reconnectNow();
    await flush();
    expect(h.timers.pendingTimeouts).toBe(0);
    expect(h.sockets).toHaveLength(2);
    expect(h.urls[1]).toEqual({ wake: true });
    expect(h.session.state.attempt).toBe(0);
  });

  test('close() stops every timer and silences the old socket', async () => {
    const h = harness();
    h.session.start();
    await flush();
    const socket = h.sockets[0] as FakeSocket;
    socket.open();
    h.session.close();

    expect(socket.closed).toBe(true);
    expect(h.session.state.phase).toBe('closed');
    expect(h.timers.pendingIntervals).toBe(0);
    // A close that arrives after teardown must not restart anything.
    socket.onclose?.({ code: 1006, reason: '' });
    h.timers.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  test('a resolve failure is a reconnectable attempt, not a crash', async () => {
    const timers = new FakeTimers();
    const errors: unknown[] = [];
    const states: PtySessionState[] = [];
    let calls = 0;
    const session = new PtySession({
      resolveUrl: async () => {
        calls += 1;
        throw new Error('sandbox not ready');
      },
      openSocket: () => {
        throw new Error('must not open');
      },
      onOutput: () => {},
      onState: (state) => states.push(state),
      onError: (error) => errors.push(error),
      timers,
    });
    session.start();
    await flush();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(session.state).toMatchObject({ phase: 'reconnecting', attempt: 1 });
    expect(session.state.reason).toBe('sandbox not ready');
  });
});
