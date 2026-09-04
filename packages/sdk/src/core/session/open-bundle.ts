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
 * WHY THE TRANSCRIPT IS A SEPARATE, ONE-SHOT STASH. The mirror is hydrated once
 * the session's OpenCode root is known, which on a cold box is 18.9-24.5 s after
 * the open (measured) — long past the share window the turn and queue legs want.
 * It is also the one leg that must never be served twice: a second hydrate over
 * a store the runtime has already filled is how a transcript grows ghosts.
 *
 * EVERY LEG IS TRI-STATE. `known: false` projects to `null`, which sends the
 * consumer to its endpoint. It must never project to the NEGATIVE answer — an
 * empty queue, an idle turn, an empty thread — because a default rendered as an
 * answer is the defect the bundle exists to remove.
 */

import {
  type SessionOpenBundle,
  type SessionPrompt,
  type SessionTranscriptSyncEnvelope,
  type SessionTurn,
  type SessionTurnEnded,
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

/** How long the one-shot transcript stash survives. Sized for the slowest
 *  measured cold box (24.5 s Platinum) with headroom, because the hydrate that
 *  consumes it cannot run until the runtime identity resolves. */
export const OPEN_BUNDLE_TRANSCRIPT_TTL_MS = 60_000;

/** The mirrored-message window an open asks for — the same span the sync
 *  controller's own first read covers. */
export const OPEN_BUNDLE_TRANSCRIPT_LIMIT = 40;

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

interface TranscriptStash {
  envelope: SessionTranscriptSyncEnvelope;
  stashedAtMs: number;
}

const entries = new Map<string, BundleEntry>();
const transcripts = new Map<string, TranscriptStash>();

function scopeKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

/** Drop everything. Tests only — a module singleton with no reset is a test
 *  that passes because of the one before it. */
export function resetSessionOpenBundles(): void {
  entries.clear();
  transcripts.clear();
}

export interface OpenSessionBundleOptions {
  /** Mirrored messages to ask for. `0` requests the POINTER only — what a
   *  client whose store is already warm wants. */
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
      transcript: options.transcript ?? OPEN_BUNDLE_TRANSCRIPT_LIMIT,
    })
      .then((bundle) => {
        stashTranscript(key, bundle, now());
        return bundle;
      })
      .catch(() => null),
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

function stashTranscript(key: string, bundle: SessionOpenBundle, nowMs: number): void {
  const transcript = bundle.transcript;
  if (!transcript || transcript.known !== true || transcript.requested !== true) return;
  // An unavailable mirror is not a transcript. Stashing it would let a hydrate
  // paint an empty thread as a complete one.
  if (!transcript.available || transcript.messages.length === 0) return;
  const { known: _known, requested: _requested, ...envelope } = transcript;
  transcripts.set(key, { envelope, stashedAtMs: nowMs });
}

/**
 * Take the mirrored transcript this open fetched, ONCE.
 *
 * One-shot by design: the hydrate that consumes it is the only reader that may
 * paint a snapshot, and a second paint over a store the runtime has already
 * filled is how a transcript grows ghosts.
 */
export function takeOpenBundleTranscript(
  projectId: string,
  sessionId: string,
  nowMs: number = Date.now(),
): SessionTranscriptSyncEnvelope | null {
  const key = scopeKey(projectId, sessionId);
  const stash = transcripts.get(key);
  if (!stash) return null;
  transcripts.delete(key);
  if (nowMs - stash.stashedAtMs > OPEN_BUNDLE_TRANSCRIPT_TTL_MS) return null;
  return stash.envelope;
}
