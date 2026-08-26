import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { SandboxNotReadyError, isSandboxNotReadyError } from '../http/opencode-errors';
import { isAbortError } from '../http/abort-error';

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
/** First retry delay after a failed tail read. */
const TAIL_RETRY_BASE_MS = 1_000;
/** Ceiling for the retry backoff — a box that comes back is picked up within it. */
const TAIL_RETRY_MAX_MS = 15_000;

export const SESSION_SYNC_PAGE_SIZE = 100;

/**
 * The FIRST page — the one the user waits on.
 *
 * Time to first paint is bytes, not messages. Measured on a heavy session
 * (essentia, 2026-08-24, a run with hundreds of image reads whose parts carried
 * base64 — BEFORE the attachment bytes were stripped from the list):
 *
 *   message?limit=50   ->   8,228 kB   30.39 s
 *   message?limit=50   ->  24,460 kB   48.76 s
 *   message?limit=50   ->  20,284 kB   35.74 s
 *   message?limit=50   ->  25,125 kB   29.23 s
 *
 * That was 165-500 kB PER MESSAGE, and it drove the first page down to 20.
 * With the bytes gone (`stripInlineAttachmentBytes`, same session, same day)
 * a message is ~2-7 kB: `limit=20` measured 132 kB, an older page of 50
 * measured 345-420 kB. At that weight a small first page is a false economy —
 * on a normal viewport 20 messages do not fill the screen, so the top sentinel
 * pulled two more pages before the reader touched anything, and three round
 * trips (each paying a CORS preflight, one measured at 3.34 s) replaced one.
 *
 * Fifty fills the view. Older pages go to a hundred: by then the reader is
 * scrolling deliberately, a spinner is honest, and fewer round trips wins.
 *
 * NOTE this is not what fixed the blank transcript. That was structural:
 * `hydrate` ran only after a multi-page backward walk, so NOTHING rendered at
 * any page size — a smaller limit would have meant MORE sequential round trips
 * before that single paint, and a longer blank. The walk is gone (see
 * `loadTail`); this only makes the first paint lighter.
 */
export const SESSION_SYNC_TAIL_PAGE_SIZE = 50;

/**
 * How far back the tail read will walk to complete a turn before it stops and
 * leaves the rest to "load older".
 *
 * The walk exists so an assistant message is not rendered above its own prompt.
 * It had no ceiling, and a session whose last turn is thousands of messages —
 * an agent run with hundreds of tool calls — therefore paged the WHOLE session
 * 50 at a time, serially, through the sandbox proxy, before painting anything.
 * The read returns 200 the entire time, which is why this looked like a bug in
 * rendering rather than in loading.
 *
 * 10 pages = 500 messages, far past any honest turn, and the cursor survives so
 * nothing becomes unreachable.
 */
export const MAX_TURN_BACKFILL_PAGES = 10;

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
  | 'initial'
  | 'poll'
  | 'sse-gap'
  | 'compaction'
  | 'session-error'
  | 'send-recovery'
  /** The turn ended. The last read of a busy session, and the one that catches
   *  a final answer whose closing frames the stream never delivered. */
  | 'turn-end'
  /** The tab became visible again. A backgrounded tab is throttled, not
   *  notified, so return is a moment to re-read rather than to assume. */
  | 'visible'
  /** The transcript was evicted while detached and the live stream refilled it
   *  from the middle — see `transcriptIsFragment`. */
  | 'eviction'
  | 'manual';

export interface SessionSyncTelemetryEvent {
  operation: 'tail' | 'older';
  reason: SessionSyncReason;
  durationMs: number;
  messageCount: number;
  succeeded: boolean;
}

export interface SessionSyncControllerOptions {
  sessionId: string;
  /**
   * Read one bounded page. `signal` is the controller's own — aborted on
   * `destroy()` (a scope reset destroys the controller), so a page loader that
   * forwards it into `fetch` cancels a read the tab has navigated away from,
   * and a superseded read can never hydrate the store. Passing it is optional;
   * a loader that ignores it still works, it just cannot be cancelled.
   */
  loadPage: (
    request: { limit: number; before?: string },
    signal?: AbortSignal,
  ) => Promise<SessionSyncPage>;
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
  return async ({ limit, before }, signal) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    const token = await options.getToken?.();
    const response = await fetchImpl(
      `${baseUrl}/session/${encodeURIComponent(options.sessionId)}/message?${query}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      // A 503 from the sandbox proxy is the box waking, not a failure — throw
      // the retryable, "loading" error so the controller keeps polling instead
      // of painting an error state over a session that is about to load.
      if (response.status === 503) {
        throw new SandboxNotReadyError(`session ${response.status}`);
      }
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

/**
 * Every message in the session, oldest first.
 *
 * The order is the SERVER's: `MessageV2.page()` orders by `time_created`, so
 * each page arrives already ordered and is concatenated untouched. Paging
 * walks BACKWARDS (page 1 is the newest tail, `before` steps into history), so
 * the transcript is the pages in reverse fetch order.
 *
 * This used to re-sort the union by `info.id.localeCompare(...)`. That was
 * wrong twice over: message ids no longer ascend with time at all (OpenCode
 * 1.18.15 retired that invariant — turn exit reads
 * `lastAssistant.parentID === lastUser.id`, and `MessageV2.latest()` orders by
 * `time.created`), and `localeCompare` is not byte order, so it disagreed with
 * every other id comparison in the product on the same data.
 */
export async function loadCompleteSessionHistory(
  loadPage: SessionSyncControllerOptions['loadPage'],
): Promise<SessionSyncMessage[]> {
  const pages: SessionSyncMessage[][] = [];
  const cursors = new Set<string>();
  let before: string | undefined;
  do {
    const page = await loadPage({
      limit: SESSION_SYNC_PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    pages.push(page.messages);
    before = page.nextCursor;
    if (before && cursors.has(before)) {
      throw new Error(`Session history cursor repeated: ${before}`);
    }
    if (before) cursors.add(before);
  } while (before);

  // Oldest page last out of the loop, so walk the pages backwards. A message
  // repeated across two overlapping pages keeps the OLDER page's copy and its
  // older position — the same copy the id-keyed Map used to end up holding.
  const ordered: SessionSyncMessage[] = [];
  const seen = new Set<string>();
  for (let index = pages.length - 1; index >= 0; index--) {
    for (const message of pages[index]) {
      if (seen.has(message.info.id)) continue;
      seen.add(message.info.id);
      ordered.push(message);
    }
  }
  return ordered;
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
  /** Consecutive failed tail reads, for the retry backoff. Reset by success. */
  private retryAttempt = 0;
  private tailRetryTimer: unknown;
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
  /**
   * One controller-lifetime signal, threaded into every read. A scope reset
   * (registry `resetSessionSyncControllersForSession`) or unmount destroys this
   * controller, `destroy()` aborts this, and the in-flight read cancels — so a
   * navigated-away or superseded read frees its socket and can never hydrate.
   */
  private readonly abortController = new AbortController();

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
    // `loading` covers the first read AND a not-ready retry, so a waking box
    // does not flip to `stale` between attempts; a session that already has a
    // fresh transcript revalidates as `stale`.
    this.update({
      freshness:
        this.snapshot.freshness === 'idle' || this.snapshot.freshness === 'loading'
          ? 'loading'
          : 'stale',
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
      // The turn is over — and that is exactly when the transcript is most
      // likely to be short. A stream that dropped its last frames leaves the
      // browser holding a truncated answer while the runtime holds the whole
      // one, and stopping the poll here used to make that state PERMANENT:
      // nothing read the tail again until the session was reopened. Reported
      // from a live self-host (2026-08-24): an 8m13s turn finished in the
      // runtime's own terminal while the tab still showed a spinner under a
      // half-written answer.
      //
      // One bounded read, only for a session that was actually busy, so an
      // idle session churns nothing.
      const wasBusy = this.livenessTimer !== undefined;
      this.stopLivenessTimer();
      if (wasBusy && !this.destroyed) void this.reconcile('turn-end');
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
    // `destroyed` FIRST: `stopLivenessTimer` is also reached through
    // `setBusy(false)`, which now fires a turn-end read, and a controller being
    // torn down must not start a request it can never hydrate.
    this.destroyed = true;
    this.stopLivenessTimer();
    if (this.tailRetryTimer !== undefined) {
      this.cancelTimer(this.tailRetryTimer);
      this.tailRetryTimer = undefined;
    }
    // Cancel any in-flight read so it frees its socket and cannot hydrate a
    // controller that is being torn down.
    this.abortController.abort();
    this.listeners.clear();
  }

  private async loadTail(reason: SessionSyncReason): Promise<void> {
    try {
      // ONE PAGE. Render it. This is what OpenCode's own client does, and the
      // reason we now do it too is measured:
      //
      //   message?limit=50            200   8,228 kB   30.39 s
      //   message?limit=50            200  24,460 kB   48.76 s
      //   message?limit=50&before=..  200  20,284 kB   35.74 s
      //   message?limit=50&before=..  200  25,125 kB   29.23 s
      //   -> 78,097 kB transferred, finish 3.8 min, NOTHING on screen
      //
      // (essentia, 2026-08-24, a run with hundreds of image reads: fifty
      // messages weigh 8-25 MB because the parts carry the image bytes.)
      //
      // There used to be a backward WALK here that kept fetching pages until
      // every assistant message had its parent user message in hand, so an
      // assistant reply could never render above its own prompt — and `hydrate`
      // ran only after the walk finished. On a long turn that walk is the whole
      // session, serially, through the sandbox proxy, with an empty thread the
      // entire time. A cosmetic guarantee at the top edge of the window is not
      // worth minutes of blank screen.
      //
      // The window may therefore start on an assistant message whose prompt is
      // one page up. That is exactly what OpenCode shows, and `loadOlder` —
      // which the user drives — still completes the turn when they scroll.
      const page = await this.loadPage('tail', reason);
      if (this.destroyed) return;
      this.rememberUserMessages(page.messages);
      this.options.hydrate(page.messages);
      if (!this.olderHistoryStarted) {
        this.setCursor(page.nextCursor);
      }
      this.update({ freshness: 'fresh' });
      // SUCCESS ONLY. `markLoaded` used to sit in a `finally`, so a read that
      // FAILED still told the store this session was loaded — and the store's
      // implementation of that plants an empty message list. A first read that
      // lost to a waking box, a 503 from the proxy, or a flapping probe was
      // therefore RECORDED as "this session has no messages", and the UI
      // painted an empty conversation over a session that had plenty. Nothing
      // came back for it either: the mount had already run, and the liveness
      // poll only turns on while a session is working.
      //
      // A successful read of zero messages still marks loaded — that is a fact
      // about the session. A failed read is not a fact about anything.
      this.options.markLoaded();
      this.retryAttempt = 0;
    } catch (error) {
      if (this.destroyed) return;
      // A superseded/cancelled read is not a failure and never hydrates — it
      // must not paint an error over a live transcript, and it must not retry.
      if (isAbortError(error) || this.abortController.signal.aborted) return;
      // A sandbox that is still waking is a RETRYABLE, "loading" state, not a
      // fault: the box may come up any second, so keep polling and keep the UI
      // on its loader. Only a genuine failure earns `error`. NEVER an
      // empty-`fresh` — `markLoaded` above ran only on success, so a failed
      // read never records the session as an empty transcript.
      this.update({ freshness: isSandboxNotReadyError(error) ? 'loading' : 'error' });
      this.scheduleTailRetry(reason);
    }
  }

  /**
   * Come back for a read that lost.
   *
   * Without this a session got exactly ONE chance to load, and whether it took
   * it depended on a race with the sandbox's boot. Losing that race left the
   * page on "Waking the agent" with no exit but the health probe — the least
   * reliable signal in the system — or a manual reload.
   *
   * Backoff so a genuinely dead box costs little, capped so a box that comes
   * back is picked up promptly.
   */
  private scheduleTailRetry(reason: SessionSyncReason): void {
    if (this.destroyed || this.tailRetryTimer !== undefined) return;
    const delay = Math.min(
      TAIL_RETRY_BASE_MS * 2 ** this.retryAttempt,
      TAIL_RETRY_MAX_MS,
    );
    this.retryAttempt += 1;
    this.tailRetryTimer = this.startTimer(() => {
      this.tailRetryTimer = undefined;
      if (this.destroyed) return;
      void this.reconcile(reason);
    }, delay);
  }

  private async loadPage(
    operation: 'tail' | 'older',
    reason: SessionSyncReason,
    before?: string,
  ): Promise<SessionSyncPage> {
    const startedAt = this.scheduler.now();
    try {
      const page = await this.options.loadPage(
        {
          // The tail is what someone is waiting for; an older page is what they
          // asked for. Different budgets — see SESSION_SYNC_TAIL_PAGE_SIZE.
          limit: operation === 'tail' ? SESSION_SYNC_TAIL_PAGE_SIZE : SESSION_SYNC_PAGE_SIZE,
          ...(before ? { before } : {}),
        },
        this.abortController.signal,
      );
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
    onPage?: (messagesSoFar: SessionSyncMessage[]) => void,
  ): Promise<SessionSyncPage> {
    const messages = [...firstPage.messages];
    const knownUserMessageIds = new Set(this.knownUserMessageIds);
    const seenCursors = new Set(initialCursor ? [initialCursor] : []);
    let cursor = firstPage.nextCursor;
    let pagesRead = 0;

    for (const message of firstPage.messages) {
      if (message.info.role === 'user') {
        knownUserMessageIds.add(message.info.id);
      }
    }

    while (
      cursor &&
      // BOUNDED. Without a ceiling a turn of a few thousand messages paged the
      // whole session before anything rendered — see MAX_TURN_BACKFILL_PAGES.
      pagesRead < MAX_TURN_BACKFILL_PAGES &&
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
      if (this.destroyed) return { messages, nextCursor: cursor };
      pagesRead += 1;
      messages.unshift(...page.messages);
      for (const message of page.messages) {
        if (message.info.role === 'user') {
          knownUserMessageIds.add(message.info.id);
        }
      }

      cursor = page.nextCursor;
      // Repaint as each page lands, so a long turn fills in front of the user
      // instead of withholding everything until the walk ends.
      onPage?.([...messages]);
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
