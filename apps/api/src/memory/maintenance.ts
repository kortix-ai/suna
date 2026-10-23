/**
 * Memory upkeep (the `memory-maintenance` worker, hourly): pages in the trash
 * for 30 days are deleted for good, and each page keeps only its newest 100
 * versions. Each pass deletes at most 500 rows of each kind; a full batch
 * means a backlog, so the worker runs again in seconds.
 *
 * No layer version bump: neither the trash nor old versions are in the
 * read-only copy or the page list.
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

export const MEMORY_MAINTENANCE_BATCH = 500;
export const TRASH_DAYS = 30;
export const VERSIONS_KEPT = 100;

/** Pages deleted before this moment leave the trash for good. */
export const trashCutoff = (now: Date) => new Date(now.getTime() - TRASH_DAYS * 24 * 60 * 60_000);

/** A version is pruned when it is not among its page's newest 100 (version numbers run 1..version_no). */
export const versionPruned = (versionNo: number, pageVersionNo: number) => versionNo <= pageVersionNo - VERSIONS_KEPT;

export async function runMemoryMaintenance(now = new Date()): Promise<{ pages: number; versions: number }> {
  const pages = (await db.execute(sql`
    DELETE FROM kortix.memory_pages WHERE page_id IN (
      SELECT page_id FROM kortix.memory_pages
       WHERE deleted_at IS NOT NULL AND deleted_at < ${trashCutoff(now).toISOString()}::timestamptz
       LIMIT ${MEMORY_MAINTENANCE_BATCH})
    RETURNING page_id`)) as unknown as unknown[];
  // Same rule as `versionPruned`; the (page_id, version_no) unique index serves the range per page.
  const versions = (await db.execute(sql`
    DELETE FROM kortix.memory_page_versions WHERE version_id IN (
      SELECT v.version_id FROM kortix.memory_pages p
        JOIN kortix.memory_page_versions v ON v.page_id = p.page_id AND v.version_no <= p.version_no - ${VERSIONS_KEPT}
       WHERE p.version_no > ${VERSIONS_KEPT}
       LIMIT ${MEMORY_MAINTENANCE_BATCH})
    RETURNING version_id`)) as unknown as unknown[];
  return { pages: pages.length, versions: versions.length };
}
