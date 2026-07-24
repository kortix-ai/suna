/**
 * SQL-side ATOMIC merge helpers for `projects.metadata` (FIX-J).
 *
 * The provider-routing pin lives in `projects.metadata` (`default_sandbox_provider`
 * + `active_sandbox_external_template_id`, see provider-transition-store.ts). The
 * pin's OWN writers are fenced (FOR UPDATE + generation/lease-epoch CAS), but
 * EVERY other `projects.metadata` writer used to read the whole jsonb object into
 * JS, mutate it, and `UPDATE ... SET metadata = <whole object>`. With no lock a
 * concurrent writer holding a STALE snapshot silently reverted the pin (a
 * classic read-modify-write lost update). These helpers move the mutation to the
 * SQL statement so the merge reads the CURRENT row value under the write's own
 * row lock — a concurrent pin write can no longer be clobbered.
 *
 * Every helper returns a Drizzle `SQL` fragment for the `metadata` COLUMN VALUE,
 * dropped straight into a writer's own `.set({ metadata: <expr>, … })` so each
 * call site keeps its control flow (`.returning()`, best-effort `.catch`, extra
 * column assignments like `sandboxProviderGeneration`).
 *
 * `||` is a SHALLOW top-level merge, so a writer that owns a NESTED object
 * (`experimental`, `meet`) must NOT patch it via a top-level `||` of the whole
 * sub-object — two concurrent writers into the same nested key would lose an
 * update one level down. {@link metadataMergeSubtree} / {@link metadataClearSubtreeKey}
 * re-read + merge the CURRENT nested value in-SQL so nested writes are atomic too.
 * The top-level namespaces of every writer are DISJOINT (audited: default_agent,
 * triggers_paused, onboarding_completed_at, experimental, meet, default_sandbox_slug
 * vs. the pin's default_sandbox_provider / active_sandbox_external_template_id /
 * active_sandbox_snapshot_name / sandbox_provider_transition), so a shallow merge
 * already protects the pin; the nested helpers protect each nested key against
 * self-concurrency.
 */
import { sql, type SQL } from 'drizzle-orm';
import { projects } from '@kortix/db';

/** `coalesce(metadata,'{}'::jsonb)` — a NULL metadata column merges as empty. */
function base(): SQL {
  return sql`coalesce(${projects.metadata}, '{}'::jsonb)`;
}

/**
 * Top-level atomic merge: `(metadata - k1 - k2 …) || patch`. `deleteKeys` removes
 * top-level keys (chained `-` so no array binding is needed); `patch` shallow-
 * merges the remaining keys. Both are optional; an empty patch (`|| '{}'`) and an
 * empty deleteKeys list are both no-ops, so a caller can pass just one.
 */
export function metadataMerge(patch: Record<string, unknown> = {}, deleteKeys: string[] = []): SQL {
  let expr = base();
  for (const key of deleteKeys) expr = sql`(${expr} - ${key})`;
  return sql`${expr} || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * Atomic NESTED merge into a single top-level object key (`experimental`, `meet`):
 * `metadata || jsonb_build_object(topKey, coalesce(metadata->topKey,'{}') || subPatch)`.
 * Re-reads the CURRENT sub-object in-SQL and merges `subPatch` into it, so two
 * concurrent writers into DIFFERENT sub-keys of the same top-level object don't
 * lose each other's update. Creates `topKey` when absent; preserves every sibling
 * top-level key (the pin included).
 */
export function metadataMergeSubtree(topKey: string, subPatch: Record<string, unknown>): SQL {
  return sql`${base()} || jsonb_build_object(${topKey}::text, coalesce(${projects.metadata} -> ${topKey}, '{}'::jsonb) || ${JSON.stringify(subPatch)}::jsonb)`;
}

/**
 * Atomic clear of ONE sub-key from a nested object, dropping the whole top-level
 * object when it becomes empty (mirrors the JS helpers' "remove `experimental`
 * when the last override is cleared" behavior). Re-reads the CURRENT sub-object
 * in-SQL, so it never reverts a concurrent write to a DIFFERENT sub-key.
 */
export function metadataClearSubtreeKey(topKey: string, subKey: string): SQL {
  const remaining = sql`(coalesce(${projects.metadata} -> ${topKey}, '{}'::jsonb) - ${subKey})`;
  return sql`CASE WHEN ${remaining} = '{}'::jsonb THEN ${base()} - ${topKey} ELSE ${base()} || jsonb_build_object(${topKey}::text, ${remaining}) END`;
}
