/**
 * Resolve a feature flag when the caller holds a project id but not the
 * project row. Kept out of ./registry so that registry stays pure (config
 * only, no database) and remains importable from unit tests without a DB.
 *
 * Prefer {@link resolveFeatureFlag} directly whenever the project row is
 * already loaded — this helper costs one extra query.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { resolveFeatureFlag, type FeatureFlagKey } from './registry';

/** Effective per-project state for one flag. Unknown project ⇒ false. */
export async function projectFeatureFlagEnabled(
  projectId: string,
  key: FeatureFlagKey,
): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row) return false;
  return resolveFeatureFlag(row.metadata, key);
}
