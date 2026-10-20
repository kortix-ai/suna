/**
 * Can this session show its saved conversation before its computer wakes?
 *
 * The control plane keeps a copy of every session's transcript (the mirror,
 * written at each turn end). It answers in one round trip; the computer takes
 * 5-240 s to wake. A host that knows a saved copy is on its way shows the
 * session with placeholder rows for that one round trip. A host that knows
 * there is none shows its boot screen, because nothing can be read until the
 * runtime is up. This decides which of the two is true, from what the session
 * hook already tracks:
 *
 *   `loading` — a saved copy may still paint: a read is in flight, or the
 *               OpenCode root it is keyed by is still resolving.
 *   `shown`   — the store holds messages for this session (saved or live).
 *   `none`    — nothing can paint before the runtime answers: the saved copy
 *               is absent or was refused, or no root is known and no
 *               control-plane read is left that could supply one.
 *
 * `none` is only ever an answer the server gave. A hook that has not started
 * its reads yet (no signed-in user) says `loading`: an unknown is never
 * rendered as a negative.
 */

import {
  type SessionTranscriptSyncEnvelope,
  getSessionTranscriptSync,
  getSessionTurn,
} from '../rest/projects-client/sessions';
import {
  OPEN_BUNDLE_TRANSCRIPT_LIMIT,
  claimOpenBundle,
  heldSavedWindow,
  holdSavedWindow,
  openBundleHistory,
} from '../session/open-bundle';
import { fetchFirstSessionLogPage, loadSessionLogPage, type SessionLogPage } from '../session-log/source';
import { EMPTY_SESSION_LOG_STATE, applySessionLogPage } from '../session-log/store';
import { sessionLogRoot } from '../session-log/v1-view';

/**
 * How long the saved-history read waits for a session-open snapshot in
 * flight. The snapshot is DB-only and answers well inside it; a slower one
 * loses to the route, so saved history never waits on a hung snapshot (the
 * request timeout is 30 s). That case downloads the window twice.
 */
export const SAVED_HISTORY_SNAPSHOT_WAIT_MS = 2_000;

/**
 * THE saved-history read: the newest window of the session's saved copy, for
 * its current root. Every reader of a session's saved copy uses it: the web
 * (`useSession`), mobile (`readSavedSessionCopy`) and `useSessionSync` for a
 * host that passes no `mirror`.
 *
 * A window a host read before the bind ({@link readSavedSessionCopy}) answers
 * first, with no request. The session-open snapshot carries the same window,
 * so a snapshot in flight or just answered serves it. The read WAITS for one
 * in flight (up to {@link SAVED_HISTORY_SNAPSHOT_WAIT_MS}), as the row, `/turn`
 * and `/prompts` reads do: racing it downloaded the window twice. Otherwise
 * `GET …/transcript?shape=sync&history=true`. Throws when that route fails.
 */
export async function loadSavedTranscript(
  projectId: string,
  sessionId: string,
  options: { signal?: AbortSignal; /** Tests only. */ snapshotWaitMs?: number } = {},
): Promise<SessionTranscriptSyncEnvelope> {
  return heldSavedWindow(projectId, sessionId) ?? readSavedWindow(projectId, sessionId, options);
}

/** The window from the snapshot or the route. A held window never answers it. */
async function readSavedWindow(
  projectId: string,
  sessionId: string,
  options: { signal?: AbortSignal; snapshotWaitMs?: number },
): Promise<SessionTranscriptSyncEnvelope> {
  const claimed = claimOpenBundle(projectId, sessionId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bundle = claimed
    ? await Promise.race([
        claimed,
        new Promise<null>((resolve) => {
          timer = setTimeout(resolve, options.snapshotWaitMs ?? SAVED_HISTORY_SNAPSHOT_WAIT_MS, null);
        }),
      ]).finally(() => clearTimeout(timer))
    : null;
  return (
    (bundle && openBundleHistory(bundle)) ??
    getSessionTranscriptSync(projectId, sessionId, {
      limit: OPEN_BUNDLE_TRANSCRIPT_LIMIT,
      history: true,
      signal: options.signal,
    })
  );
}

export interface SavedSessionCopy {
  /** The server's saved copy, or null when the read failed. */
  envelope: SessionTranscriptSyncEnvelope | null;
  /**
   * The conversation is proven empty, with nothing to wait for
   * ({@link isEmptyConversation}): show the composer, not a boot screen.
   */
  empty: boolean;
  /**
   * With `sessionLog`: the session log's newest page of the root thread (`GET …/log`), or
   * null when the session has no stored log or the read failed. Absent without `sessionLog`.
   */
  log?: SessionLogPage | null;
}

/**
 * The saved copy of a session, for a host that shows the session before
 * `useSession` binds it (a connecting view while the computer wakes). Hand
 * `envelope` to `useSessionSync` as `mirror` to paint it.
 *
 * Reads the current copy, from the snapshot or the route as
 * {@link loadSavedTranscript} does, and the turn record only when the copy
 * proves `runtimeSessionId` empty. Never throws: a failed read answers
 * `{ envelope: null, empty: false }`. A sub-agent's window is not read here:
 * `useSessionSync` with `savedChild` reads it.
 *
 * The copy stays held for the session's open, up to `SAVED_WINDOW_HOLD_MS`:
 * the snapshot `useSession` starts at the bind then asks for the pointer only,
 * and the saved-history read after the bind answers from the held copy. The
 * window is downloaded once per open (KRTX-189).
 *
 * With `sessionLog` (the project flag `session_log` on) the copy is the session log's
 * newest page (`log`, `envelope: null`): the host puts it in the session store
 * (`applySessionLogPage`) and renders `useSessionLogThread`, which loads a sub-agent's
 * thread from the heads that page names. `useSession` reads the page again at the bind.
 */
export async function readSavedSessionCopy(input: {
  projectId: string;
  /** The Kortix session id. */
  sessionId: string;
  /** The runtime session the copy belongs to (the root). */
  runtimeSessionId: string;
  /**
   * The project flag `session_log` is on: the session log is the saved copy. Reads its
   * newest page (`log`), never the v1 window (`GET …/transcript`), and holds nothing.
   */
  sessionLog?: boolean;
}): Promise<SavedSessionCopy> {
  const { projectId, sessionId, runtimeSessionId } = input;
  if (!projectId || !sessionId || !runtimeSessionId) return { envelope: null, empty: false };
  if (input.sessionLog) {
    const log = loadSessionLogPage ? await fetchFirstSessionLogPage(loadSessionLogPage, projectId, sessionId) : null;
    const root = log && sessionLogRoot(applySessionLogPage(EMPTY_SESSION_LOG_STATE, log));
    const provenEmpty = !!root?.empty && root.runtimeSessionId === runtimeSessionId;
    return { envelope: null, empty: provenEmpty && (await noTurnSince(projectId, sessionId, runtimeSessionId)), log };
  }
  let envelope: SessionTranscriptSyncEnvelope;
  try {
    envelope = await readSavedWindow(projectId, sessionId, {});
  } catch {
    return { envelope: null, empty: false };
  }
  holdSavedWindow(projectId, sessionId, envelope);
  if (savedCopyEmptyRoot(envelope) !== runtimeSessionId) return { envelope, empty: false };
  return { envelope, empty: await noTurnSince(projectId, sessionId, runtimeSessionId) };
}

/**
 * A copy proved `runtimeSessionId` empty: no turn ended since and none is open (the copy is
 * not older than the conversation). An unanswered turn record is an unknown: false.
 */
async function noTurnSince(projectId: string, sessionId: string, runtimeSessionId: string): Promise<boolean> {
  try {
    const turn = await getSessionTurn(projectId, sessionId);
    return isEmptyConversation({
      savedEmptyRoot: runtimeSessionId,
      rootSessionId: runtimeSessionId,
      turnRead: true,
      hasEndedTurn: turn.last_ended != null,
      hasOpenOrQueuedTurn: turn.turns.length > 0,
    });
  } catch {
    return false;
  }
}

export type SavedTranscript = 'loading' | 'shown' | 'none';

export interface SavedTranscriptInput {
  /** The session hook is running its reads (it waits for a signed-in user). */
  enabled: boolean;
  /** The store holds at least one message for this session's root. */
  hasMessages: boolean;
  /**
   * The saved-history read (`GET …/transcript?history=true`), which paints
   * the copy. `off` when the host does not run it.
   */
  history: 'off' | 'loading' | 'present' | 'absent';
  /**
   * The mirror paint in `useSessionSync`: `idle` until it can run (no root
   * yet), `loading` while its read is in flight, `painted` once it hydrated,
   * `absent` when the read answered with nothing it may paint.
   */
  mirror: 'idle' | 'loading' | 'painted' | 'absent';
  /**
   * The OpenCode root the transcript is keyed by: `known`, `pending` while a
   * control-plane read that can supply it is outstanding, or `unknown` when
   * none is left (only the runtime can name it now).
   */
  root: 'known' | 'pending' | 'unknown';
  /**
   * The saved copy proves this root's conversation empty, and the turn record
   * has not answered yet. The host's next surface is then the composer or the
   * boot screen, and it cannot tell which: see {@link isEmptyConversation}.
   */
  emptyAwaitingTurnRead?: boolean;
}

export function resolveSavedTranscript(input: SavedTranscriptInput): SavedTranscript {
  if (input.hasMessages) return 'shown';
  if (!input.enabled) return 'loading';
  if (input.emptyAwaitingTurnRead) return 'loading';
  if (input.history === 'absent') return 'none';
  if (input.history === 'loading') return 'loading';
  if (input.root === 'unknown') return 'none';
  if (input.root === 'pending') return 'loading';
  if (input.mirror === 'absent') return 'none';
  return 'loading';
}

/**
 * The OpenCode root a saved window proves EMPTY, or null.
 *
 * The proof is the server's: a complete read of the runtime that found no
 * messages, served as an available, complete window that counts zero. `total`
 * must say so explicitly; an older API sends none and never answers an empty
 * window as available.
 */
export function savedCopyEmptyRoot(
  envelope: SessionTranscriptSyncEnvelope | null | undefined,
): string | null {
  return envelope?.available &&
    envelope.source === 'mirror' &&
    envelope.complete &&
    envelope.total === 0 &&
    envelope.messages.length === 0
    ? (envelope.runtime_session_id ?? envelope.opencode_session_id ?? null)
    : null;
}

export interface EmptyConversationInput {
  /**
   * The OpenCode root the server's saved copy proves empty: a complete read of
   * the runtime found no messages (`total: 0`). Null when no copy proves it.
   */
  savedEmptyRoot: string | null;
  /** The OpenCode root this session's transcript is keyed by, or `''`. */
  rootSessionId: string;
  /** The server's turn record (`GET …/turn`) has answered. */
  turnRead: boolean;
  /** That record names a turn that ended (`last_ended`). */
  hasEndedTurn: boolean;
  /** A turn is open, working, or waiting in the prompt inbox. */
  hasOpenOrQueuedTurn: boolean;
}

/**
 * Is this session's conversation empty, with nothing to wait for?
 *
 * Only a positive record answers yes: the saved copy of THIS root proves the
 * conversation empty, and the turn record shows no turn ended since and none
 * open or queued. Absent records are never evidence. The turn ledger exists
 * since 2026-08-17 and its writes are best-effort, so "no turn ever ended" is
 * also what an older session with history says before its first wake.
 *
 * A host shows an empty conversation its composer instead of a boot screen:
 * no saved copy will paint, and the computer holds no messages. Any read
 * still in flight answers `false`.
 */
export function isEmptyConversation(input: EmptyConversationInput): boolean {
  return (
    input.savedEmptyRoot !== null &&
    input.savedEmptyRoot === input.rootSessionId &&
    input.turnRead &&
    !input.hasEndedTurn &&
    !input.hasOpenOrQueuedTurn
  );
}
