/**
 * Internal types of the device's saved copies (`saved-copy-store.ts`), shared with the v2
 * copy of the session log (`../session-log/saved-log.ts`). Kept out of `saved-copy-store.ts`,
 * which the package root re-exports whole: none of these is public.
 */
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';

/** One kept copy. `e` is the payload: a v1 envelope, or a v2 session-log page (`saved-log.ts`). */
export interface StoredCopy<T = SessionTranscriptSyncEnvelope> {
  v: number;
  user: string;
  at: number;
  e: T;
}

/** What a kind of copy needs from the store: when it may be painted, how it is cut to size, its capture time. */
export interface CopyCodec<T> {
  paintable(value: T | null | undefined): value is T;
  /** The serialized copy within `maxChars`, or null when nothing worth keeping fits. */
  fit(stored: StoredCopy<T>, maxChars: number): string | null;
  capturedAt(value: T): number;
}

/** The store over one kind of copy; `SavedCopyStore` is this over the v1 envelope. */
export interface CopyStore<T> {
  keyFor(projectId: string, sessionId: string): string;
  read(projectId: string, sessionId: string): T | null | Promise<T | null>;
  write(projectId: string, sessionId: string, value: T): Promise<void>;
  remove(projectId: string, sessionId: string): Promise<void>;
  clear(): Promise<void>;
}
