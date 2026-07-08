/**
 * Snapshot quota GC — reclaim superseded snapshots before the org-wide cap bites.
 *
 * Template snapshots are content-addressed (`kortix-default-<hash>` /
 * `kortix-tpl-<hash>`), so every identity drift (each release bumps the runtime
 * fingerprint; every Dockerfile/spec edit) mints a NEW name and silently
 * orphans the old one. Nothing else deletes them: the only same-name deletes
 * run while that exact identity is being rebuilt. Measured live (2026-06-12):
 * ~4.5 new snapshots/day against the 100/org Daytona quota — exhaustion in days,
 * at which point every build org-wide starts failing.
 *
 * This file owns the IO (DB reads, provider deletes). The RULES live in
 * quota-gc-select.ts as a pure function — including the two hard-won invariants:
 * the pressure gate must measure the ORG TOTAL (not just our namespace), and
 * platform defaults must be ranked by freshness (not idle time). See that file's
 * header for why each of those was wrong before, and for the cross-environment
 * safety argument (one Daytona org, many databases).
 *
 * Never acts on a partial view: if the org listing fails, the pass does nothing.
 */

import { sandboxTemplates } from '@kortix/db';
import { isNotNull, sql } from 'drizzle-orm';
import {
  deleteDaytonaSnapshotById,
  isDaytonaConfigured,
  listDaytonaSnapshots,
} from '../shared/daytona';
import { db } from '../shared/db';
import {
  DAYTONA_ORG_SNAPSHOT_LIMIT,
  QUOTA_GC_MAX_PER_PASS,
  QUOTA_GC_ORG_TARGET,
  type SnapshotLike,
  selectSnapshotsToReap,
} from './quota-gc-select';

/** A project counts as ACTIVE (its legacy warm pointer is protected) when it has a
 * session within this window. */
const QUOTA_GC_PROJECT_ACTIVE_MS = 14 * 24 * 60 * 60 * 1000;

export interface QuotaGcResult {
  /** Org-wide snapshot count — the number the Daytona quota actually meters. */
  orgTotal: number;
  /** Snapshots in namespaces we own. */
  managedCount: number;
  eligible: number;
  deleted: number;
  /** Reapable but dropped by the per-pass cap. Never silently truncate. */
  deferred: number;
  /** GC cannot get the org back to target — capacity problem, needs a human. */
  budgetUnresolved: boolean;
  dryRun: boolean;
}

/**
 * One GC pass. Safe to call from the periodic maintenance sweep; all failure
 * modes degrade to "did nothing". Pass `dryRun` to classify without deleting.
 */
export async function reconcileSnapshotQuota(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<QuotaGcResult> {
  const dryRun = opts.dryRun ?? false;
  const result: QuotaGcResult = {
    orgTotal: 0,
    managedCount: 0,
    eligible: 0,
    deleted: 0,
    deferred: 0,
    budgetUnresolved: false,
    dryRun,
  };
  if (!isDaytonaConfigured()) return result;

  let all: SnapshotLike[];
  try {
    all = await listDaytonaSnapshots();
  } catch (err) {
    console.warn(
      '[snapshot-gc] org listing failed — pass skipped:',
      err instanceof Error ? err.message : err,
    );
    return result;
  }

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
  // Legacy per-project warm-snapshot pointers (kortix-wproj-*) may still live in
  // projects.metadata from before the cold-only unification. Warm baking is gone,
  // but protect any lingering pointer while its project is alive and recently
  // ACTIVE so GC never reclaims a name a stale pointer still references.
  const activityCutoff = new Date(now - QUOTA_GC_PROJECT_ACTIVE_MS).toISOString();
  const pointerRows = await db.execute(sql`
    SELECT p.metadata -> 'warm_snapshot' ->> 'name' AS name,
           (
             p.status <> 'archived' AND (
               EXISTS (
                 SELECT 1 FROM kortix.project_sessions ps
                 WHERE ps.project_id = p.project_id AND ps.created_at > ${activityCutoff}::timestamptz
               )
             )
           ) AS active
    FROM kortix.projects p
    WHERE p.metadata -> 'warm_snapshot' ->> 'name' IS NOT NULL
  `);
  const pointerList = ((pointerRows as unknown as { rows?: any[] }).rows ??
    (pointerRows as unknown as any[])) as Array<{
    name: string;
    active: boolean;
  }>;
  for (const r of pointerList) {
    if (r.name && r.active) referenced.add(r.name);
  }

  const plan = selectSnapshotsToReap({ all, referenced, now });
  result.orgTotal = plan.orgTotal;
  result.managedCount = plan.managedCount;
  result.eligible = plan.doomed.length + plan.deferred;
  result.deferred = plan.deferred;
  result.budgetUnresolved = plan.budgetUnresolved;

  if (!plan.underPressure) return result;

  // GC has run out of road: one warm tip per active project already exceeds the
  // budget, so no amount of sweeping will keep builds from failing. Only capacity
  // (a bigger org snapshot quota) or gating the warm bake fixes this. Say so —
  // the first outage happened because a GC that couldn't cope logged nothing.
  if (plan.budgetUnresolved) {
    console.error(
      `[snapshot-gc] BUDGET UNRESOLVED: org=${plan.orgTotal} target=${QUOTA_GC_ORG_TARGET} ` +
        `limit=${DAYTONA_ORG_SNAPSHOT_LIMIT} — evicted everything eligible and still over. ` +
        `The per-project warm cache floor exceeds the org snapshot quota; raise the quota ` +
        `or gate the warm bake. Builds will start failing with 'Snapshot quota exceeded'.`,
    );
  }

  for (const { snapshot, reason } of plan.doomed) {
    if (dryRun) {
      console.log(`[snapshot-gc] DRY RUN would delete ${snapshot.name} (${reason})`);
      result.deleted++;
      continue;
    }
    const ok = await deleteDaytonaSnapshotById(snapshot.id);
    console.log(`[snapshot-gc] delete ${snapshot.name} (${reason}): ${ok ? 'ok' : 'failed'}`);
    if (ok) result.deleted++;
  }

  console.log(
    `[snapshot-gc] org=${result.orgTotal} managed=${result.managedCount} ` +
      `eligible=${result.eligible} ${dryRun ? 'would-delete' : 'deleted'}=${result.deleted}` +
      (result.deferred > 0
        ? ` deferred=${result.deferred} (cap ${QUOTA_GC_MAX_PER_PASS}/pass)`
        : ''),
  );
  return result;
}
