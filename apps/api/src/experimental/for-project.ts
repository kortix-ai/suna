/**
 * Resolve an experimental feature when the caller holds a project id but not
 * the project row. Kept out of ./features so that registry stays pure (config
 * only, no database) and remains importable from unit tests without a DB.
 *
 * Prefer {@link resolveExperimentalFeature} directly whenever the project row
 * is already loaded — this helper costs one extra query.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { resolveExperimentalFeature, type ExperimentalFeatureKey } from './features';

/** Effective per-project state for one feature. Unknown project ⇒ false. */
export async function projectFeatureEnabled(
  projectId: string,
  key: ExperimentalFeatureKey,
): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row) return false;
  return resolveExperimentalFeature(row.metadata, key);
}
