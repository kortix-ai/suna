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
  // Per-project warm snapshots are referenced via projects.metadata, not the
  // templates table — protect the current pointer of every project.
  for (const r of await db
    .select({ name: sql<string>`${projects.metadata} -> 'warm_snapshot' ->> 'name'` })
    .from(projects)
    .where(sql`${projects.metadata} -> 'warm_snapshot' ->> 'name' IS NOT NULL`)) {
    if (r.name) referenced.add(r.name);
  }

  const now = opts.now ?? Date.now();
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
    if (ok) result.deleted++;
  }
  if (result.namespaceCount >= QUOTA_GC_PRESSURE_THRESHOLD) {
    console.log(
      `[snapshot-gc] namespace=${result.namespaceCount} eligible=${result.eligible} ${dryRun ? 'would-delete' : 'deleted'}=${result.deleted}`,
    );
  }
  return result;
}
