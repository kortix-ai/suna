/**
 * The device's saved copy of a v2 session: the newest session-log page of its root thread,
 * kept beside the v1 copies (`createSavedCopyStore`) under its own key
 * (`<namespace>.log:<user>:<project>/<session>`). A v1 copy of the same session is dropped when
 * the v2 copy is written, so a device cache an older SDK wrote refills from the API. Every
 * read validates the page (`isSessionLogPage`); the v1 copy is cast as it is read.
 * Internal: hosts keep calling `createSavedCopyStore` and `setSavedCopyStore`.
 */
import type { CopyCodec, CopyStore, StoredCopy } from '../session-sync/copy-store-types';
import type { SavedCopyStore } from '../session-sync/saved-copy-store';
import { isSessionLogPage } from './guard';
import type { SessionLogPage } from './source';

/** A page worth painting: valid and not empty. */
const paintable = (page: SessionLogPage | null | undefined): page is SessionLogPage =>
  isSessionLogPage(page) && page.messages.length > 0;

/**
 * The copy within `maxChars`: whole, else its newest messages that fit with `has_more` set.
 * ponytail: re-serializes per dropped message (O(n²) on the 40-message first window); measure before a larger page.
 */
function fit(stored: StoredCopy<SessionLogPage>, maxChars: number): string | null {
  const { messages } = stored.e;
  for (let from = 0; from < messages.length; from++) {
    const text = JSON.stringify(from === 0 ? stored : { ...stored, e: { ...stored.e, messages: messages.slice(from), has_more: true } });
    if (text.length <= maxChars) return text;
  }
  return null;
}

export const SESSION_LOG_COPY: CopyCodec<SessionLogPage> = { paintable, fit, capturedAt: () => 0 };

/** The v2 copies of one `SavedCopyStore`. */
export interface SessionLogCopies {
  read(projectId: string, sessionId: string): SessionLogPage | null | Promise<SessionLogPage | null>;
  /** Keep `page` as the session's v2 copy, and drop its v1 copy. */
  write(projectId: string, sessionId: string, page: SessionLogPage): Promise<void>;
}

// replica-local: one entry per store this client created; a WeakMap, so it goes with the store.
const copies = new WeakMap<SavedCopyStore, SessionLogCopies>();

/** Called by `createSavedCopyStore` with the store it built for the v2 copies and its v1-only removal. */
export function registerSessionLogCopies(
  store: SavedCopyStore,
  v2: CopyStore<SessionLogPage>,
  removeV1: (projectId: string, sessionId: string) => Promise<void>,
): void {
  copies.set(store, {
    read: (projectId, sessionId) => v2.read(projectId, sessionId),
    write: async (projectId, sessionId, page) => {
      await v2.write(projectId, sessionId, page);
      await removeV1(projectId, sessionId);
    },
  });
}

/** The v2 copies of `store`, or null for a store `createSavedCopyStore` did not build. */
export function savedSessionLogCopies(store: SavedCopyStore | null | undefined): SessionLogCopies | null {
  return (store && copies.get(store)) ?? null;
}
