import { isAbortError } from '../http/abort-error';
import type {
  SessionTurnEndError,
  SessionTurnStatus,
} from '../rest/projects-client/sessions';

/**
 * Announce the end of a turn whose session page is no longer mounted.
 *
 * THE PROBLEM. A turn end is announced by the session page's live event stream
 * (`notifyTurnEnd` on busy→idle). There is one stream per window, and it
 * unmounts with the page. Start a turn, open the project home in the same
 * window, and the end reaches nothing: no toast, no favicon dot, no Dock badge.
 * The other-tab relay (`apps/web/src/lib/turn-broadcast.ts`) cannot help: it
 * only repeats what some tab's stream announced.
 *
 * THE SOURCE. `GET .../sessions/:id/turn` is the control plane's answer to "which
 * turns are open", and its `last_ended` row says how the newest one ended. The
 * page polled it every 5 s while the turn ran (`useSessionWorking`), so carrying
 * that poll past the unmount costs nothing the page did not already spend.
 *
 * THE CONTRACT. The page hands its running turn over when it unmounts and takes
 * it back when it mounts again (`release`). While the page is mounted, its
 * stream announces; while it is not, this does. Never both.
 *
 * Framework-free: `react/turn-end-handoff.ts` binds it to the page lifecycle and
 * the host's notification sink.
 */

/** The first read, shortly after the hand-off: a page that comes straight back
 *  (StrictMode, a quick back-and-forth) reclaims the turn before any request. */
export const TURN_END_WATCH_FIRST_READ_MS = 1_000;
/** The cadence the page itself kept while the turn ran (`WORKING_POLL_ACTIVE_MS`). */
export const TURN_END_WATCH_POLL_MS = 5_000;
/** After this long, a turn is a long job: read it at the page's idle cadence. */
export const TURN_END_WATCH_LONG_TURN_MS = 5 * 60_000;
/** The long-job cadence (`WORKING_POLL_IDLE_MS`). */
export const TURN_END_WATCH_SLOW_POLL_MS = 15_000;
/** How long a hand-off with no open turn waits for one (`OPTIMISTIC_RECEIPT_MAX_MS`). */
export const TURN_END_WATCH_START_MS = 60_000;
/** The watch ends here whatever the turn does. A turn this long is a stuck turn
 *  the reaper closes, and a page left open that long is not waiting for a toast. */
export const TURN_END_WATCH_MAX_MS = 12 * 60 * 60_000;

/** What the session page knew about its turn when it unmounted. */
export interface TurnEndHandoff {
  projectId: string;
  /** The Kortix session id (what `/turn` is addressed by, and what hosts open). */
  sessionId: string;
  /** The turn the control plane held open, per the page's newest `/turn` read.
   *  Null when the page knew only its own send receipt or a stream frame. */
  openTurnToken: string | null;
  /** The newest ended turn per the page's newest `/turn` read. A different
   *  `last_ended` later is an end that happened after the hand-off. */
  lastEndedToken: string | null;
  /** The session's title, read when the turn ends (it is often named mid-turn). */
  title?: () => string | undefined;
}

export type TurnEndOutcome =
  | { kind: 'completed' }
  /** `error` is null when the turn died and nobody named why. */
  | { kind: 'failed'; error: SessionTurnEndError | null }
  /** A stop somebody asked for. Not news: nothing is announced. */
  | { kind: 'stopped' };

export type TurnEndVerdict =
  | { state: 'running' }
  /** No turn is open and none ended since the hand-off: the send has not been
   *  minted into a turn yet. */
  | { state: 'waiting' }
  | { state: 'ended'; outcome: TurnEndOutcome };

/** How the turn in `last_ended` ended, in the terms the server's own push uses
 *  (`turnEndPushType`): an abort and a requested stop announce nothing. */
function outcomeOf(read: SessionTurnStatus): TurnEndOutcome {
  const ended = read.last_ended;
  if (!ended) return { kind: 'completed' };
  const reason = ended.end_reason;
  if (reason === 'completed' || reason === 'unknown' || reason === null) return { kind: 'completed' };
  const error = ended.error;
  if (error) {
    if (isAbortError({ name: error.name ?? undefined, message: error.message ?? undefined })) {
      return { kind: 'stopped' };
    }
    return { kind: 'failed', error };
  }
  // `failed` with no error is a requested stop (the API strips UserStop and
  // QueueInterrupt from `error`) unless the failure list names this turn as a
  // death nobody explained.
  if (reason === 'failed') {
    const listed = read.recent_failures?.some(
      (failure) => !!ended.message_id && failure.message_id === ended.message_id,
    );
    if (!listed) return { kind: 'stopped' };
  }
  return { kind: 'failed', error: null };
}

/**
 * What one `/turn` read says about the turn the page handed over. Pure.
 *
 * `sawOpen`: an earlier read of this watch saw a turn open. A queued prompt the
 * control plane promotes keeps the session running, so the watch announces only
 * when no turn is open at all — the server's push makes the same call.
 */
export function readTurnEnd(
  handoff: TurnEndHandoff,
  read: SessionTurnStatus,
  sawOpen: boolean,
): TurnEndVerdict {
  if (read.turns.length > 0) return { state: 'running' };
  const lastEndedToken = read.last_ended?.turn_token ?? null;
  const endedSinceHandoff =
    handoff.openTurnToken !== null ||
    sawOpen ||
    (lastEndedToken !== null && lastEndedToken !== handoff.lastEndedToken);
  if (!endedSinceHandoff) return { state: 'waiting' };
  return { state: 'ended', outcome: outcomeOf(read) };
}

export interface TurnEndWatchDeps {
  readTurn(projectId: string, sessionId: string): Promise<SessionTurnStatus>;
  /** Called once per watched turn, for every outcome including `stopped`. */
  onEnded(handoff: TurnEndHandoff, outcome: TurnEndOutcome, watchedSinceMs: number): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TurnEndWatch {
  /** Take over a running turn from a page that is unmounting. Replaces an
   *  earlier hand-off of the same session. */
  watch(handoff: TurnEndHandoff): void;
  /** The page is mounted again: its stream announces from here. */
  release(projectId: string, sessionId: string): void;
  /** `projectId/sessionId` of every session watched right now. */
  watching(): string[];
}

interface WatchEntry {
  handoff: TurnEndHandoff;
  sinceMs: number;
  sawOpen: boolean;
  timer: unknown;
}

/** A read the server answered 403/404: the session is gone or no longer this
 *  person's to read. Retrying cannot change that. */
function isFinalReadError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

export function createTurnEndWatch(deps: TurnEndWatchDeps): TurnEndWatch {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const entries = new Map<string, WatchEntry>();
  const keyOf = (projectId: string, sessionId: string) => `${projectId}/${sessionId}`;

  function drop(key: string, entry: WatchEntry) {
    if (entries.get(key) !== entry) return;
    clearTimer(entry.timer);
    entries.delete(key);
  }

  function schedule(key: string, entry: WatchEntry, ms: number) {
    entry.timer = setTimer(() => void tick(key, entry), ms);
  }

  async function tick(key: string, entry: WatchEntry) {
    if (entries.get(key) !== entry) return;
    const { projectId, sessionId } = entry.handoff;
    let verdict: TurnEndVerdict | null = null;
    try {
      const read = await deps.readTurn(projectId, sessionId);
      // Released or replaced while the read was in flight: that answer is not ours.
      if (entries.get(key) !== entry) return;
      verdict = readTurnEnd(entry.handoff, read, entry.sawOpen);
    } catch (error) {
      if (entries.get(key) !== entry) return;
      if (isFinalReadError(error)) {
        drop(key, entry);
        return;
      }
      // A transient failure (offline, 5xx, an expired token mid-refresh) says
      // nothing about the turn: read again on the next tick.
    }
    const age = now() - entry.sinceMs;
    if (verdict?.state === 'ended') {
      drop(key, entry);
      deps.onEnded(entry.handoff, verdict.outcome, entry.sinceMs);
      return;
    }
    if (verdict?.state === 'running') entry.sawOpen = true;
    const waitingTooLong = verdict?.state === 'waiting' && !entry.sawOpen && age >= TURN_END_WATCH_START_MS;
    if (waitingTooLong || age >= TURN_END_WATCH_MAX_MS) {
      drop(key, entry);
      return;
    }
    schedule(key, entry, age >= TURN_END_WATCH_LONG_TURN_MS ? TURN_END_WATCH_SLOW_POLL_MS : TURN_END_WATCH_POLL_MS);
  }

  return {
    watch(handoff) {
      if (!handoff.projectId || !handoff.sessionId) return;
      const key = keyOf(handoff.projectId, handoff.sessionId);
      const previous = entries.get(key);
      if (previous) drop(key, previous);
      const entry: WatchEntry = { handoff, sinceMs: now(), sawOpen: false, timer: null };
      entries.set(key, entry);
      schedule(key, entry, TURN_END_WATCH_FIRST_READ_MS);
    },
    release(projectId, sessionId) {
      const key = keyOf(projectId, sessionId);
      const entry = entries.get(key);
      if (entry) drop(key, entry);
    },
    watching() {
      return [...entries.keys()];
    },
  };
}
