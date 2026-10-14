/**
 * A base ref's tip, asked of the upstream at most once per mirror refresh
 * interval per `(project, ref)` across every API process.
 *
 * Every running box asks for its desired release every 60 s (the daemon's
 * runtime-truth tick), and each ask used to run its own `git fetch` of the
 * project mirror. Prod, 24 h to 2026-10-14 17:30 UTC: 119,253 asks over 158
 * projects and 10 API processes, p50 1.07 s, 3 projects 79 % of them. The
 * upstream answer is the same for every box of a project, so one ask per
 * interval serves them all.
 *
 * The claim is a row CAS in `kortix.base_tip_checks`: the request that moves
 * `checked_at` past the interval asks the upstream (one `ls-remote` of the
 * branch, and a fetch only when it moved) and stores the tip. Every other
 * request in the interval reads the stored tip; the builder and the manifest
 * read fetch that commit only on a process whose mirror lacks it.
 *
 * A move Kortix makes or proxies (`notifyBaseBranchMoved`) expires the
 * project's rows, so the next request asks again. A push made directly on the
 * upstream is seen within one interval.
 */

import { baseTipChecks } from '@kortix/db';
import { and, eq, lt } from 'drizzle-orm';
import { refreshIntervalMs, refreshMirror, resolveCommitShaAt, type GitBackedProject } from '../projects/surface';
import { db } from '../shared/db';

const EXPIRED = new Date(0);

/** Ask the upstream for `ref`'s tip now, and bring the mirror to it. */
async function askUpstream(project: GitBackedProject, ref: string): Promise<string> {
  const repoPath = await refreshMirror(project, true, { freshRef: ref.replace(/^refs\/heads\//, '') });
  return resolveCommitShaAt(repoPath, ref);
}

export interface BaseTipStore {
  /** The claim time when this caller won the check, else the stored tip (null while the first check runs). */
  claim: (projectId: string, ref: string, now: Date, staleBefore: Date) => Promise<{ won: Date } | { tip: string | null }>;
  /** Store the tip, unless the row moved since `claimedAt` (a newer claim or an expiry). */
  record: (projectId: string, ref: string, claimedAt: Date, tip: string | null) => Promise<void>;
}

export const dbBaseTipStore: BaseTipStore = {
  async claim(projectId, ref, now, staleBefore) {
    const [won] = await db
      .insert(baseTipChecks)
      .values({ projectId, ref, tip: null, checkedAt: now })
      .onConflictDoUpdate({
        target: [baseTipChecks.projectId, baseTipChecks.ref],
        set: { checkedAt: now },
        setWhere: lt(baseTipChecks.checkedAt, staleBefore),
      })
      .returning({ checkedAt: baseTipChecks.checkedAt });
    if (won) return { won: now };
    const [row] = await db
      .select({ tip: baseTipChecks.tip })
      .from(baseTipChecks)
      .where(and(eq(baseTipChecks.projectId, projectId), eq(baseTipChecks.ref, ref)))
      .limit(1);
    return { tip: row?.tip ?? null };
  },
  async record(projectId, ref, claimedAt, tip) {
    await db
      .update(baseTipChecks)
      .set(tip ? { tip } : { checkedAt: EXPIRED })
      .where(
        and(eq(baseTipChecks.projectId, projectId), eq(baseTipChecks.ref, ref), eq(baseTipChecks.checkedAt, claimedAt)),
      );
  },
};

/**
 * `ref`'s tip: the stored one when another request asked the upstream inside
 * the interval, else this request asks. A database failure only costs the
 * sharing: the request asks the upstream itself.
 */
export async function sharedBaseTip(
  project: GitBackedProject,
  ref: string,
  deps: { store: BaseTipStore; ask: typeof askUpstream; now: () => Date; intervalMs: () => number } = {
    store: dbBaseTipStore,
    ask: askUpstream,
    now: () => new Date(),
    intervalMs: refreshIntervalMs,
  },
): Promise<string> {
  const now = deps.now();
  const claim = await deps.store
    .claim(project.projectId, ref, now, new Date(now.getTime() - deps.intervalMs()))
    .catch(() => null);
  if (claim && 'tip' in claim && claim.tip) return claim.tip;
  const won = claim && 'won' in claim ? claim.won : null;
  let tip: string;
  try {
    tip = await deps.ask(project, ref);
  } catch (error) {
    // A failed check must not stand for the interval: the next request asks again.
    if (won) await deps.store.record(project.projectId, ref, won, null).catch(() => {});
    throw error;
  }
  if (won) await deps.store.record(project.projectId, ref, won, tip).catch(() => {});
  return tip;
}

/** A base ref of the project moved: the next request asks the upstream. Every ref, as `invalidateDesiredRelease` does. */
export async function expireBaseTips(projectId: string): Promise<void> {
  await db.update(baseTipChecks).set({ checkedAt: EXPIRED }).where(eq(baseTipChecks.projectId, projectId));
}
