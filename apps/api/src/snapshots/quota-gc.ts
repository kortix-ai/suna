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
 * Never acts on a partial view: if any provider, reference, or pin read fails,
 * the pass does nothing.
 */

import { sandboxTemplates } from '@kortix/db';
import { isNotNull, sql } from 'drizzle-orm';
import {
  deleteDaytonaSnapshotById,
  isDaytonaConfigured,
  listDaytonaSnapshots,
} from '../shared/daytona';
import { db } from '../shared/db';
import { collectPinnedImageRefs } from './pinned-images';
import { currentProjectImageDataPlaneScope } from './project-image-scope';
import {
  DAYTONA_ORG_SNAPSHOT_LIMIT,
  QUOTA_GC_MAX_PER_PASS,
  QUOTA_GC_ORG_TARGET,
  isManaged,
  type SnapshotLike,
  selectSnapshotsToReap,
} from './quota-gc-select';

/** A project counts as ACTIVE (its legacy warm pointer is protected) when it has a
 * session within this window. */
const QUOTA_GC_PROJECT_ACTIVE_MS = 14 * 24 * 60 * 60 * 1000;

export type QuotaGcObservationStatus =
  | 'provider_not_configured'
  | 'complete'
  | 'org_list_failed'
  | 'referenced_names_failed'
  | 'pin_lookup_failed';

export interface QuotaGcResult {
  /** Whether every observation needed for safe deletion and admission succeeded. */
  observationStatus: QuotaGcObservationStatus;
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

export type DaytonaProjectImageAdmissionReason =
  | 'allowed'
  | 'provider_not_configured'
  | 'org_list_failed'
  | 'referenced_names_failed'
  | 'pin_lookup_failed'
  | 'budget_unresolved'
  | 'deferred_candidates'
  | 'org_target_reached';

export interface DaytonaProjectImageAdmission {
  allowed: boolean;
  reason: DaytonaProjectImageAdmissionReason;
  quota: QuotaGcResult;
}

export interface SnapshotQuotaIo {
  isConfigured(): boolean;
  listSnapshots(): Promise<SnapshotLike[]>;
  loadReferencedSnapshotNames(now: number): Promise<Set<string>>;
  loadPinnedImageRefs(): Promise<Set<string>>;
  deleteSnapshotById(snapshotId: string): Promise<boolean>;
}

async function loadReferencedSnapshotNames(now: number): Promise<Set<string>> {
  const referenced = new Set(
    (
      await db
        .select({ name: sandboxTemplates.providerSnapshotName })
        .from(sandboxTemplates)
        .where(isNotNull(sandboxTemplates.providerSnapshotName))
    ).map((r) => r.name as string),
  );
  // Legacy per-project warm-snapshot pointers (kortix-wproj-*) may still live in
  // projects.metadata. Protect each live, recently active pointer.
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
  for (const row of pointerList) {
    if (row.name && row.active) referenced.add(row.name);
  }
  return referenced;
}

const defaultSnapshotQuotaIo: SnapshotQuotaIo = {
  isConfigured: isDaytonaConfigured,
  listSnapshots: listDaytonaSnapshots,
  loadReferencedSnapshotNames,
  loadPinnedImageRefs: collectPinnedImageRefs,
  deleteSnapshotById: deleteDaytonaSnapshotById,
};

/**
 * One GC pass. Safe to call from the periodic maintenance sweep; all failure
 * modes degrade to "did nothing". Pass `dryRun` to classify without deleting.
 */
export async function reconcileSnapshotQuota(
  opts: { dryRun?: boolean; now?: number } = {},
  io: SnapshotQuotaIo = defaultSnapshotQuotaIo,
): Promise<QuotaGcResult> {
  const dryRun = opts.dryRun ?? false;
  const result: QuotaGcResult = {
    observationStatus: 'provider_not_configured',
    orgTotal: 0,
    managedCount: 0,
    eligible: 0,
    deleted: 0,
    deferred: 0,
    budgetUnresolved: false,
    dryRun,
  };
  if (!io.isConfigured()) return result;

  result.observationStatus = 'org_list_failed';
  let all: SnapshotLike[];
  try {
    all = await io.listSnapshots();
  } catch (err) {
    console.warn(
      '[snapshot-gc] org listing failed — pass skipped:',
      err instanceof Error ? err.message : err,
    );
    return result;
  }
  result.orgTotal = all.length;
  result.managedCount = all.filter((snapshot) => isManaged(snapshot.name)).length;

  const now = opts.now ?? Date.now();

  // Names any local template row would boot from (trust-the-row / graceful
  // last-known-good path). Never delete these.
  result.observationStatus = 'referenced_names_failed';
  let referenced: Set<string>;
  try {
    referenced = await io.loadReferencedSnapshotNames(now);
  } catch (err) {
    console.warn(
      '[snapshot-gc] referenced-name lookup failed — pass skipped:',
      err instanceof Error ? err.message : err,
    );
    return result;
  }

  // FIX-K-lite: never reap an image that is the ACTIVE routing pin of ANY project.
  // proj8 (8 hex) scoping over the org-wide list could otherwise let one project's
  // superseded-tip selection delete another project's LIVE pinned cache on a
  // collision. A lookup failure disables every deletion for this pass because
  // project-image admission and periodic GC share the same complete-view boundary.
  result.observationStatus = 'pin_lookup_failed';
  let pinnedImages: Set<string>;
  try {
    pinnedImages = await io.loadPinnedImageRefs();
  } catch (err) {
    console.warn(
      '[snapshot-gc] pinned-image lookup failed — pass skipped:',
      err instanceof Error ? err.message : err,
    );
    return result;
  }
  result.observationStatus = 'complete';

  const plan = selectSnapshotsToReap({
    all,
    referenced,
    pinnedImages,
    ownedPpwarmDataPlaneScope: currentProjectImageDataPlaneScope(),
    now,
  });
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
    const ok = await io.deleteSnapshotById(snapshot.id);
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

/**
 * Observe Daytona capacity without deleting snapshots. Project-image admission
 * fails closed unless the provider and every safety read produced a complete,
 * immediately actionable view below the post-GC target.
 */
export async function assessDaytonaProjectImageAdmission(
  opts: { now?: number } = {},
  io: SnapshotQuotaIo = defaultSnapshotQuotaIo,
): Promise<DaytonaProjectImageAdmission> {
  const quota = await reconcileSnapshotQuota({ dryRun: true, now: opts.now }, io);
  if (quota.observationStatus !== 'complete') {
    return { allowed: false, reason: quota.observationStatus, quota };
  }
  if (quota.budgetUnresolved) {
    return { allowed: false, reason: 'budget_unresolved', quota };
  }
  if (quota.deferred > 0) {
    return { allowed: false, reason: 'deferred_candidates', quota };
  }
  if (quota.orgTotal >= QUOTA_GC_ORG_TARGET) {
    return { allowed: false, reason: 'org_target_reached', quota };
  }
  return { allowed: true, reason: 'allowed', quota };
}
