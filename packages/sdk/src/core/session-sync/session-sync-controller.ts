import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';

export const SESSION_SYNC_PAGE_SIZE = 10;

export type SessionSyncFreshness = 'idle' | 'loading' | 'fresh' | 'stale' | 'error';

export interface SessionSyncMessage {
  info: Message;
  parts: Part[];
}

export interface SessionSyncPage {
  messages: SessionSyncMessage[];
  nextCursor?: string;
}

export interface SessionSyncSnapshot {
  freshness: SessionSyncFreshness;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** True while an accepted REST prompt has not reached stable runtime idle. */
  isPromptObservedBusy?: boolean;
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
  loadStatus?: () => Promise<SessionStatus>;
  hydrate: (messages: SessionSyncMessage[]) => void;
  markLoaded: () => void;
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
  const fetchImpl: SessionSyncFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const loadPage = createHttpSessionSyncPageLoader(options);
  const request = async (path: string): Promise<Response> => {
    const token = await options.getToken?.();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) {
      throw new Error(`Session synchronization failed: ${response.status}`);
    }
    return response;
  };

  return new SessionSyncController({
    ...options,
    loadPage,
    loadStatus: async () => {
      const response = await request('/session/status');
      const statuses = (await response.json()) as Record<string, SessionStatus>;
      return statuses[options.sessionId] ?? ({ type: 'idle' } as SessionStatus);
    },
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

const PROMPT_IDLE_SETTLEMENT_MS = 500;

type PromptObservationPhase = 'idle' | 'awaiting-work' | 'running' | 'settling';

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
    isPromptObservedBusy: false,
  };
  private nextCursor: string | undefined;
  private knownUserMessageIds = new Set<string>();
  private olderHistoryStarted = false;
  private tailRequest: Promise<void> | undefined;
  private olderRequest: Promise<void> | undefined;
  private livenessTimer: unknown;
  private promptSettlementTimer: unknown;
  private promptObservationPhase: PromptObservationPhase = 'idle';
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
   * Start monotonic completion observation for an accepted REST prompt.
   *
   * OpenCode can publish an idle snapshot from before the prompt and publish
   * the real busy event later. Keep the public projection busy until real work
   * starts and the following idle state remains quiet.
   */
  beginPromptObservation(): void {
    this.clearPromptSettlementTimer();
    this.promptObservationPhase = 'awaiting-work';
    this.update({ isPromptObservedBusy: true });
  }

  /** Observe an authoritative runtime status from SSE or status reconciliation. */
  observePromptStatus(status: SessionStatus): void {
    if (this.promptObservationPhase === 'idle') return;
    if (status.type !== 'idle') {
      this.markPromptRunning();
      return;
    }
    if (this.promptObservationPhase === 'awaiting-work') return;
    this.schedulePromptSettlement();
  }

  /** Mark assistant output as proof that the accepted prompt started. */
  observePromptActivity(): void {
    if (this.promptObservationPhase === 'idle') return;
    this.markPromptRunning();
  }

  /** End observation after rejection, cancellation, or a terminal runtime error. */
  endPromptObservation(): void {
    this.clearPromptSettlementTimer();
    this.promptObservationPhase = 'idle';
    this.update({ isPromptObservedBusy: false });
  }

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
    this.clearPromptSettlementTimer();
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
    await Promise.all([this.reconcile('poll'), this.reconcileStatus()]);
    this.lastActivityAt = this.scheduler.now();
  }

  private async reconcileStatus(): Promise<void> {
    if (!this.options.loadStatus || !this.options.setStatus) return;
    try {
      this.options.setStatus(await this.options.loadStatus());
    } catch {
      // The next liveness interval retries both bounded reads.
    }
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

  private markPromptRunning(): void {
    this.clearPromptSettlementTimer();
    this.promptObservationPhase = 'running';
  }

  private schedulePromptSettlement(): void {
    if (this.promptObservationPhase === 'settling') return;
    this.clearPromptSettlementTimer();
    this.promptObservationPhase = 'settling';
    const settle = () => {
      this.promptSettlementTimer = undefined;
      if (this.destroyed || this.promptObservationPhase !== 'settling') return;
      this.promptObservationPhase = 'idle';
      this.update({ isPromptObservedBusy: false });
    };
    this.promptSettlementTimer = this.scheduler.setTimeout
      ? this.scheduler.setTimeout(settle, PROMPT_IDLE_SETTLEMENT_MS)
      : setTimeout(settle, PROMPT_IDLE_SETTLEMENT_MS);
  }

  private clearPromptSettlementTimer(): void {
    if (this.promptSettlementTimer === undefined) return;
    if (this.scheduler.clearTimeout) {
      this.scheduler.clearTimeout(this.promptSettlementTimer);
    } else {
      clearTimeout(this.promptSettlementTimer as ReturnType<typeof setTimeout>);
    }
    this.promptSettlementTimer = undefined;
  }

  private update(next: Partial<SessionSyncSnapshot>): void {
    const snapshot = { ...this.snapshot, ...next };
    if (
      snapshot.freshness === this.snapshot.freshness &&
      snapshot.hasOlder === this.snapshot.hasOlder &&
      snapshot.isLoadingOlder === this.snapshot.isLoadingOlder &&
      snapshot.isPromptObservedBusy === this.snapshot.isPromptObservedBusy
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
