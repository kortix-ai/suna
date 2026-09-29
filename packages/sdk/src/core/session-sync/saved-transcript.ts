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

import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';

export type SavedTranscript = 'loading' | 'shown' | 'none';

export interface SavedTranscriptInput {
  /** The session hook is running its reads (it waits for a signed-in user). */
  enabled: boolean;
  /** The store holds at least one message for this session's root. */
  hasMessages: boolean;
  /**
   * The saved-history read (`GET …/transcript?history=true`), which paints
   * the copy when the project's `session_transcript_history` flag is on.
   * `off` when the flag is off.
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
    envelope.messages.length === 0 &&
    envelope.opencode_session_id
    ? envelope.opencode_session_id
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
