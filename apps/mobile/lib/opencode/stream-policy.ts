/**
 * Pure connection policy for the OpenCode SSE stream (`event-stream.ts`):
 * watchdog, gap reconcile, byte-budget recycle, foreground, and backoff.
 */

/**
 * Silence the sandbox daemon allows before it writes a `kortix.keepalive`
 * frame. Duplicated from `apps/kortix-sandbox-agent-server/src/sse-keepalive.ts`
 * (`SSE_KEEPALIVE_INTERVAL_MS`); the app cannot import daemon code. The daemon
 * checks on the same interval, so a healthy quiet stream is silent for up to
 * twice this value.
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * No frame for this long means the path is dead: force a reconnect. It must
 * outlast two keepalive intervals, or a healthy quiet stream is killed. Same
 * value as the SDK stream (`packages/sdk/src/core/stream/event-stream.ts`).
 */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/**
 * An interrupted connection that reopens after a gap longer than this has
 * missed events, so the live sessions reconcile their tail page.
 */
export const REHYDRATE_GAP_MS = 5_000;

/**
 * The XHR transport keeps the whole response body in one JS string until the
 * connection closes. Past this many received bytes the stream is recycled.
 */
export const STREAM_RECYCLE_BYTES = 2 * 1024 * 1024;

/**
 * Consecutive hard failures before parking: non-2xx, network error, watchdog
 * timeout, or a token read that fails or hangs.
 */
export const MAX_HARD_FAILURES = 8;

/** While parked, one probe connect per this interval. */
export const PARKED_RETRY_MS = 60_000;

/** A token read that takes longer than this counts as a failure. */
export const TOKEN_TIMEOUT_MS = 15_000;

/**
 * A connection open this long, or one that delivered a real event, is stable:
 * only then do the backoff and failure counters reset, so a server that
 * accepts and immediately drops the stream backs off instead of looping.
 */
export const STREAM_STABLE_MS = 10_000;

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER = 0.2;

export function shouldRecycleStream(
  bytesSinceOpen: number,
  budget: number = STREAM_RECYCLE_BYTES,
): boolean {
  return bytesSinceOpen >= budget;
}

/**
 * What to do when the app returns to the foreground. An open stream that
 * delivered a frame inside the watchdog window is healthy; anything else
 * reconnects, and the `open` handler decides whether to reconcile.
 */
export function onForeground(input: {
  streamOpen: boolean;
  msSinceLastFrame: number;
}): 'none' | 'reconnect' {
  if (input.streamOpen && input.msSinceLastFrame < HEARTBEAT_TIMEOUT_MS) return 'none';
  return 'reconnect';
}

/**
 * Backoff for reconnect `attempt` (0-based): 250 ms doubled per attempt,
 * capped at 30 s, then +/-20 % jitter. `rand` is a value in [0, 1).
 */
export function nextReconnectDelay(attempt: number, rand: number): number {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return base * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * rand);
}

export function shouldPark(consecutiveHardFailures: number): boolean {
  return consecutiveHardFailures >= MAX_HARD_FAILURES;
}

/** When to try again after a failure, and whether the stream is now parked. */
export function nextRetry(input: {
  attempt: number;
  hardFailures: number;
  rand: number;
}): { parked: boolean; delayMs: number } {
  if (shouldPark(input.hardFailures)) return { parked: true, delayMs: PARKED_RETRY_MS };
  return { parked: false, delayMs: Math.round(nextReconnectDelay(input.attempt, input.rand)) };
}

export function isStreamStable(input: { openForMs: number; sawEvent: boolean }): boolean {
  return input.sawEvent || input.openForMs >= STREAM_STABLE_MS;
}

/**
 * A 2xx stream that ends this soon after `open` without a real event is a
 * failure, not a clean end: for example a stale daemon that answers the event
 * route with an HTML page.
 */
export const HOLLOW_STREAM_END_MS = 5_000;

/** Frames that only prove the connection is alive. They are not real events. */
const LIVENESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'server.connected',
  'server.heartbeat',
  'kortix.keepalive',
]);

export function isLivenessOnlyEvent(type: string): boolean {
  return LIVENESS_EVENT_TYPES.has(type);
}

/**
 * True when a 2xx stream ended within `HOLLOW_STREAM_END_MS` of `open`
 * without a real event. It counts as a hard failure, so a daemon that keeps
 * doing this parks instead of reconnecting forever.
 */
export function isHollowStreamEnd(input: { openForMs: number; sawEvent: boolean }): boolean {
  return !input.sawEvent && input.openForMs < HOLLOW_STREAM_END_MS;
}

/**
 * Why a connection is being opened: the first connect, a replacement for a
 * lost connection, or a planned byte-budget recycle.
 */
export type OpenCause = 'initial' | 'interrupted' | 'recycle';

/**
 * Reconcile on `open` after an interrupted connection whose silence exceeded
 * the gap, and after every recycle: events emitted between the recycle's close
 * and the new open are lost however short that window is.
 */
export function shouldReconcileOnOpen(input: { cause: OpenCause; gapMs: number }): boolean {
  if (input.cause === 'recycle') return true;
  return input.cause === 'interrupted' && input.gapMs > REHYDRATE_GAP_MS;
}

// ---------------------------------------------------------------------------
// Event payload → cache policy
// ---------------------------------------------------------------------------

interface SessionLike {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

/**
 * Whether a `session.updated` payload is a complete session object that can
 * replace the cached one, rather than a partial patch.
 */
export function isFullSession(info: unknown): info is SessionLike {
  if (!info || typeof info !== 'object') return false;
  const candidate = info as Partial<SessionLike>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.time?.created === 'number' &&
    typeof candidate.time?.updated === 'number'
  );
}

/**
 * The session list with `info` replacing its entry, still ordered most
 * recently updated first (the order `useSessions` returns). `undefined` when
 * the list does not hold that session, so the caller refetches instead of
 * guessing where it belongs.
 */
export function patchSessionList<T extends SessionLike>(list: readonly T[], info: T): T[] | undefined {
  const index = list.findIndex((entry) => entry.id === info.id);
  if (index < 0) return undefined;
  const next = list.filter((_, position) => position !== index);
  let insertAt = next.findIndex((entry) => entry.time.updated < info.time.updated);
  if (insertAt < 0) insertAt = next.length;
  next.splice(insertAt, 0, info);
  return next;
}

interface QuestionLike {
  id: string;
  sessionID: string;
}

/**
 * Pending questions from `GET /question` that the store does not hold yet,
 * restricted to sessions `include` accepts. Malformed entries are skipped.
 */
export function questionsToHydrate<Q extends QuestionLike>(
  fetched: unknown,
  existing: Readonly<Record<string, readonly { id: string }[] | undefined>>,
  include: (sessionId: string) => boolean,
): Q[] {
  if (!Array.isArray(fetched)) return [];
  const added: Q[] = [];
  const seen = new Set<string>();
  for (const entry of fetched) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, sessionID } = entry as Partial<QuestionLike>;
    if (typeof id !== 'string' || typeof sessionID !== 'string') continue;
    if (seen.has(id) || !include(sessionID)) continue;
    seen.add(id);
    if (existing[sessionID]?.some((question) => question.id === id)) continue;
    added.push(entry as Q);
  }
  return added;
}
