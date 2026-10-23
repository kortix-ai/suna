/**
 * Memory upkeep (the `memory-maintenance` worker, hourly): pages in the trash
 * for 30 days are deleted for good, and each page keeps its first version (it
 * names the page's creator, who may delete it) and its newest 100. A version
 * row of a change that also wrote another page is kept, so a change is never
 * split (its Undo stays whole); Undo refuses a change older than the trash
 * (`versions.ts`), since a purged page takes its rows of the change with it. Each pass deletes at most 500 rows of each kind; a full batch
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

/** A version is pruned when it is neither the first nor among its page's newest 100 (version numbers run 1..version_no). */
export const versionPruned = (versionNo: number, pageVersionNo: number) => versionNo > 1 && versionNo <= pageVersionNo - VERSIONS_KEPT;

export async function runMemoryMaintenance(now = new Date()): Promise<{ pages: number; versions: number }> {
  const pages = (await db.execute(sql`
    DELETE FROM kortix.memory_pages WHERE page_id IN (
      SELECT page_id FROM kortix.memory_pages
       WHERE deleted_at IS NOT NULL AND deleted_at < ${trashCutoff(now).toISOString()}::timestamptz
       LIMIT ${MEMORY_MAINTENANCE_BATCH})
    RETURNING page_id`)) as unknown as unknown[];
  // Same rule as `versionPruned`, minus rows of a change that wrote another page; the (page_id, version_no) and change_id indexes serve it.
  const versions = (await db.execute(sql`
    DELETE FROM kortix.memory_page_versions WHERE version_id IN (
      SELECT v.version_id FROM kortix.memory_pages p
        JOIN kortix.memory_page_versions v
          ON v.page_id = p.page_id AND v.version_no > 1 AND v.version_no <= p.version_no - ${VERSIONS_KEPT}
       WHERE p.version_no > ${VERSIONS_KEPT} + 1
         AND NOT EXISTS (
           SELECT 1 FROM kortix.memory_page_versions o WHERE o.change_id = v.change_id AND o.page_id <> v.page_id)
       LIMIT ${MEMORY_MAINTENANCE_BATCH})
    RETURNING version_id`)) as unknown as unknown[];
  return { pages: pages.length, versions: versions.length };
}
