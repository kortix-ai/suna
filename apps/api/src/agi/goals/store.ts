/**
 * Every read the AGI goal routes issue.
 *
 * Goals are not a table. They live in the project manifest and are re-read from
 * git on every request, which is what makes `kortix.yaml` the single source of
 * truth (R-6) — there is no cached projection to fall out of date. The only
 * database work here is the task rollup, which joins cloud-side `agi_tasks` rows
 * to a manifest-side goal by `goal_slug` (a plain text key, deliberately not a
 * foreign key: a goal can be renamed or deleted out from under its tasks and the
 * tasks must survive that).
 */
import { db } from '../../shared/db';
import { withProjectGitAuth } from '../../projects/lib/git';
import type { ProjectRow } from '../../projects/lib/serializers';
import { extractGoals, type GoalParseError, type GoalSpec } from '../../projects/lib/agi-goals';
import { getGitTriggerRuntime } from '../../projects/lib/triggers';
import {
  MANIFEST_FILENAME_YAML,
  extractTriggers,
  readManifest,
  type GitTriggerSpec,
  type ParsedManifest,
} from '../../projects/triggers';
import { emptyGoalTaskCounts, rawGoalEntries, type GoalTaskCounts } from './wire';
import { agiTasks } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

export interface LoadedProjectGoals {
  /** Kept so a caller can derive triggers from the SAME read — `readManifest`
   *  is a git round trip, and the push route needs both goals and triggers. */
  manifest: ParsedManifest | null;
  specs: GoalSpec[];
  errors: GoalParseError[];
  /** The `goals:` entries exactly as authored. Only used to recover the ordinal
   *  of a malformed entry, which {@link GoalParseError} does not carry. */
  rawEntries: unknown[];
}

/**
 * Read + parse the project's goals. Never throws: a manifest that fails to parse
 * comes back as one block-level error, the same contract `loadProjectTriggers`
 * offers, so a broken file degrades to a visible complaint rather than an empty
 * list that reads as "you have no goals".
 */
export async function loadProjectGoals(project: ProjectRow): Promise<LoadedProjectGoals> {
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(await withProjectGitAuth(project));
  } catch (err) {
    return {
      manifest: null,
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: project.manifestPath || MANIFEST_FILENAME_YAML,
          error: (err as Error).message || 'Failed to read manifest',
        },
      ],
      rawEntries: [],
    };
  }
  if (!manifest) return { manifest: null, specs: [], errors: [], rawEntries: [] };

  const { specs, errors } = extractGoals(manifest);
  return { manifest, specs, errors, rawEntries: rawGoalEntries(manifest.raw) };
}

/**
 * The trigger a goal's `push` fires, resolved through `extractTriggers` rather
 * than rebuilt from the goal.
 *
 * That indirection is the point: when an authored `triggers:` entry already
 * claims the derived slug, desugaring DROPS the goal's version and the
 * hand-written trigger wins. Firing the spec `extractTriggers` returns is
 * therefore the only way `goals push` fires the same thing the cron sweep and
 * `kortix triggers fire` would.
 */
export function goalDerivedTrigger(
  manifest: ParsedManifest,
  triggerSlug: string,
): GitTriggerSpec | null {
  const { specs } = extractTriggers(manifest, { goals: true });
  return specs.find((spec) => spec.slug === triggerSlug) ?? null;
}

/**
 * Per-status task tallies keyed by goal slug. One grouped query for the whole
 * list — a per-goal count would be N round trips for a list that renders in one
 * screen.
 */
export async function countTasksByGoal(
  workspaceId: string,
  slugs: readonly string[],
): Promise<Map<string, GoalTaskCounts>> {
  const counts = new Map<string, GoalTaskCounts>(
    slugs.map((slug) => [slug, emptyGoalTaskCounts()]),
  );
  if (slugs.length === 0) return counts;

  const rows = await db
    .select({
      goalSlug: agiTasks.goalSlug,
      status: agiTasks.status,
      // Cast in SQL: node-postgres hands back bigint counts as strings, and a
      // string would serialize into the response as `"3"`.
      total: sql<number>`count(*)::int`,
    })
    .from(agiTasks)
    .where(and(eq(agiTasks.workspaceId, workspaceId), inArray(agiTasks.goalSlug, [...slugs])))
    .groupBy(agiTasks.goalSlug, agiTasks.status);

  for (const row of rows) {
    if (!row.goalSlug) continue;
    const bucket = counts.get(row.goalSlug);
    // A status outside the known vocabulary can only come from a row written by
    // an older/newer deploy; count it under its own key rather than dropping it.
    if (bucket) bucket[row.status] = (bucket[row.status] ?? 0) + row.total;
  }
  return counts;
}

/** Runtime state of the goal's derived trigger — last fire, last error. Null
 *  until it has ever been attempted. */
export async function goalTriggerRuntime(projectId: string, triggerSlug: string) {
  return getGitTriggerRuntime(projectId, triggerSlug);
}
