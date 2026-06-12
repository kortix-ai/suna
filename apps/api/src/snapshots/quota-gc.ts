/**
 * Snapshot quota GC — reclaim superseded template snapshots.
 *
 * Template snapshots are content-addressed (`kortix-default-<hash>` /
 * `kortix-tpl-<hash>`), so every identity drift (each release bumps the runtime
 * fingerprint; every Dockerfile/spec edit) mints a NEW name and silently
 * orphans the old one. Nothing else deletes them: the only same-name deletes
 * run while that exact identity is being rebuilt. Measured live (2026-06-12):
 * ~4.5 new snapshots/day against the 100/org Daytona quota — exhaustion in
 * days, at which point every build org-wide starts failing.
 *
 * Deletion criteria (ALL must hold):
 *   1. Name is in our managed namespaces (`kortix-default-` / `kortix-tpl-` / `kortix-wproj-`).
 *      Warm bases have their own age-gated reaper; stock images are untouched.
 *   2. Not referenced by any local `sandbox_templates.provider_snapshot_name`
 *      (the row a session would boot from on the trust-the-row / graceful
 *      path — covers the platform default too, it has a shared row).
 *   3. Not USED for `QUOTA_GC_MIN_IDLE_MS` (lastUsedAt, falling back to
 *      createdAt). Several environments (laptops/dev/prod) share the org but
 *      have separate DBs — `lastUsedAt` is the cross-environment guard: any
 *      env still booting from a snapshot keeps it fresh. A cold-but-needed
 *      snapshot that does get deleted is self-healing: the next session hits
 *      the snapshot-missing auto-heal and rebuilds (one slow boot, no loss).
 *
 * Pressure-gated: nothing is deleted while the org namespace is comfortably
 * under quota, so quiet orgs never see churn. Bounded per pass, oldest-first,
 * and skipped entirely when the org listing fails (never act on a partial
 * view).
 */

import { isNotNull, sql } from 'drizzle-orm';
import { projects, sandboxTemplates } from '@kortix/db';
import { db } from '../shared/db';
import {
  deleteDaytonaSnapshotById,
  isDaytonaConfigured,
  listDaytonaSnapshots,
} from '../shared/daytona';

const TEMPLATE_PREFIXES = ['kortix-default-', 'kortix-tpl-', 'kortix-wproj-'] as const;
/** Start deleting only when our namespace holds this many snapshots. */
const QUOTA_GC_PRESSURE_THRESHOLD = 60;
/** A snapshot must be unused this long before it is eligible. */
const QUOTA_GC_MIN_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Max deletions per sweep pass — keeps each pass cheap and observable. */
const QUOTA_GC_MAX_PER_PASS = 15;
/** A project counts as ACTIVE (its warm snapshot is protected) when it has a
 * session or portal presence within this window. */
const QUOTA_GC_PROJECT_ACTIVE_MS = 14 * 24 * 60 * 60 * 1000;

export interface QuotaGcResult {
  /** Snapshots in our template namespaces (the pressure number). */
  namespaceCount: number;
  eligible: number;
  deleted: number;
  dryRun: boolean;
}

function isTemplateSnapshot(name: string): boolean {
  return TEMPLATE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * One GC pass. Safe to call from the periodic maintenance sweep; all failure
 * modes degrade to "did nothing". Pass `dryRun` to classify without deleting.
 */
export async function reconcileSnapshotQuota(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<QuotaGcResult> {
  const dryRun = opts.dryRun ?? false;
  const result: QuotaGcResult = { namespaceCount: 0, eligible: 0, deleted: 0, dryRun };
  if (!isDaytonaConfigured()) return result;

  let all;
  try {
    all = await listDaytonaSnapshots();
  } catch (err) {
    console.warn('[snapshot-gc] org listing failed — pass skipped:', err instanceof Error ? err.message : err);
    return result;
  }

  const namespace = all.filter((s) => isTemplateSnapshot(s.name));
  result.namespaceCount = namespace.length;
  if (namespace.length < QUOTA_GC_PRESSURE_THRESHOLD) return result;

  const now = opts.now ?? Date.now();

  // Names any local template row would boot from (trust-the-row / graceful
  // last-known-good path). Never delete these.
  const referenced = new Set(
    (
      await db
        .select({ name: sandboxTemplates.providerSnapshotName })
        .from(sandboxTemplates)
        .where(isNotNull(sandboxTemplates.providerSnapshotName))
    ).map((r) => r.name as string),
  );
  // Per-project warm snapshots (kortix-wproj-*) are referenced via
  // projects.metadata. Protect a pointer ONLY while its project is alive and
  // recently ACTIVE (a session in the activity window, or portal presence) —
  // archived/dormant projects' snapshots are reclaimable: their sessions fall
  // back to the generic warm base, and the pool-presence hook re-bakes the
  // snapshot the moment someone returns. Pointers of reclaimed snapshots are
  // cleared below so session boot never chases a deleted name.
  const activityCutoff = new Date(now - QUOTA_GC_PROJECT_ACTIVE_MS).toISOString();
  const pointerRows = await db.execute(sql`
    SELECT p.project_id AS project_id,
           p.metadata -> 'warm_snapshot' ->> 'name' AS name,
           (
             p.status <> 'archived' AND (
               coalesce((p.metadata ->> 'warm_pool_seen_at')::timestamptz, 'epoch'::timestamptz) > ${activityCutoff}::timestamptz
               OR EXISTS (
                 SELECT 1 FROM kortix.project_sessions ps
                 WHERE ps.project_id = p.project_id AND ps.created_at > ${activityCutoff}::timestamptz
               )
             )
           ) AS active
    FROM kortix.projects p
    WHERE p.metadata -> 'warm_snapshot' ->> 'name' IS NOT NULL
  `);
  const pointerList = ((pointerRows as unknown as { rows?: any[] }).rows ?? (pointerRows as unknown as any[])) as Array<{
    project_id: string; name: string; active: boolean;
  }>;
  const pointerProject = new Map<string, string>();
  for (const r of pointerList) {
    if (!r.name) continue;
    pointerProject.set(r.name, r.project_id);
    if (r.active) referenced.add(r.name);
  }

  const lastTouch = (s: { lastUsedAt?: string | null; createdAt: string | null }) => {
    const t = s.lastUsedAt || s.createdAt;
    return t ? new Date(t).getTime() : Number.NaN;
  };
  const eligible = namespace
    .filter((s) => !referenced.has(s.name))
    // No usable timestamp → can't prove it's idle → keep.
    .filter((s) => Number.isFinite(lastTouch(s)) && now - lastTouch(s) > QUOTA_GC_MIN_IDLE_MS)
    .sort((a, b) => lastTouch(a) - lastTouch(b));
  result.eligible = eligible.length;

  for (const snap of eligible.slice(0, QUOTA_GC_MAX_PER_PASS)) {
    if (dryRun) {
      console.log(`[snapshot-gc] DRY RUN would delete ${snap.name} (last used ${snap.lastUsedAt ?? snap.createdAt})`);
      result.deleted++;
      continue;
    }
    const ok = await deleteDaytonaSnapshotById(snap.id);
    console.log(`[snapshot-gc] delete ${snap.name} (last used ${snap.lastUsedAt ?? snap.createdAt}): ${ok ? 'ok' : 'failed'}`);
    if (ok) {
      result.deleted++;
      // Reclaimed an inactive project's warm snapshot — clear its pointer so
      // session boot doesn't chase the deleted name (it would just fall back,
      // but a clean pointer lets the presence hook re-bake without a miss).
      const projectId = pointerProject.get(snap.name);
      if (projectId) {
        const { writeProjectWarmPointer } = await import('./warm-project');
        await writeProjectWarmPointer(projectId, null).catch(() => {});
      }
    }
  }
  if (result.namespaceCount >= QUOTA_GC_PRESSURE_THRESHOLD) {
    console.log(
      `[snapshot-gc] namespace=${result.namespaceCount} eligible=${result.eligible} ${dryRun ? 'would-delete' : 'deleted'}=${result.deleted}`,
    );
  }
  return result;
}
