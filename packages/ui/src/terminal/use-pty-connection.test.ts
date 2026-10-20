import { describe, expect, mock, test } from 'bun:test';
import type { Terminal as XTerm } from '@xterm/xterm';

/**
 * Characterization tests for the PTY terminal's attach lifecycle (KRTX-460).
 *
 * Before the extraction this code was the 288-line init effect inside
 * `pty-terminal.tsx`: mount dialled after 80 ms with wake intent armed, open
 * consumed it and sent the initial size, socket bytes were sanitized, close
 * reasons classified the next step, and a bare transport drop asked the HTTP
 * path before reconnecting. `apps/web` tests have no DOM and no effect runner,
 * so the only way to characterize that lifecycle is the extracted seam:
 * `startPtyConnection` runs one attach episode as a plain function over ref
 * boxes and a fake `WebSocket`. Each assertion transcribes the pre-refactor
 * behavior of the effect it was moved from.
 */

const realSdk = await import('@kortix/sdk');

let ptyListError: unknown = null;
const listKortixPty = mock(async () => {
  if (ptyListError) throw ptyListError;
  return [];
});
mock.module('@kortix/sdk', () => ({ ...realSdk, listKortixPty }));

const realSdkReact = await import('@kortix/sdk/react');

let wsDials: Array<{ ptyId: string; serverUrl: string | undefined; wake: boolean }> = [];
const getPtyWebSocketUrl = mock(
  async (ptyId: string, serverUrl: string | undefined, opts?: { wake?: boolean }) => {
    wsDials.push({ ptyId, serverUrl, wake: opts?.wake === true });
    return `ws://pty.test/socket/${ptyId}?token=synthetic`;
  },
);
mock.module('@kortix/sdk/react', () => ({ ...realSdkReact, getPtyWebSocketUrl }));

const { startPtyConnection } = await import('./use-pty-connection');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test-side simulation of the far end.
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverMessage(data: string) {
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;

const fakeTerm = {
  cols: 80,
  rows: 24,
  written: [] as string[],
  write(data: string) {
    fakeTerm.written.push(data);
  },
  writeln(data: string) {
    fakeTerm.written.push(data);
  },
};

const ptyFixture = {
  id: 'pty-1',
  title: 'sh',
  command: 'sh',
  args: [],
  cwd: '/tmp',
  status: 'running' as const,
  pid: 42,
};

const ref = <T,>(initial: T) => ({ current: initial });
const flush = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function startLifecycle(termCurrent: unknown = fakeTerm) {
  FakeWebSocket.instances = [];
  wsDials = [];
  ptyListError = null;
  fakeTerm.written = [];

  const refs = {
    // The box is typed at the seam; the runtime object is the FakeWebSocket.
    wsRef: ref<WebSocket | null>(null),
    connectionIdRef: ref(0),
    connectTimeoutRef: ref<NodeJS.Timeout | null>(null),
    reconnectTimeoutRef: ref<NodeJS.Timeout | null>(null),
    disposedRef: ref(false),
    hadErrorRef: ref(false),
    failuresRef: ref(0),
    wakingSinceRef: ref<number | null>(null),
    wakeOnNextConnectRef: ref(true),
    suppressReportsUntilRef: ref(0),
    reconnectNowRef: ref<(() => void) | null>(null),
  };
  const calls = {
    statuses: [] as string[],
    phases: [] as unknown[],
    hasConnected: [] as boolean[],
    unavailable: 0,
    resizes: [] as Array<{ cols: number; rows: number }>,
  };

  const stop = startPtyConnection({
    pty: ptyFixture,
    serverUrl: 'https://pty.test',
    // The fake terminal stands in for the xterm instance at the seam.
    termRef: ref(termCurrent as XTerm | null),
    ...refs,
    showPhase: (phase) => {
      calls.phases.push(phase);
    },
    setHasConnected: (connected) => {
      calls.hasConnected.push(connected);
    },
    updateStatus: (status) => {
      calls.statuses.push(status);
    },
    sendResize: (cols, rows) => {
      calls.resizes.push({ cols, rows });
    },
    onUnavailable: () => {
      calls.unavailable += 1;
    },
  });

  return {
    stop,
    refs,
    calls,
    sockets: () => FakeWebSocket.instances,
    lastSocket: () => FakeWebSocket.instances.at(-1) as FakeWebSocket,
    dials: () => wsDials,
  };
}

describe('startPtyConnection — the mount dial', () => {
  test('dials once after the init delay with wake intent armed', async () => {
    const life = startLifecycle();
    await flush(40);
    expect(life.sockets().length).toBe(0); // nothing before the 80 ms beat
    await flush(120);
    expect(life.sockets().length).toBe(1);
    expect(life.dials()).toEqual([{ ptyId: 'pty-1', serverUrl: 'https://pty.test', wake: true }]);
    expect(life.calls.statuses).toEqual(['connecting']);
    expect(life.calls.phases).toEqual(['connecting']);
    expect(life.calls.hasConnected).toEqual([false]);
    life.stop();
  });

  test('dials nothing when the terminal instance is missing', async () => {
    const life = startLifecycle(null);
    await flush(150);
    expect(life.sockets().length).toBe(0);
    life.stop();
  });
});

describe('startPtyConnection — a live attach', () => {
  test('open consumes the wake intent, reports connected, and sends the initial size', async () => {
    const life = startLifecycle();
    await flush(150);
    life.lastSocket().serverOpen();
    expect(life.calls.statuses.at(-1)).toBe('connected');
    expect(life.calls.phases.at(-1)).toBe(null);
    expect(life.calls.hasConnected.at(-1)).toBe(true);
    expect(life.calls.resizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(life.dials().at(-1)?.wake).toBe(true);
    life.stop();
  });

  test('socket bytes are sanitized before they reach the terminal', async () => {
    const life = startLifecycle();
    await flush(150);
    life.lastSocket().serverOpen();
    life.lastSocket().serverMessage('a\x1b]697;{"cursor":12}\x07b');
    expect(fakeTerm.written.at(-1)).toBe('ab');
    life.stop();
  });

  test('open arms the capability-report suppression window and consumes the wake flag', async () => {
    const life = startLifecycle();
    await flush(150);
    const openedAt = Date.now();
    life.lastSocket().serverOpen();
    // The window is armed on open and lasts ~1.5 s; handleData (the hook) drops
    // report-shaped keystrokes inside it. Real keystrokes are never reports.
    expect(life.refs.suppressReportsUntilRef.current).toBeGreaterThanOrEqual(openedAt + 1500);
    expect(life.refs.wakeOnNextConnectRef.current).toBe(false);
    life.stop();
  });
});

describe('startPtyConnection — close classification', () => {
  test('a pty-not-found close hands the terminal over without reconnecting', async () => {
    const life = startLifecycle();
    await flush(150);
    life.lastSocket().serverClose(1000, 'pty not found');
    expect(life.calls.unavailable).toBe(1);
    expect(life.calls.statuses.at(-1)).toBe('error');
    await flush(1200);
    expect(life.sockets().length).toBe(1); // no replacement dial
    life.stop();
  });

  test('a clean shell exit lands in the buffer and reports disconnected', async () => {
    const life = startLifecycle();
    await flush(150);
    life.lastSocket().serverClose(1000, 'pty exited (0)');
    expect(fakeTerm.written.join('')).toContain('Connection closed (1000): pty exited (0)');
    expect(life.calls.statuses.at(-1)).toBe('disconnected');
    expect(life.calls.phases.at(-1)).toBe(null);
    await flush(1200);
    expect(life.sockets().length).toBe(1);
    life.stop();
  });

  test('a bare transport drop asks the HTTP path, then reconnects with backoff', async () => {
    const life = startLifecycle();
    await flush(150);
    life.lastSocket().serverClose(1006, '');
    // The probe (GET /kortix/pty) answered: the box is reachable, so this is
    // a transport failure with the wake still armed — dial again, still wake.
    await flush(1400);
    expect(life.sockets().length).toBe(2);
    expect(life.dials().at(-1)?.wake).toBe(true);
    life.stop();
  });

  test('a readiness 503 during a wake keeps the wake armed and dials on the wake cadence', async () => {
    const life = startLifecycle();
    await flush(150);
    ptyListError = new Error('sandbox not ready (status: stopped)');
    life.lastSocket().serverClose(1006, '');
    await flush(50); // the attach-failure probe runs after the close returns
    expect(life.calls.phases.at(-1)).toBe('waking');
    await flush(2400);
    expect(life.sockets().length).toBe(2);
    expect(life.dials().at(-1)?.wake).toBe(true);
    life.stop();
  });
});

describe('startPtyConnection — teardown', () => {
  test('teardown clears the dial and the timers without a second socket', async () => {
    const life = startLifecycle();
    await flush(150);
    life.stop();
    await flush(300);
    expect(life.sockets().length).toBe(1);
  });
});
