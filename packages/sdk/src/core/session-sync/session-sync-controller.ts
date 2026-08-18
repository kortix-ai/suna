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

export interface SessionSyncSnapshot {
  freshness: SessionSyncFreshness;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** True while an accepted REST prompt has not reached stable runtime idle. */
  isPromptObservedBusy?: boolean;
  /**
   * True once an accepted REST prompt's stall deadline fired with NO
   * proof-of-life ever observed (no busy status, no SSE frame, no new
   * assistant reply in a tail reconcile — `promptObservationPhase` never left
   * `'awaiting-work'`) AND an authoritative `/session/status` read confirms
   * the runtime is genuinely idle. That combination means the turn most
   * likely never ran at all — a message accepted (204) but silently never
   * answered, observed live 2026-08-18 (session `749045da`, 3 of 5 sent
   * messages). `resolvePromptStall` already had to ask this exact question to
   * decide whether to drop the busy override; this only keeps the answer
   * instead of discarding it. Cleared by the next `beginPromptObservation()`
   * (a fresh send attempt) — never sticks past the message it describes.
   */
  promptLikelyDropped?: boolean;
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

/**
 * How long the prompt-observation override may claim a session is working
 * without any fresh proof that it is.
 *
 * The override exists to absorb a *stale* idle snapshot — OpenCode can publish
 * an idle status from before the prompt and publish the real busy status after
 * it. That staleness lasts as long as one in-flight message, not minutes. Every
 * signal that would normally end the override (`session.idle`, a `session.status`
 * frame, the status poll) can be lost: a dropped SSE frame at the end of a turn,
 * a reconnect that rehydrates status outside this controller, a prompt the
 * runtime accepted but never turned into a turn, a parked proxy read. Without a
 * bound, any one of those pinned the composer on "stop" and the last turn on
 * "Gathering thoughts…" until the user reloaded the page.
 *
 * Letting the override expire is not the same as declaring the session idle: it
 * only stops *overriding* the runtime's own status. A session that really is
 * working still reports `busy` and still renders as working. So the cost of
 * expiring early is bounded by the accuracy of the runtime status, while the
 * cost of never expiring is a session that lies until reload.
 *
 * When the deadline fires, the controller does not clear blindly: it polls
 * `/session/status` once and only releases the override on an authoritative
 * idle answer (or an unreachable runtime) — see `resolvePromptStall`. A busy
 * answer keeps the override and re-arms the deadline.
 */
export const PROMPT_OBSERVATION_STALL_MS = 10_000;

/**
 * How many consecutive stall windows may end in a FAILED status read (thrown
 * or deadline-timed-out) before the override releases anyway. One transient
 * 502 at the 10s mark must not unmask a possibly-live turn — but a runtime
 * that answers nothing for this many windows in a row is not going to answer,
 * and painting busy forever is the original bug wearing a new hat.
 */
export const PROMPT_STALL_MAX_ATTEMPTS = 3;

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
    promptLikelyDropped: false,
  };
  private nextCursor: string | undefined;
  private knownUserMessageIds = new Set<string>();
  private olderHistoryStarted = false;
  private tailRequest: Promise<void> | undefined;
  private olderRequest: Promise<void> | undefined;
  private livenessTimer: unknown;
  private promptSettlementTimer: unknown;
  private promptStallTimer: unknown;
  private promptObservationPhase: PromptObservationPhase = 'idle';
  /** Bumped on every observation lifecycle edge; a stall resolve captured
   *  under an older epoch discards its answer instead of applying it to a
   *  NEWER observation (a parked read can outlive the turn it asked about). */
  private promptObservationEpoch = 0;
  private promptStallFailures = 0;
  /** Bumped by markPromptRunning; lets an in-flight stall read detect that
   *  proof-of-life OVERTOOK it inside the same observation. */
  private promptRunningGeneration = 0;
  private promptStallDeadlineTimer: unknown;
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
    // Any frame for this session is proof the turn is still alive, so it also
    // renews the prompt-observation override — see PROMPT_OBSERVATION_STALL_MS.
    if (this.promptObservationPhase !== 'idle') this.armPromptStallTimer();
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
    this.promptObservationEpoch += 1;
    this.promptStallFailures = 0;
    this.promptObservationPhase = 'awaiting-work';
    this.armPromptStallTimer();
    // A fresh send attempt — any prior "likely dropped" verdict described the
    // message THAT resolved, not this new one.
    this.update({ isPromptObservedBusy: true, promptLikelyDropped: false });
    this.setBusy(true);
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
    this.clearPromptObservation();
    this.setBusy(false);
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
    this.clearPromptStallTimer();
    this.cancelTimer(this.promptStallDeadlineTimer);
    this.promptStallDeadlineTimer = undefined;
    this.listeners.clear();
  }

  private async loadTail(reason: SessionSyncReason): Promise<void> {
    try {
      const firstPage = await this.loadPage('tail', reason);
      const page = await this.loadCompleteTurn(firstPage, 'tail', reason);
      if (this.destroyed) return;
      if (this.containsNewPromptReply(page.messages)) {
        this.observePromptActivity();
      }
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
    // Load the transcript before status. A completed async prompt can transition
    // back to idle before the first poll. The tail proves that work occurred;
    // the following idle status can then settle prompt observation correctly.
    //
    // The wait is bounded: a read proxied to the sandbox can park indefinitely
    // (a wedged opencode never answers and never errors), and status recovery —
    // the one thing that can unstick a session the UI believes is still working
    // — must not be held hostage to it. On timeout the tail keeps running; only
    // this poll's ordering guarantee is given up.
    await this.raceDeadline(this.reconcile('poll'), this.livenessIntervalMs);
    await this.reconcileStatus();
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

  private containsNewPromptReply(messages: SessionSyncMessage[]): boolean {
    if (this.promptObservationPhase === 'idle') return false;
    const newUserMessageIds = new Set(
      messages
        .filter(
          (message) =>
            message.info.role === 'user' && !this.knownUserMessageIds.has(message.info.id),
        )
        .map((message) => message.info.id),
    );
    if (newUserMessageIds.size === 0) return false;
    return messages.some(
      (message) =>
        message.info.role === 'assistant' &&
        Boolean(message.info.parentID) &&
        newUserMessageIds.has(message.info.parentID!),
    );
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
    this.promptStallFailures = 0;
    this.promptRunningGeneration += 1;
    this.armPromptStallTimer();
  }

  private schedulePromptSettlement(): void {
    if (this.promptObservationPhase === 'settling') return;
    this.clearPromptSettlementTimer();
    this.promptObservationPhase = 'settling';
    const settle = () => {
      this.promptSettlementTimer = undefined;
      if (this.destroyed || this.promptObservationPhase !== 'settling') return;
      this.clearPromptObservation();
      this.stopLivenessTimer();
    };
    this.promptSettlementTimer = this.startTimer(settle, PROMPT_IDLE_SETTLEMENT_MS);
  }

  /**
   * (Re)start the deadline after which the busy override stops claiming this
   * session is working. Renewed by every piece of evidence that the turn is
   * still alive; fired only when all of them stop arriving.
   */
  private armPromptStallTimer(): void {
    this.clearPromptStallTimer();
    this.promptStallTimer = this.startTimer(() => {
      this.promptStallTimer = undefined;
      if (this.destroyed || this.promptObservationPhase === 'idle') return;
      void this.resolvePromptStall();
    }, PROMPT_OBSERVATION_STALL_MS);
  }

  /**
   * The stall deadline fired: no proof-of-life arrived for a whole window.
   * ASK the runtime before dropping the override — a blind clear here was a
   * proven defect: a live turn that emits no SSE frame for 10s (a reasoning
   * model before its first token, one long tool call) would be unmasked as
   * idle, and — because dropping the override flips `isBusy` false, which
   * stops the liveness polling via `setBusy(false)` — the authoritative poll
   * that could have corrected it never ran. Polling here closes that hole:
   * a busy answer keeps the override (and re-arms this deadline); an idle
   * answer, or an unreachable runtime, releases it.
   */
  private async resolvePromptStall(): Promise<void> {
    const epoch = this.promptObservationEpoch;
    // Stamp the read at ISSUE time. An answer is only as fresh as the moment
    // it was asked: a turn that starts (or streams any frame) while the read
    // is in flight has overtaken it, and an honest-at-issue-time idle answer
    // must then be discarded — not applied over newer proof-of-life.
    const issueRunningGeneration = this.promptRunningGeneration;
    const issueActivityAt = this.lastActivityAt;
    if (this.options.loadStatus) {
      let failed = false;
      let status: SessionStatus | undefined;
      try {
        // Deadlined: a read proxied to the sandbox can park indefinitely (the
        // same wedge checkLiveness defends against), and a parked read here
        // used to leave the override latched with nothing armed to retry.
        status = await this.raceStatusDeadline(
          this.options.loadStatus(),
          this.livenessIntervalMs,
        );
        if (status === undefined) failed = true;
      } catch {
        failed = true;
      }
      // A parked read can outlive its observation: the turn it asked about
      // ends, a new prompt begins a new observation, and only then does the
      // stale answer land. Discard anything from an older epoch outright.
      if (this.destroyed || this.promptObservationEpoch !== epoch) return;
      // Same discard WITHIN the observation: proof-of-life that arrived after
      // the read was issued outranks the read's answer. Fresh evidence also
      // re-armed the stall deadline via noteActivity/markPromptRunning, so
      // returning here leaves a live retry armed — nothing is dropped.
      if (
        this.promptRunningGeneration !== issueRunningGeneration ||
        this.lastActivityAt !== issueActivityAt
      ) {
        return;
      }
      if (!failed && status !== undefined) {
        // Push the authoritative answer into the host store, and let the
        // normal observation path act on it: busy re-arms the stall via
        // markPromptRunning; idle settles through the settlement window.
        this.options.setStatus?.(status);
        if (this.promptObservationEpoch !== epoch) return;
        if (status.type !== 'idle') {
          this.markPromptRunning();
          return;
        }
        // The registry's setStatus wrapper re-enters observePromptStatus
        // synchronously, which for an idle answer in 'running' has already
        // moved the phase to 'settling'. Settlement owns the release then —
        // clearing here instead would skip the 500ms window entirely.
        if (this.promptObservationPhase === 'settling') return;
        if (this.promptObservationPhase === 'running') {
          this.schedulePromptSettlement();
          return;
        }
        // Only 'awaiting-work' reaches here (the branches above return for
        // 'settling'/'running'): nothing EVER proved this turn started — no
        // busy status, no SSE frame, no new reply — and the runtime just
        // confirmed, authoritatively, that it is idle right now. The prompt
        // most likely never ran. See `promptLikelyDropped`'s doc.
        this.clearPromptObservation({ likelyDropped: true });
        return;
      }
      // Failed read: one transient failure must not unmask a possibly-live
      // turn — retry on the next stall window, up to the bounded budget.
      this.promptStallFailures += 1;
      if (this.promptStallFailures < PROMPT_STALL_MAX_ATTEMPTS) {
        this.armPromptStallTimer();
        return;
      }
    }
    if (this.destroyed || this.promptObservationEpoch !== epoch) return;
    this.clearPromptObservation();
  }

  /** Resolve with `work`'s value, or `undefined` once `timeoutMs` elapses. */
  private raceStatusDeadline(
    work: Promise<SessionStatus>,
    timeoutMs: number,
  ): Promise<SessionStatus | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const handle = this.startTimer(() => {
        if (settled) return;
        settled = true;
        this.promptStallDeadlineTimer = undefined;
        resolve(undefined);
      }, timeoutMs);
      // Tracked so destroy() can cancel it — otherwise every destroyed
      // controller kept a live deadline timeout for up to timeoutMs.
      this.promptStallDeadlineTimer = handle;
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.cancelTimer(handle);
          this.promptStallDeadlineTimer = undefined;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.cancelTimer(handle);
          this.promptStallDeadlineTimer = undefined;
          reject(error);
        },
      );
    });
  }

  /** Drop the busy override and its timers, leaving the liveness timer alone. */
  private clearPromptObservation(options: { likelyDropped?: boolean } = {}): void {
    this.clearPromptSettlementTimer();
    this.clearPromptStallTimer();
    this.promptObservationEpoch += 1;
    this.promptStallFailures = 0;
    this.promptObservationPhase = 'idle';
    this.update({
      isPromptObservedBusy: false,
      ...(options.likelyDropped ? { promptLikelyDropped: true } : {}),
    });
  }

  private clearPromptSettlementTimer(): void {
    this.cancelTimer(this.promptSettlementTimer);
    this.promptSettlementTimer = undefined;
  }

  private clearPromptStallTimer(): void {
    this.cancelTimer(this.promptStallTimer);
    this.promptStallTimer = undefined;
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
      snapshot.isLoadingOlder === this.snapshot.isLoadingOlder &&
      snapshot.isPromptObservedBusy === this.snapshot.isPromptObservedBusy &&
      snapshot.promptLikelyDropped === this.snapshot.promptLikelyDropped
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
