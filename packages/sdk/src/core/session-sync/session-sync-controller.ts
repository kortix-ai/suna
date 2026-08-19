import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';

/**
 * Messages per bounded read — the newest-first window a session opens with,
 * and the step size when the transcript pulls older history.
 *
 * OpenCode carries tool output as *parts* of the assistant message, so a page
 * is roughly half as many turns as it is messages: 50 covers ~25 turns, which
 * is a whole ordinary session. That is the point — most sessions now open
 * fully loaded and never pull at all, while a long one still opens bounded
 * instead of dragging its entire history over the sandbox proxy.
 */
export const SESSION_SYNC_PAGE_SIZE = 50;

export type SessionSyncFreshness = 'idle' | 'loading' | 'fresh' | 'stale' | 'error';

export interface SessionSyncMessage {
  info: Message;
  parts: Part[];
}

export interface SessionSyncPage {
  messages: SessionSyncMessage[];
  nextCursor?: string;
}

/**
 * Transcript state, and nothing else.
 *
 * This snapshot used to carry `isPromptObservedBusy` — a busy OPINION inferred
 * from silence by a phase machine with a stall timer, a retry budget and an
 * epoch counter. It was one of four disagreeing answers to "is this session
 * working?", and the one that latched: every signal that could release it
 * (`session.idle`, a status frame, the poll) can be lost, and losing them left
 * the composer pinned on "stop" until the user reloaded. The answer now comes
 * from `projectWorking` over the server's own turn authority
 * (`core/session/working.ts`), so this controller holds no opinion about it.
 */
export interface SessionSyncSnapshot {
  freshness: SessionSyncFreshness;
  hasOlder: boolean;
  isLoadingOlder: boolean;
}

export interface SessionSyncScheduler {
  now: () => number;
  setInterval: (handler: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout?: (handler: () => void, timeoutMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type SessionSyncReason =
  'initial' | 'poll' | 'sse-gap' | 'compaction' | 'session-error' | 'send-recovery' | 'manual';

export interface SessionSyncTelemetryEvent {
  operation: 'tail' | 'older';
  reason: SessionSyncReason;
  durationMs: number;
  messageCount: number;
  succeeded: boolean;
}

export interface SessionSyncControllerOptions {
  sessionId: string;
  loadPage: (request: { limit: number; before?: string }) => Promise<SessionSyncPage>;
  /**
   * @deprecated Never called. The liveness poll no longer reads status: `GET
   * .../turn` is the status authority, and this controller's own `setBusy` is
   * already driven FROM that projection, so a status read here could only
   * confirm or latch — never correct. Retained (ignored) because 0.12.8
   * published it on this options type; removed in the next major.
   */
  loadStatus?: () => Promise<SessionStatus>;
  hydrate: (messages: SessionSyncMessage[]) => void;
  markLoaded: () => void;
  /**
   * @deprecated Never called. Writing a REST poll's answer into the slot SSE
   * status frames land in made a poll indistinguishable from the runtime's own
   * voice, and re-stamped the stream observation on every tick so its age
   * bound was never reached. Retained (ignored) because 0.12.8 published it;
   * removed in the next major.
   */
  setStatus?: (status: SessionStatus) => void;
  onTelemetry?: (event: SessionSyncTelemetryEvent) => void;
  scheduler?: SessionSyncScheduler;
  livenessIntervalMs?: number;
}

export interface HttpSessionSyncControllerOptions extends Pick<
  SessionSyncControllerOptions,
  | 'sessionId'
  | 'hydrate'
  | 'markLoaded'
  | 'setStatus'
  | 'onTelemetry'
  | 'scheduler'
  | 'livenessIntervalMs'
> {
  baseUrl: string;
  getToken?: () => string | null | Promise<string | null>;
  fetch?: SessionSyncFetch;
}

export type SessionSyncFetch = (input: string, init?: RequestInit) => Promise<Response>;

type HttpSessionSyncSourceOptions = Pick<
  HttpSessionSyncControllerOptions,
  'baseUrl' | 'sessionId' | 'getToken' | 'fetch'
>;

export function createHttpSessionSyncPageLoader(
  options: HttpSessionSyncSourceOptions,
): SessionSyncControllerOptions['loadPage'] {
  const fetchImpl: SessionSyncFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  return async ({ limit, before }) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    const token = await options.getToken?.();
    const response = await fetchImpl(
      `${baseUrl}/session/${encodeURIComponent(options.sessionId)}/message?${query}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
    );
    if (!response.ok) {
      throw new Error(`Session synchronization failed: ${response.status}`);
    }
    return {
      messages: (await response.json()) as SessionSyncMessage[],
      nextCursor: response.headers.get('x-next-cursor') || undefined,
    };
  };
}

export function loadHttpSessionHistory(
  options: HttpSessionSyncSourceOptions,
): Promise<SessionSyncMessage[]> {
  return loadCompleteSessionHistory(createHttpSessionSyncPageLoader(options));
}

export function createHttpSessionSyncController(
  options: HttpSessionSyncControllerOptions,
): SessionSyncController {
  // No `loadStatus` any more: the controller never reads status, so the
  // `/session/status` request this used to build was dead weight on every
  // liveness tick. The transcript tail is the whole of this controller's job.
  return new SessionSyncController({
    ...options,
    loadPage: createHttpSessionSyncPageLoader(options),
  });
}

export async function loadCompleteSessionHistory(
  loadPage: SessionSyncControllerOptions['loadPage'],
): Promise<SessionSyncMessage[]> {
  const messages = new Map<string, SessionSyncMessage>();
  const cursors = new Set<string>();
  let before: string | undefined;
  do {
    const page = await loadPage({
      limit: SESSION_SYNC_PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    for (const message of page.messages) {
      messages.set(message.info.id, message);
    }
    before = page.nextCursor;
    if (before && cursors.has(before)) {
      throw new Error(`Session history cursor repeated: ${before}`);
    }
    if (before) cursors.add(before);
  } while (before);
  return [...messages.values()].sort((a, b) => a.info.id.localeCompare(b.info.id));
}

const defaultScheduler: SessionSyncScheduler = {
  now: Date.now,
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns bounded session history synchronization without depending on React,
 * Zustand, IndexedDB, or a specific HTTP client.
 */
export class SessionSyncController {
  private readonly options: SessionSyncControllerOptions;
  private readonly scheduler: SessionSyncScheduler;
  private readonly livenessIntervalMs: number;
  private snapshot: SessionSyncSnapshot = {
    freshness: 'idle',
    hasOlder: false,
    isLoadingOlder: false,
  };
  private nextCursor: string | undefined;
  private knownUserMessageIds = new Set<string>();
  private olderHistoryStarted = false;
  private tailRequest: Promise<void> | undefined;
  private olderRequest: Promise<void> | undefined;
  private livenessTimer: unknown;
  private lastActivityAt: number;
  private listeners = new Set<() => void>();
  private destroyed = false;

  constructor(options: SessionSyncControllerOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.livenessIntervalMs = options.livenessIntervalMs ?? 10_000;
    this.lastActivityAt = this.scheduler.now();
  }

  getSnapshot = (): SessionSyncSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): Promise<void> {
    if (this.snapshot.freshness === 'fresh') return Promise.resolve();
    return this.reconcile('initial');
  }

  reconcile(reason: SessionSyncReason = 'manual'): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.tailRequest) return this.tailRequest;
    this.update({
      freshness: this.snapshot.freshness === 'idle' ? 'loading' : 'stale',
    });
    this.tailRequest = this.loadTail(reason).finally(() => {
      this.tailRequest = undefined;
    });
    return this.tailRequest;
  }

  loadOlder = (): Promise<void> => {
    if (this.destroyed || !this.nextCursor) return Promise.resolve();
    if (this.olderRequest) return this.olderRequest;
    const before = this.nextCursor;
    this.update({ isLoadingOlder: true });
    this.olderRequest = this.loadCompleteOlderTurn(before)
      .then((page) => {
        if (this.destroyed) return;
        this.rememberUserMessages(page.messages);
        this.options.hydrate(page.messages);
        this.olderHistoryStarted = true;
        this.setCursor(page.nextCursor);
      })
      .finally(() => {
        this.olderRequest = undefined;
        this.update({ isLoadingOlder: false });
      });
    return this.olderRequest;
  };

  noteActivity(): void {
    this.lastActivityAt = this.scheduler.now();
    if (this.snapshot.freshness !== 'fresh') {
      this.update({ freshness: 'fresh' });
    }
  }

  /**
   * Switch the liveness poll on or off.
   *
   * NOT an opinion about whether the session is working — that answer belongs
   * to `projectWorking` alone. This only says whether anyone still needs the
   * transcript refreshed behind the SSE stream: a caller passes the working
   * state it already has, and the last consumer leaving passes `false`.
   */
  setBusy(isBusy: boolean): void {
    if (!isBusy) {
      this.stopLivenessTimer();
      return;
    }
    if (this.livenessTimer !== undefined) return;
    this.lastActivityAt = this.scheduler.now();
    this.livenessTimer = this.scheduler.setInterval(
      () => void this.checkLiveness(),
      this.livenessIntervalMs,
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLivenessTimer();
    this.listeners.clear();
  }

  private async loadTail(reason: SessionSyncReason): Promise<void> {
    try {
      const firstPage = await this.loadPage('tail', reason);
      const page = await this.loadCompleteTurn(firstPage, 'tail', reason);
      if (this.destroyed) return;
      this.rememberUserMessages(page.messages);
      this.options.hydrate(page.messages);
      if (!this.olderHistoryStarted) {
        this.setCursor(page.nextCursor);
      }
      this.update({ freshness: 'fresh' });
    } catch {
      if (!this.destroyed) {
        this.update({ freshness: 'error' });
      }
    } finally {
      if (!this.destroyed) this.options.markLoaded();
    }
  }

  private async loadPage(
    operation: 'tail' | 'older',
    reason: SessionSyncReason,
    before?: string,
  ): Promise<SessionSyncPage> {
    const startedAt = this.scheduler.now();
    try {
      const page = await this.options.loadPage({
        limit: SESSION_SYNC_PAGE_SIZE,
        ...(before ? { before } : {}),
      });
      this.options.onTelemetry?.({
        operation,
        reason,
        durationMs: this.scheduler.now() - startedAt,
        messageCount: page.messages.length,
        succeeded: true,
      });
      return page;
    } catch (error) {
      this.options.onTelemetry?.({
        operation,
        reason,
        durationMs: this.scheduler.now() - startedAt,
        messageCount: 0,
        succeeded: false,
      });
      throw error;
    }
  }

  private async loadCompleteOlderTurn(before: string): Promise<SessionSyncPage> {
    const firstPage = await this.loadPage('older', 'manual', before);
    return this.loadCompleteTurn(firstPage, 'older', 'manual', before);
  }

  private async loadCompleteTurn(
    firstPage: SessionSyncPage,
    operation: 'tail' | 'older',
    reason: SessionSyncReason,
    initialCursor?: string,
  ): Promise<SessionSyncPage> {
    const messages = [...firstPage.messages];
    const knownUserMessageIds = new Set(this.knownUserMessageIds);
    const seenCursors = new Set(initialCursor ? [initialCursor] : []);
    let cursor = firstPage.nextCursor;

    for (const message of firstPage.messages) {
      if (message.info.role === 'user') {
        knownUserMessageIds.add(message.info.id);
      }
    }

    while (
      cursor &&
      messages.some(
        (message) =>
          message.info.role === 'assistant' &&
          Boolean(message.info.parentID) &&
          !knownUserMessageIds.has(message.info.parentID!),
      )
    ) {
      if (seenCursors.has(cursor)) {
        throw new Error(`Session history cursor repeated: ${cursor}`);
      }
      seenCursors.add(cursor);
      const page = await this.loadPage(operation, reason, cursor);
      messages.unshift(...page.messages);
      for (const message of page.messages) {
        if (message.info.role === 'user') {
          knownUserMessageIds.add(message.info.id);
        }
      }

      cursor = page.nextCursor;
    }

    return { messages, nextCursor: cursor };
  }

  private rememberUserMessages(messages: SessionSyncMessage[]): void {
    for (const message of messages) {
      if (message.info.role === 'user') {
        this.knownUserMessageIds.add(message.info.id);
      }
    }
  }

  private async checkLiveness(): Promise<void> {
    if (this.destroyed || this.scheduler.now() - this.lastActivityAt <= this.livenessIntervalMs) {
      return;
    }
    // Reconcile the TAIL, and nothing else. This is the repair for a dropped
    // SSE stream: the transcript catches up on messages the stream never
    // delivered.
    //
    // A status half used to follow it, reading the runtime over REST and
    // writing the answer into the same slot SSE frames land in. It is gone:
    // `GET .../turn` is the status authority now, and `setBusy` — the switch
    // that decides whether this poll runs at all — is already driven FROM that
    // projection, so a fourth stamped input here could only confirm or latch,
    // never correct.
    //
    // The wait stays bounded: a read proxied to the sandbox can park
    // indefinitely (a wedged opencode never answers and never errors), and the
    // poll must keep its cadence rather than stall on one request.
    await this.raceDeadline(this.reconcile('poll'), this.livenessIntervalMs);
    this.lastActivityAt = this.scheduler.now();
  }

  /** Resolve when `work` settles, or when `timeoutMs` elapses — whichever first. */
  private raceDeadline(work: Promise<unknown>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: unknown;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.cancelTimer(handle);
        resolve();
      };
      handle = this.startTimer(finish, timeoutMs);
      void work.then(finish, finish);
    });
  }

  private setCursor(cursor: string | undefined): void {
    this.nextCursor = cursor;
    this.update({ hasOlder: Boolean(cursor) });
  }

  private stopLivenessTimer(): void {
    if (this.livenessTimer === undefined) return;
    this.scheduler.clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  private startTimer(handler: () => void, delayMs: number): unknown {
    return this.scheduler.setTimeout
      ? this.scheduler.setTimeout(handler, delayMs)
      : setTimeout(handler, delayMs);
  }

  private cancelTimer(handle: unknown): void {
    if (handle === undefined) return;
    if (this.scheduler.clearTimeout) {
      this.scheduler.clearTimeout(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  }

  private update(next: Partial<SessionSyncSnapshot>): void {
    const snapshot = { ...this.snapshot, ...next };
    if (
      snapshot.freshness === this.snapshot.freshness &&
      snapshot.hasOlder === this.snapshot.hasOlder &&
      snapshot.isLoadingOlder === this.snapshot.isLoadingOlder
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
