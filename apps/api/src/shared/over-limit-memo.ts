/**
 * "This project was over the cap": remembered per producer for 6 h.
 *
 * Three producers read a project's whole tree at one commit: the config
 * release archive, the project snapshot and the fast-boot bundle. On a partial
 * object store (`projects/git/object-store.ts`) each must first download every
 * blob it packs, bounded by its cap. A repository over that cap stays over it
 * on the next push, so without a memo every tip move pays a capped download
 * that is thrown away.
 *
 * A wrong entry is cheap: the producer reports "too large" and the box uses
 * its existing fallback (it builds the config from its checkout, it clones).
 * An entry expires after 6 h, so a repository that shrank gets its producer
 * back without a restart.
 */
import { BoundedMap } from './bounded-map';

export type OverLimitProducer = 'config-archive' | 'project-snapshot' | 'fast-boot-bundle';

export const OVER_LIMIT_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_OVER_LIMIT_ENTRIES = 5_000;

interface OverLimit {
  at: number;
  /** The size the producer saw when it stopped. */
  bytes: number;
}

// replica-local: a cache of a fact each replica learns again with one capped
// download; a missing or stale entry only changes which fallback a box uses.
const overLimit = new BoundedMap<string, OverLimit>(MAX_OVER_LIMIT_ENTRIES);

const key = (projectId: string, producer: OverLimitProducer) => `${producer}\0${projectId}`;

/** The last over-limit result of `producer` for `projectId` in the last 6 h, else null. */
export function recentOverLimit(projectId: string, producer: OverLimitProducer, now = Date.now()): OverLimit | null {
  const entry = overLimit.get(key(projectId, producer));
  if (!entry) return null;
  if (now - entry.at >= OVER_LIMIT_MEMO_TTL_MS) {
    overLimit.delete(key(projectId, producer));
    return null;
  }
  return entry;
}

/** Remember that `producer` found `projectId` over its cap. */
export function noteOverLimit(projectId: string, producer: OverLimitProducer, bytes: number, now = Date.now()): void {
  overLimit.set(key(projectId, producer), { at: now, bytes });
}

export function __clearOverLimitMemoForTests(): void {
  overLimit.clear();
}

/**
 * Is `err` the object store's `ObjectFetchTooLargeError` (a capped download
 * that stopped; nothing it received is kept)? Matched by name: a module
 * outside `projects/` may not import the store module itself.
 */
export function isObjectFetchTooLarge(err: unknown): err is Error & { maxBytes: number; receivedBytes: number } {
  return err instanceof Error && err.name === 'ObjectFetchTooLargeError';
}
