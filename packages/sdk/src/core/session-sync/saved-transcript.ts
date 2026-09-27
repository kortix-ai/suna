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
}

export function resolveSavedTranscript(input: SavedTranscriptInput): SavedTranscript {
  if (input.hasMessages) return 'shown';
  if (!input.enabled) return 'loading';
  if (input.history === 'absent') return 'none';
  if (input.history === 'loading') return 'loading';
  if (input.root === 'unknown') return 'none';
  if (input.root === 'pending') return 'loading';
  if (input.mirror === 'absent') return 'none';
  return 'loading';
}
