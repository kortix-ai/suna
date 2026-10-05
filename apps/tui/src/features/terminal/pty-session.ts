/**
 * The PTY WebSocket state machine.
 *
 * Framing, verbatim from `apps/cli/src/commands/sessions-shell.ts` (the one
 * working raw attach) and `apps/web/src/features/session/pty-terminal.tsx`:
 *
 *   - Output: raw bytes, server → client. No envelope, no JSON.
 *   - Input:  raw bytes, client → server. No envelope, no JSON.
 *   - Resize: NOT a socket frame. `PATCH /kortix/pty/:id { size }` over HTTP
 *     (`updateKortixPty`). The panel owns that call; this file never resizes.
 *
 * Keepalive: the API proxy pings BOTH legs every 25 s
 * (`PREVIEW_WS_KEEPALIVE_MS`, `apps/api/src/sandbox-proxy/ws-proxy.ts:99`).
 * That server-side ping is what fixed the 60 s idle cut (PR #7062). A client
 * keepalive can only be a PING control frame — it terminates at the API and
 * never reaches the sandbox leg — so it is a belt on the client↔API hop only,
 * and it is off by default in the emulator's sense: NOTHING may inject a data
 * byte, because every upstream byte is typed into the user's live shell.
 *
 * Everything here is injectable: the URL resolver, the socket factory, the
 * timers, and the clock. That is what makes the backoff sequence, the failure
 * ceiling, and the keepalive cadence testable without a sandbox.
 *
 * The two ATTACH-SIDE rules — what a close means, and which bytes a VT
 * emulator must never print — are the SDK's, not this file's:
 * `classifyPtyClose` and `sanitizePtyChunk`
 * (`packages/sdk/src/core/runtime/pty.ts`) are the one copy every host shares,
 * so a reconnect rule cannot drift between apps/web, apps/cli and here.
 */

import { classifyPtyClose, sanitizePtyChunk } from '@kortix/sdk';

/** What the panel title says. */
export type PtyPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface PtySessionState {
  phase: PtyPhase;
  /** Reconnect attempts spent since the last successful open. 0 while connected. */
  attempt: number;
  /** Why the last socket closed, for the panel's detail line. */
  reason: string | null;
  /** The daemon no longer owns this PTY id — reconnecting can never work. */
  needsReplacement: boolean;
}

/** 1 s, 2 s, 4 s, 8 s, then the 10 s cap. Five entries = five reconnects. */
export const PTY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 10_000];
export const PTY_MAX_RECONNECTS = PTY_BACKOFF_MS.length;
/** Matches the API proxy's own cadence. */
export const PTY_KEEPALIVE_MS = 25_000;

/** Backoff for the nth reconnect (1-based). Clamped to the 10 s cap. */
export function ptyBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), PTY_BACKOFF_MS.length) - 1;
  return PTY_BACKOFF_MS[index] as number;
}

/** The panel's title. One string, so the state is always visible. */
export function ptyPanelTitle(state: PtySessionState): string {
  switch (state.phase) {
    case 'connected':
      return 'Terminal · connected';
    case 'reconnecting':
      return `Terminal · reconnecting (${state.attempt})`;
    case 'closed':
      return 'Terminal · closed';
    default:
      return 'Terminal · connecting';
  }
}

/** The subset of `WebSocket` this file drives. Bun's client satisfies it. */
export interface PtySocket {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  /** Bun's client sends a PING control frame. Absent on a plain fake. */
  ping?: (data?: string | ArrayBufferView | ArrayBuffer) => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export const PTY_SOCKET_OPEN = 1;

export interface PtyTimerHandle {
  readonly __ptyTimer?: never;
}

export interface PtyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: PtyTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface PtySessionOptions {
  /**
   * Resolve the socket URL for this attempt. `wake: true` marks a
   * USER-INITIATED attach, which is the only kind the API resumes a parked
   * sandbox for (`getKortixPtyWebSocketUrl`). A background retry must not
   * resurrect a box nobody asked for, so the flag is armed on `start()` /
   * `reconnectNow()` and consumed by the first successful open.
   */
  resolveUrl(options: { wake: boolean }): Promise<string>;
  openSocket(url: string): PtySocket;
  /** Sanitized terminal output, ready for `EmbeddedTerminalRenderable.write`. */
  onOutput(text: string): void;
  onState(state: PtySessionState): void;
  /** A resolve/open throw, for the panel's detail line. */
  onError?(error: unknown): void;
  timers?: PtyTimers;
  maxReconnects?: number;
  keepaliveMs?: number;
  backoffMs?(attempt: number): number;
}

/**
 * One PTY attach, with reconnect. Own it per `(ptyId, runtimeUrl)` pair and
 * `close()` it when either changes — a stale generation never writes.
 */
export class PtySession {
  private readonly options: PtySessionOptions;
  private readonly timers: PtyTimers;
  private readonly maxReconnects: number;
  private readonly keepaliveMs: number;
  private readonly backoff: (attempt: number) => number;

  private socket: PtySocket | null = null;
  private generation = 0;
  private disposed = false;
  private hadError = false;
  private wakeArmed = true;
  private retryHandle: unknown = null;
  private keepaliveHandle: unknown = null;
  /** Splits multi-byte UTF-8 across chunks instead of corrupting it. */
  private readonly decoder = new TextDecoder();

  private current: PtySessionState = {
    phase: 'idle',
    attempt: 0,
    reason: null,
    needsReplacement: false,
  };

  constructor(options: PtySessionOptions) {
    this.options = options;
    this.timers = options.timers ?? REAL_TIMERS;
    this.maxReconnects = options.maxReconnects ?? PTY_MAX_RECONNECTS;
    this.keepaliveMs = options.keepaliveMs ?? PTY_KEEPALIVE_MS;
    this.backoff = options.backoffMs ?? ptyBackoffMs;
  }

  get state(): PtySessionState {
    return this.current;
  }

  /** First dial. Idempotent: a second call while live is a no-op. */
  start(): void {
    if (this.disposed || this.current.phase !== 'idle') return;
    this.wakeArmed = true;
    this.setState({ phase: 'connecting', attempt: 0, reason: null, needsReplacement: false });
    void this.dial();
  }

  /** A person asked for the shell back: skip the armed retry and dial now. */
  reconnectNow(): void {
    if (this.disposed) return;
    this.clearRetry();
    this.dropSocket();
    this.wakeArmed = true;
    this.setState({ phase: 'connecting', attempt: 0, reason: null, needsReplacement: false });
    void this.dial();
  }

  /** Keystrokes. Dropped while the socket is not open — a shell is not a queue. */
  send(data: string | Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== PTY_SOCKET_OPEN) return;
    socket.send(data as string | ArrayBufferView);
  }

  /** Tear down for good. Every path out of the panel calls this. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRetry();
    this.stopKeepalive();
    this.dropSocket();
    this.setState({ ...this.current, phase: 'closed' });
  }

  private setState(next: PtySessionState): void {
    this.current = next;
    this.options.onState(next);
  }

  private clearRetry(): void {
    if (this.retryHandle === null) return;
    this.timers.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private stopKeepalive(): void {
    if (this.keepaliveHandle === null) return;
    this.timers.clearInterval(this.keepaliveHandle);
    this.keepaliveHandle = null;
  }

  /** Detach the handlers first, so a close we caused never re-enters. */
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // A socket that refuses close is already gone.
    }
  }

  private async dial(): Promise<void> {
    if (this.disposed) return;
    this.generation += 1;
    const generation = this.generation;
    this.hadError = false;
    const wake = this.wakeArmed;

    let url: string;
    try {
      url = await this.options.resolveUrl({ wake });
    } catch (error) {
      if (this.isStale(generation)) return;
      this.options.onError?.(error);
      this.scheduleRetry(errorMessage(error));
      return;
    }
    if (this.isStale(generation)) return;

    let socket: PtySocket;
    try {
      socket = this.options.openSocket(url);
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleRetry(errorMessage(error));
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      if (this.isStale(generation)) return;
      // Consumed only now: the attach succeeded, so the box is awake and a
      // later drop has nothing left to wake.
      this.wakeArmed = false;
      this.setState({ phase: 'connected', attempt: 0, reason: null, needsReplacement: false });
      this.startKeepalive(generation);
    };

    socket.onmessage = (event) => {
      if (this.isStale(generation)) return;
      const text = this.decodeChunk(event.data);
      if (text) this.options.onOutput(sanitizePtyChunk(text));
    };

    socket.onerror = () => {
      if (this.isStale(generation)) return;
      // A WebSocket error event carries no detail. The close that follows is
      // what decides the next step; this only records that one happened.
      this.hadError = true;
    };

    socket.onclose = (event) => {
      if (this.isStale(generation)) return;
      this.stopKeepalive();
      this.socket = null;
      const action = classifyPtyClose({
        code: event.code,
        reason: event.reason ?? '',
        hadError: this.hadError,
      });
      const reason = event.reason || `code ${event.code}`;
      if (action === 'replace') {
        this.setState({ phase: 'closed', attempt: 0, reason, needsReplacement: true });
        return;
      }
      if (action === 'ended') {
        this.setState({ phase: 'closed', attempt: 0, reason, needsReplacement: false });
        return;
      }
      this.scheduleRetry(reason);
    };
  }

  private startKeepalive(generation: number): void {
    this.stopKeepalive();
    if (this.keepaliveMs <= 0) return;
    this.keepaliveHandle = this.timers.setInterval(() => {
      if (this.isStale(generation)) return;
      const socket = this.socket;
      if (!socket || socket.readyState !== PTY_SOCKET_OPEN) return;
      try {
        // A PING control frame only. Never a data byte: an upstream byte is
        // typed into the user's shell.
        socket.ping?.();
      } catch {
        // A socket that rejects a ping is closing; its close handler cleans up.
      }
    }, this.keepaliveMs);
  }

  private scheduleRetry(reason: string): void {
    const attempt = this.current.attempt + 1;
    if (attempt > this.maxReconnects) {
      this.setState({
        phase: 'closed',
        attempt: this.current.attempt,
        reason,
        needsReplacement: false,
      });
      return;
    }
    this.setState({ phase: 'reconnecting', attempt, reason, needsReplacement: false });
    this.clearRetry();
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      void this.dial();
    }, this.backoff(attempt));
  }

  private isStale(generation: number): boolean {
    return this.disposed || this.generation !== generation;
  }

  private decodeChunk(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) {
      return this.decoder.decode(new Uint8Array(data), { stream: true });
    }
    if (ArrayBuffer.isView(data)) {
      return this.decoder.decode(data as ArrayBufferView, { stream: true });
    }
    return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
