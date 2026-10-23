/**
 * The one write path for a project's feature-flag override. Two routes call
 * it: `PATCH /v1/projects/:id/features` (holders of `project.settings.write`:
 * project admins, D7) and
 * `PUT /v1/admin/api/projects/:id/features` (platform operators).
 */
import type { FeatureFlagKey } from '@kortix/api-contract';
import { projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { metadataClearSubtreeKey, metadataMergeSubtree } from '../projects/surface';
import { runFeatureFlagToggleEffects } from './toggle-effects';

/**
 * Sets (`true`/`false`) or clears (`null`) one override. Returns the updated
 * project row, or null when the project does not exist.
 *
 * `experimental` is a NESTED object, so the merge runs in SQL on the CURRENT
 * sub-object: two flags toggled concurrently both land. Clearing the last
 * override drops the `experimental` key. The key name `experimental` is a
 * stable storage detail. Every write preserves the routing pin.
 */
export async function writeProjectFeatureFlag(
  projectId: string,
  feature: FeatureFlagKey,
  enabled: boolean | null,
) {
  const metadataExpr =
    enabled === null
      ? metadataClearSubtreeKey('experimental', feature)
      : metadataMergeSubtree('experimental', { [feature]: enabled });
  // The value before the write and the write itself in one transaction (row lock), so a
  // toggle effect tells "turned on again" from a repeated "on" even under concurrent PATCHes.
  // `updated_at` is the DB clock truncated to ms: the effect compares `#general`'s
  // `created_at` with it, so both sides use one clock.
  const written = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .for('update');
    if (!before) return null;
    const [updated] = await tx
      .update(projects)
      .set({ metadata: metadataExpr, updatedAt: sql`date_trunc('milliseconds', now())` })
      .where(eq(projects.projectId, projectId))
      .returning();
    return updated ? { row: updated, previousMetadata: before.metadata } : null;
  });
  if (!written) return null;
  const { row, previousMetadata } = written;
  // Convergence work (connector materialization, sandbox env fan-out) runs
  // behind the response; runFeatureFlagToggleEffects retries once and logs
  // failures at error level. See ./toggle-effects.ts.
  void runFeatureFlagToggleEffects({
    key: feature,
    projectId,
    accountId: row.accountId,
    metadata: row.metadata,
    previousMetadata,
    writtenAt: row.updatedAt,
  });
  return row;
}

