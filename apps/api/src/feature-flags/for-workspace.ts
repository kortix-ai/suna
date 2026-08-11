/**
 * Resolve a feature flag when the caller holds a workspace id but not the
 * workspace row. Keep this helper separate from the pure registry module.
 *
 * Prefer {@link resolveFeatureFlag} when the workspace row is already loaded.
 * This helper costs one database query.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { resolveFeatureFlag, type FeatureFlagKey } from './registry';

/** Effective per-workspace state for one flag. An unknown workspace returns false. */
export async function workspaceFeatureFlagEnabled(
  workspaceId: string,
  key: FeatureFlagKey,
): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .limit(1);
  if (!row) return false;
  return resolveFeatureFlag(row.metadata, key);
}
