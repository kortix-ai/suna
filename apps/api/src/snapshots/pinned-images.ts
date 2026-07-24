/**
 * FIX-K-lite: the set of image identifiers that are the ACTIVE routing pin of
 * SOME project, so neither the on-bake warm reaper nor the snapshot quota GC ever
 * deletes a LIVE pinned image.
 *
 * Both reapers group ppwarm images by the 8-hex `proj8` prefix over an ORG-WIDE
 * snapshot list, so a proj8 collision (two projects whose ids share the first 8
 * hex) could select another project's live cache as a "superseded" tip and delete
 * it. Rather than widen the prefix (a fleet-wide cold rebuild + orphaned images),
 * we cross-check every deletion target against the live pins here: a collision
 * then becomes harmless (worst case, a reap is skipped).
 *
 * A project's pin is written together at activation (see
 * provider-transition-store.ts): `active_sandbox_external_template_id` (the
 * provider's external template id) and `active_sandbox_snapshot_name` (the
 * `kortix-ppwarm-…` NAME the reaper deletes by). Both are collected so a target
 * matched by EITHER name or external id is protected.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@kortix/db';
import { db as appDb } from '../shared/db';

/**
 * Every active pinned image ref (ppwarm NAME + provider external template id)
 * across all projects in THIS environment's database. Best-effort: the callers
 * treat a throw as "no protection available" only where skipping the whole reap
 * is the safe default (the on-bake reaper). Cross-environment note: dev/staging/
 * prod share one provider org but separate DBs, so this only sees THIS env's pins
 * — the same single-DB visibility every other reap rule already operates under.
 */
export async function collectPinnedImageRefs(database: Database = appDb): Promise<Set<string>> {
  const result = await database.execute(sql`
    SELECT metadata ->> 'active_sandbox_snapshot_name' AS snapshot_name,
           metadata ->> 'active_sandbox_external_template_id' AS external_id
    FROM kortix.projects
    WHERE metadata ->> 'active_sandbox_snapshot_name' IS NOT NULL
       OR metadata ->> 'active_sandbox_external_template_id' IS NOT NULL
  `);
  const list = ((result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as Array<{
    snapshot_name: string | null;
    external_id: string | null;
  }>;
  const refs = new Set<string>();
  for (const row of list) {
    if (row.snapshot_name) refs.add(row.snapshot_name);
    if (row.external_id) refs.add(row.external_id);
  }
  return refs;
}
