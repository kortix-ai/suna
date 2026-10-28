/**
 * ONE session-open read, shared by every consumer that would otherwise issue
 * its own.
 *
 * THE PROBLEM. Opening a session made 6 serial control-plane round trips before
 * the first honest frame — the session row, `/turn`, `/prompts`,
 * `/transcript?shape=sync`, `/detail`, `/model-defaults` — and then kept making
 * them, because the hooks that need those facts each own their own query. On a
 * real deployment that is 0.3-2.3 s per read at the median (measured over 20
 * session opens, 2026-08-26), and the last one cannot start until the first
 * lands.
 *
 * THE SHAPE. `GET .../open-bundle` answers all of it at once, and this module
 * is the seam that lets the EXISTING consumers use it without knowing it exists:
 *
 *   1. The open path calls `openSessionBundle()` ONCE, in a LAYOUT effect. React
 *      runs every layout effect, tree-wide, before any passive effect, and
 *      TanStack starts a query's fetch from a passive effect — so the bundle is
 *      always in flight before the first `/turn` or `/prompts` fetch begins.
 *   2. Each consumer's own `queryFn` calls `claimOpenBundle()` FIRST. A claim
 *      returns the shared promise while the bundle is in flight, or the resolved
 *      bundle inside a short share window, and `null` otherwise.
 *   3. `null` means "answer the way you always did". Every consumer keeps its
 *      own endpoint, so an old server, a failed bundle and a steady-state poll
 *      all still work. The bundle is an ACCELERATOR, never a dependency.
 *
 * WHY A CLAIM CANNOT START ONE. A `/turn` poll that could start a bundle would
 * re-read the transcript and the model catalogue every 15 s for the life of the
 * tab. Starting is the open path's decision; claiming is everyone else's.
 *
 * THE TRANSCRIPT LEG is not read: an open asks for the pointer only
 * (`transcript: 0`). The session log's first page (`GET …/log`) is the saved
 * history, and no client reads the v1 window (P8.3).
 *
 * EVERY LEG IS TRI-STATE. `known: false` projects to `null`, which sends the
 * consumer to its endpoint. It must never project to the NEGATIVE answer — an
 * empty queue, an idle turn, an empty thread — because a default rendered as an
 * answer is the defect the bundle exists to remove.
 */

import {
  type SessionAudit,
  type SessionOpenBundle,
  type SessionPrompt,
  type SessionTurn,
  type SessionTurnEnded,
  type SessionTurnFailure,
  getSessionOpenBundle,
} from '../rest/projects-client/sessions';

/**
 * How long a resolved bundle keeps answering claims.
 *
 * It only has to outlast ONE session open's burst of first reads, not the
 * session. Long enough and the steady-state `/turn` poll (5 s working / 15 s
 * idle) would be answered from a snapshot instead of from the server; this
 * window sits just under the fastest of those cadences on purpose.
 */
export const OPEN_BUNDLE_SHARE_MS = 5_000;

interface BundleEntry {
  /** Resolves to the bundle, or to `null` when the read failed. NEVER rejects:
   *  a consumer awaiting a claim is on its own critical path. */
  promise: Promise<SessionOpenBundle | null>;
  startedAtMs: number;
  /** Set the instant `promise` settles, so a claim can tell "still in flight"
   *  (always claimable) from "resolved a while ago" (claimable only inside the
   *  share window). */
  settledAtMs: number | null;
}

const entries = new Map<string, BundleEntry>();

function scopeKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

/** Drop everything: on an identity change (`resetIdentityState`), and in
 *  tests — a module singleton with no reset is a test that passes because of
 *  the one before it. */
export function resetSessionOpenBundles(): void {
  entries.clear();
}

export interface OpenSessionBundleOptions {
  /** v1 transcript messages to ask for. Default `0`: the POINTER only. An
   *  open reads the session log (`GET …/log`), so no host reads the
   *  snapshot's v1 window. */
  transcript?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

/**
 * Start the session-open read for `(projectId, sessionId)`.
 *
 * Fire-and-forget and idempotent within the share window: calling it twice for
 * one open (two hooks, StrictMode's double mount) issues one request. Never
 * throws and never rejects — a failed bundle simply resolves `null` and every
 * consumer falls back to its own endpoint.
 */
export function openSessionBundle(
  projectId: string,
  sessionId: string,
  options: OpenSessionBundleOptions = {},
): void {
  if (!projectId || !sessionId) return;
  const now = options.now ?? Date.now;
  const nowMs = now();
  const key = scopeKey(projectId, sessionId);
  const existing = entries.get(key);
  if (existing && claimable(existing, nowMs)) return;

  const entry: BundleEntry = {
    startedAtMs: nowMs,
    settledAtMs: null,
    promise: getSessionOpenBundle(projectId, sessionId, {
      transcript: options.transcript ?? 0,
    }).catch(() => null),
  };
  entry.promise = entry.promise.then((bundle) => {
    entry.settledAtMs = now();
    return bundle;
  });
  entries.set(key, entry);
}

function claimable(entry: BundleEntry, nowMs: number): boolean {
  // In flight is always claimable: the consumer that asks is precisely the one
  // this read was started for.
  if (entry.settledAtMs === null) return true;
  return nowMs - entry.settledAtMs <= OPEN_BUNDLE_SHARE_MS;
}

/**
 * Claim the in-flight or freshly-resolved bundle for this session.
 *
 * Returns the shared promise, or `null` when there is nothing to share — which
 * is the signal to read the endpoint the normal way. Synchronous in the `null`
 * case on purpose: a consumer must be able to decide without awaiting.
 */
export function claimOpenBundle(
  projectId: string,
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<SessionOpenBundle | null> | null {
  if (!projectId || !sessionId) return null;
  const key = scopeKey(projectId, sessionId);
  const entry = entries.get(key);
  if (!entry) return null;
  if (!claimable(entry, nowMs)) {
    entries.delete(key);
    return null;
  }
  return entry.promise;
}

/** One `GET .../turn` answer plus the instant the SERVER took it. Structurally
 *  the observation `useSessionWorking` stamps for itself — the ranking rule it
 *  feeds only works if the stamp is the read's own instant, never arrival. */
export interface OpenBundleTurnObservation {
  turns: SessionTurn[];
  last_ended: SessionTurnEnded | undefined;
  recent_failures?: SessionTurnFailure[];
  /** The caller's `can_stop` (`SessionTurnStatus`). Absent from an older server. */
  can_stop?: boolean;
  atMs: number;
}

/**
 * Project the turn leg. `null` for an unknown leg — never `{ turns: [] }`,
 * which would be an idle claim made by something that did not know.
 */
export function openBundleTurn(bundle: SessionOpenBundle): OpenBundleTurnObservation | null {
  const turn = bundle.turn;
  if (!turn || turn.known !== true) return null;
  const observedAtMs = Date.parse(bundle.observed_at);
  return {
    turns: turn.turns ?? [],
    last_ended: turn.last_ended,
    recent_failures: turn.recent_failures,
    ...(typeof turn.can_stop === 'boolean' ? { can_stop: turn.can_stop } : {}),
    atMs: Number.isFinite(observedAtMs) ? observedAtMs : Date.now(),
  };
}

/** Project the queue leg. `null` for an unknown leg — never `[]`, which would
 *  render as "nothing queued" for a queue nobody could read. */
export function openBundleQueue(bundle: SessionOpenBundle): SessionPrompt[] | null {
  const queue = bundle.queue;
  if (!queue || queue.known !== true) return null;
  return queue.prompts ?? [];
}

/** Project the audit leg onto the exact shape `getSessionAudit(...,
 *  { includeEvents: false })` returns — `events`/`next_cursor` simply absent,
 *  which `SessionAudit` already declares optional. `null` for an unknown leg
 *  — never `{ actions: [] }`, which would read as "nothing pending" for a
 *  leg that could not answer. */
export function openBundleAudit(bundle: SessionOpenBundle): SessionAudit | null {
  const audit = bundle.audit;
  if (!audit || audit.known !== true) return null;
  return {
    session_id: audit.session_id,
    agent: audit.agent,
    audit_access: audit.audit_access,
    count: audit.count,
    actions: audit.actions,
  };
}
