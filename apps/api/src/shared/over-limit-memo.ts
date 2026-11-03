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
 *
 * An entry may carry a witness: the blob ids of the tree that was over the
 * cap. A later tree that holds every one of them is at least as large, so it
 * is over the cap too. A tree that dropped any of them is measured again at
 * once (2026-11-03: a commit that removed the large data still got no config
 * archive for 6 h, CFG-14).
 */
import { BoundedMap } from './bounded-map';

export type OverLimitProducer = 'config-archive' | 'project-snapshot' | 'fast-boot-bundle';

export const OVER_LIMIT_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_OVER_LIMIT_ENTRIES = 5_000;

interface OverLimit {
  at: number;
  /** The size the producer saw when it stopped. */
  bytes: number;
  /** The blob ids of the tree that was over the cap, when the producer knows them. */
  witness?: ReadonlySet<string>;
}

/** A witness larger than this is not kept: the entry falls back to the 6 h rule. */
const MAX_WITNESS_BLOBS = 50_000;

// replica-local: a cache of a fact each replica learns again with one capped
// download; a missing or stale entry only changes which fallback a box uses.
const overLimit = new BoundedMap<string, OverLimit>(MAX_OVER_LIMIT_ENTRIES);

const key = (projectId: string, producer: OverLimitProducer) => `${producer}\0${projectId}`;

/**
 * The last over-limit result of `producer` for `projectId` in the last 6 h,
 * else null. With `blobIds` (the tree about to be built), an entry that
 * carries a witness counts only when the tree still holds every witness blob.
 */
export function recentOverLimit(
  projectId: string,
  producer: OverLimitProducer,
  opts: { now?: number; blobIds?: Iterable<string> } = {},
): OverLimit | null {
  const entry = overLimit.get(key(projectId, producer));
  if (!entry) return null;
  if ((opts.now ?? Date.now()) - entry.at >= OVER_LIMIT_MEMO_TTL_MS) {
    overLimit.delete(key(projectId, producer));
    return null;
  }
  if (entry.witness && opts.blobIds) {
    const current = new Set(opts.blobIds);
    for (const blob of entry.witness) if (!current.has(blob)) return null;
  }
  return entry;
}

/** Remember that `producer` found `projectId` over its cap, with the over tree's blob ids when known. */
export function noteOverLimit(
  projectId: string,
  producer: OverLimitProducer,
  bytes: number,
  opts: { now?: number; blobIds?: Iterable<string> } = {},
): void {
  const witness = opts.blobIds ? new Set(opts.blobIds) : undefined;
  overLimit.set(key(projectId, producer), {
    at: opts.now ?? Date.now(),
    bytes,
    ...(witness && witness.size <= MAX_WITNESS_BLOBS ? { witness } : {}),
  });
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
