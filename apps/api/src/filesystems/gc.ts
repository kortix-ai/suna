/**
 * Reclaiming blobs no path references any more.
 *
 * Deleting a file is metadata-only by design: blobs are content-addressed, so
 * one blob can back many paths across many filesystems, and removing the bytes
 * when a single path goes away would corrupt every other path holding the same
 * content. "Is anyone still using this?" is a question only a scan can answer,
 * which is why it lives here and not in `deleteFile`.
 *
 * THE SAFETY RULE is the grace period, not the reference check. `putFile`
 * stores the bytes and THEN inserts the metadata row — deliberately, so a
 * failure leaves an invisible orphan rather than a row pointing at bytes that
 * were never stored. That ordering means a blob is legitimately unreferenced
 * between those two statements, so collecting on "unreferenced" alone would
 * delete the content of a file that is mid-write while the write reports
 * success. Only blobs older than the grace period are eligible.
 */
import { inArray, lt, sql } from 'drizzle-orm';
import { filesystemBlobs, filesystemFiles } from '@kortix/db';
import { db } from '../shared/db';
import { blobStore } from './service';

/**
 * An hour. Long enough that no single write is still in flight — the API's own
 * request deadline is far below it — and short enough that a deleted file's
 * bytes do not linger for a day.
 */
export const DEFAULT_BLOB_GRACE_MS = 60 * 60 * 1000;

export interface BlobAge {
  sha256: string;
  createdAt: Date;
}

/**
 * The rule, as a pure function: unreferenced AND older than the grace period.
 *
 * Kept separate from the queries so the decision can be tested without a
 * database — this is the part that, wrong, destroys data.
 */
export function selectCollectableBlobs(input: {
  blobs: BlobAge[];
  referenced: Set<string>;
  now: Date;
  graceMs?: number;
}): string[] {
  const grace = input.graceMs ?? DEFAULT_BLOB_GRACE_MS;
  const cutoff = input.now.getTime() - grace;
  return input.blobs
    .filter((b) => !input.referenced.has(b.sha256))
    .filter((b) => b.createdAt.getTime() < cutoff)
    .map((b) => b.sha256);
}

export interface BlobSweepResult {
  scanned: number;
  collected: number;
  /** Blobs whose object-store delete failed; the row is kept for a later pass. */
  failed: number;
}

/**
 * One sweep. Bounded by `limit` so a large backlog is drained across runs
 * rather than in one statement that holds locks for minutes.
 */
export async function sweepUnreferencedBlobs(options?: {
  graceMs?: number;
  limit?: number;
  now?: Date;
}): Promise<BlobSweepResult> {
  const graceMs = options?.graceMs ?? DEFAULT_BLOB_GRACE_MS;
  const limit = Math.min(Math.max(options?.limit ?? 500, 1), 5000);
  const now = options?.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceMs);

  // Only candidates the grace period already clears — the cheapest way to keep
  // an in-flight write out of the candidate set entirely.
  const candidates = await db
    .select({ sha256: filesystemBlobs.sha256, createdAt: filesystemBlobs.createdAt })
    .from(filesystemBlobs)
    .where(lt(filesystemBlobs.createdAt, cutoff))
    .limit(limit);

  if (candidates.length === 0) return { scanned: 0, collected: 0, failed: 0 };

  const keys = candidates.map((c) => c.sha256);
  const live = await db
    .selectDistinct({ sha256: filesystemFiles.sha256 })
    .from(filesystemFiles)
    .where(inArray(filesystemFiles.sha256, keys));

  const collectable = selectCollectableBlobs({
    blobs: candidates,
    referenced: new Set(live.map((r) => r.sha256)),
    now,
    graceMs,
  });
  if (collectable.length === 0) return { scanned: candidates.length, collected: 0, failed: 0 };

  // Bytes first, row second — the mirror of the write order. A failed object
  // delete leaves the row, so the next sweep retries; dropping the row first
  // would strand the object with nothing left to name it.
  const store = blobStore();
  const deleted: string[] = [];
  let failed = 0;
  for (const sha256 of collectable) {
    try {
      await store.delete(sha256);
      deleted.push(sha256);
    } catch {
      failed += 1;
    }
  }

  if (deleted.length > 0) {
    // Re-check the reference under the delete: a path written between the scan
    // and here would otherwise lose its bytes.
    await db.delete(filesystemBlobs).where(
      sql`${filesystemBlobs.sha256} in ${deleted} and not exists (
        select 1 from ${filesystemFiles} where ${filesystemFiles.sha256} = ${filesystemBlobs.sha256}
      )`,
    );
  }

  return { scanned: candidates.length, collected: deleted.length, failed };
}
