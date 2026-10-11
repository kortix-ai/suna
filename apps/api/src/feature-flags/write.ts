/**
 * The one write path for a project's feature-flag override. Two routes call
 * it: `PATCH /v1/projects/:id/features` (project members) and
 * `PUT /v1/admin/api/projects/:id/features` (platform operators).
 */
import type { FeatureFlagKey } from '@kortix/api-contract';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
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
  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row) return null;
  // Convergence work (connector materialization, sandbox env fan-out) runs
  // behind the response; runFeatureFlagToggleEffects retries once and logs
  // failures at error level. See ./toggle-effects.ts.
  void runFeatureFlagToggleEffects({
    key: feature,
    projectId,
    accountId: row.accountId,
    metadata: row.metadata,
  });
  return row;
}
