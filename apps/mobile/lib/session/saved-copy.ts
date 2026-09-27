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
  isPaintableSavedCopy,
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

/**
 * Paint the copy this device kept, then the server's, and keep the server's for
 * the next open. Never throws: a failed read leaves the kept copy on screen and
 * on the device.
 */
export async function loadSavedCopy(input: {
  projectId: string;
  sessionId: string;
  rootId: string;
}): Promise<void> {
  const { projectId, sessionId, rootId } = input;
  if (!projectId || !sessionId || !rootId) return;
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
    return;
  }
  if (!fresh) return;
  // An answer older than the kept copy (a stale in-flight read) never paints over it.
  const olderThanKept = !!kept && capturedAt(fresh) > 0 && capturedAt(fresh) < capturedAt(kept);
  if (!olderThanKept) paintSavedCopy(rootId, fresh);
  // Kept for the next open after it painted: the write never delays the paint.
  if (store) await store.write(projectId, sessionId, fresh).catch(() => undefined);
}
