/**
 * saved-copy — the thread while its computer wakes.
 *
 * Opening a session showed `SessionConnecting`'s loader for the whole wake of
 * its computer, up to minutes, although the control plane holds a saved copy
 * of the conversation (the one it writes when a turn ends) and the device kept
 * the last copy it saw. This paints that copy into the sync store under the
 * session's OpenCode root, so the connecting view and then `SessionPage` show
 * the same messages: the kept copy first, the server's next.
 *
 * Painted with `source: 'cache'`: the messages stay provisional until the first
 * runtime read settles them (`sync-store.ts`). Only a server capture is ever
 * painted or kept, never the live transcript, and only for the session's own
 * root, so a copy from a re-pinned box cannot turn into ghosts.
 *
 * Pure data and pure functions plus the store: `bun test` loads this module.
 * The host passes the device storage to `createSavedCopyStore` elsewhere.
 */

import {
  currentSavedCopyStore,
  getSessionTranscriptSync,
  getSessionTurn,
  isEmptyConversation,
  isPaintableSavedCopy,
  savedCopyEmptyRoot,
  type SessionTranscriptSyncEnvelope,
} from '@kortix/sdk';

import { hasOnlyCacheSourcedMessages, useSyncStore } from '@/lib/opencode/sync-store';
import type { MessageWithParts } from '@/lib/opencode/types';

/** As many messages as the web's first paint, so both hosts show one window. */
export const SAVED_COPY_LIMIT = 40;

/** The envelope's messages in the store's shape. A message without an id is dropped, never given one. */
export function savedCopyMessages(envelope: SessionTranscriptSyncEnvelope): MessageWithParts[] {
  const out: MessageWithParts[] = [];
  for (const row of envelope.messages) {
    const info = row?.info as unknown as MessageWithParts['info'] | undefined;
    if (!info || typeof info.id !== 'string' || !info.id) continue;
    const parts = (Array.isArray(row.parts) ? row.parts : []) as unknown as MessageWithParts['parts'];
    out.push({ info, parts });
  }
  return out;
}

/**
 * Paint `envelope` into the store for `rootId`, when it may: a paintable copy of
 * that root, over nothing or over an earlier saved copy — never over messages a
 * runtime read or a live event produced. Returns whether it painted.
 */
export function paintSavedCopy(rootId: string, envelope: SessionTranscriptSyncEnvelope | null): boolean {
  if (!rootId || !isPaintableSavedCopy(envelope) || envelope.opencode_session_id !== rootId) return false;
  const state = useSyncStore.getState();
  const held = state.messages[rootId]?.length ?? 0;
  if (held > 0 && !hasOnlyCacheSourcedMessages(rootId)) return false;
  state.hydrate(rootId, savedCopyMessages(envelope), { source: 'cache' });
  return true;
}

function capturedAt(envelope: SessionTranscriptSyncEnvelope | null): number {
  const parsed = envelope?.captured_at ? Date.parse(envelope.captured_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SavedCopyOutcome {
  /**
   * The conversation is proven empty, with nothing to wait for: the server's
   * saved copy proves this root empty, and the turn record shows no turn that
   * ended since and none open (`isEmptyConversation`). The view opens on its
   * composer instead of a loader.
   */
  empty: boolean;
}

const NOTHING_PROVEN: SavedCopyOutcome = { empty: false };

/**
 * Paint the copy this device kept, then the server's, and keep the server's for
 * the next open. Never throws: a failed read leaves the kept copy on screen and
 * on the device.
 *
 * `child`: `rootId` is a sub-agent of the session, in its own OpenCode session.
 * Its own saved window is painted, and nothing is kept: the device slot is the
 * conversation's copy.
 */
export async function loadSavedCopy(input: {
  projectId: string;
  sessionId: string;
  rootId: string;
  child?: boolean;
}): Promise<SavedCopyOutcome> {
  const { projectId, sessionId, rootId } = input;
  if (!projectId || !sessionId || !rootId) return NOTHING_PROVEN;

  if (input.child) {
    try {
      paintSavedCopy(
        rootId,
        await getSessionTranscriptSync(projectId, sessionId, { limit: SAVED_COPY_LIMIT, child: rootId }),
      );
    } catch {
      // The sub-agent waits for the computer, as it did before.
    }
    return NOTHING_PROVEN;
  }

  const store = currentSavedCopyStore();

  let kept: SessionTranscriptSyncEnvelope | null = null;
  if (store) {
    try {
      kept = await store.read(projectId, sessionId);
    } catch {
      kept = null;
    }
    paintSavedCopy(rootId, kept);
  }

  let fresh: SessionTranscriptSyncEnvelope | null = null;
  try {
    fresh = await getSessionTranscriptSync(projectId, sessionId, { limit: SAVED_COPY_LIMIT });
  } catch {
    return NOTHING_PROVEN;
  }
  if (!fresh) return NOTHING_PROVEN;
  // An answer older than the kept copy (a stale in-flight read) never paints over it.
  const olderThanKept = !!kept && capturedAt(fresh) > 0 && capturedAt(fresh) < capturedAt(kept);
  if (!olderThanKept) paintSavedCopy(rootId, fresh);
  // Kept for the next open after it painted: the write never delays the paint.
  if (store) await store.write(projectId, sessionId, fresh).catch(() => undefined);

  if (savedCopyEmptyRoot(fresh) !== rootId) return NOTHING_PROVEN;
  // A turn that ended after the capture, or one open now, says the copy is
  // older than the conversation.
  try {
    const turn = await getSessionTurn(projectId, sessionId);
    return {
      empty: isEmptyConversation({
        savedEmptyRoot: rootId,
        rootSessionId: rootId,
        turnRead: true,
        hasEndedTurn: turn.last_ended != null,
        hasOpenOrQueuedTurn: turn.turns.length > 0,
      }),
    };
  } catch {
    return NOTHING_PROVEN;
  }
}
