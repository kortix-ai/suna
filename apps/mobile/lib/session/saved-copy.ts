/**
 * saved-copy — the thread while its computer wakes.
 *
 * Opening a session showed `SessionConnecting`'s loader for the whole wake of
 * its computer, up to minutes, although the control plane holds a saved copy
 * of the conversation (the one it writes when a turn ends) and the device kept
 * the last copy it saw. `@kortix/sdk` paints both (`useSessionSync`: the kept
 * copy first, the server's next, provisional until the first runtime read
 * settles them). This module reads the server's copy once for it, and answers
 * the one question the SDK's paint does not: is the conversation proven empty?
 *
 * Pure data and pure functions: `bun test` loads this module.
 */

import {
  getSessionTranscriptSync,
  getSessionTurn,
  isEmptyConversation,
  savedCopyEmptyRoot,
  type SessionTranscriptSyncEnvelope,
} from '@kortix/sdk';

/** As many messages as the web's first paint, so both hosts show one window. */
export const SAVED_COPY_LIMIT = 40;

export interface SavedCopyRead {
  /** The server's saved copy, or null when the read failed or there is none. */
  envelope: SessionTranscriptSyncEnvelope | null;
  /**
   * The conversation is proven empty, with nothing to wait for: the server's
   * saved copy proves this root empty, and the turn record shows no turn that
   * ended since and none open (`isEmptyConversation`). The view opens on its
   * composer instead of a loader.
   */
  empty: boolean;
}

const NOTHING: SavedCopyRead = { envelope: null, empty: false };

/**
 * Read the server's saved copy of a session. Never throws: a failed read
 * leaves the copy the device kept on screen.
 *
 * `child`: `rootId` is a sub-agent of the session, in its own runtime session.
 * Its own saved window is read, and emptiness is never claimed for it.
 */
export async function readSavedCopy(input: {
  projectId: string;
  sessionId: string;
  rootId: string;
  child?: boolean;
}): Promise<SavedCopyRead> {
  const { projectId, sessionId, rootId } = input;
  if (!projectId || !sessionId || !rootId) return NOTHING;

  let envelope: SessionTranscriptSyncEnvelope | null = null;
  try {
    envelope = await getSessionTranscriptSync(projectId, sessionId, {
      limit: SAVED_COPY_LIMIT,
      ...(input.child ? { child: rootId } : {}),
    });
  } catch {
    return NOTHING;
  }
  if (!envelope) return NOTHING;
  if (input.child || savedCopyEmptyRoot(envelope) !== rootId) return { envelope, empty: false };

  // A turn that ended after the capture, or one open now, says the copy is
  // older than the conversation.
  try {
    const turn = await getSessionTurn(projectId, sessionId);
    return {
      envelope,
      empty: isEmptyConversation({
        savedEmptyRoot: rootId,
        rootSessionId: rootId,
        turnRead: true,
        hasEndedTurn: turn.last_ended != null,
        hasOpenOrQueuedTurn: turn.turns.length > 0,
      }),
    };
  } catch {
    return { envelope, empty: false };
  }
}
