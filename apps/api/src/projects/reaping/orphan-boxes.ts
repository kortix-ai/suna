/**
 * Orphan provider-box reaper.
 *
 * The other sweeps are DB-driven: they reconcile boxes that HAVE a
 * session_sandboxes row. A box that loses its row (migration, a dropped create,
 * a pre-clamp leftover) — or a persistent (autoStop=0) box nothing else reaps —
 * keeps running on the provider forever, invisible to the DB sweep, burning
 * compute (the leak observed 2026-06-21: ~85 running boxes the DB didn't track).
 * This pass closes the gap from the OTHER side: it lists the boxes THIS
 * environment owns on the provider and stops any with no live DB row.
 *
 * Safety:
 *  - Scoped to this env via provider labels (the org is shared across
 *    prod/dev/local) — each provider adapter owns that filter.
 *  - keepSet = every box the DB considers live (active/provisioning) OR touched
 *    within ORPHAN_KEEP_RECENT_MS, so an in-flight session is never stopped.
 *  - Age grace: a box younger than ORPHAN_BOX_GRACE_MS (or whose createdAt we
 *    can't read) is skipped — covers the window between provider-create and the
 *    DB row landing.
 *  - STOP only, never delete; bounded per pass; failures are logged and the
 *    sweep continues.
 */

import { and, gt, inArray, isNotNull, or } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { config } from '../../config';
import { db } from '../../shared/db';
import { getProvider, type ProviderName } from '../../platform/providers';
import { REAP_CONCURRENCY } from '../reaper-constants';
import { reconcileSandboxStoppedByExternalId } from './sandbox-state-sync';

const ORPHAN_KEEP_RECENT_MS = 15 * 60_000; // don't stop a just-touched box
const ORPHAN_BOX_GRACE_MS = 60 * 60_000; // a box must be this old to qualify
const ORPHAN_REAP_MAX_PER_PASS = 50; // bound provider stop() calls per pass

export interface OrphanReapResult {
  listed: number;
  orphans: number;
  stopped: number;
  errors: number;
}

export async function reapOrphanProviderBoxes(now = new Date()): Promise<OrphanReapResult> {
  const zero: OrphanReapResult = { listed: 0, orphans: 0, stopped: 0, errors: 0 };
  if (process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED === 'false') return zero;
  const boxes: Array<{
    provider: ProviderName;
    externalId: string;
    createdAt: Date | null;
  }> = [];
  for (const providerName of config.ALLOWED_SANDBOX_PROVIDERS) {
    try {
      const provider = getProvider(providerName);
      if (!provider.listManagedRunningSandboxes) continue;
      const listed = await provider.listManagedRunningSandboxes();
      boxes.push(...listed.map((box) => ({ provider: providerName, ...box })));
    } catch (err) {
      // One provider control-plane outage must not suppress orphan cleanup on
      // the other configured providers.
      console.warn(
        `[reaper] ${providerName} orphan-box list failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (boxes.length === 0) return zero;

  // keepSet: never stop a box the DB considers live or touched recently.
  const keepRows = await db
    .select({ provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(
      and(
        isNotNull(sessionSandboxes.externalId),
        or(
          inArray(sessionSandboxes.status, ['active', 'provisioning']),
          gt(sessionSandboxes.updatedAt, new Date(now.getTime() - ORPHAN_KEEP_RECENT_MS)),
        ),
      ),
    );
  const keep = new Set(
    keepRows
      .filter((row): row is typeof row & { externalId: string } => !!row.externalId)
      .map((row) => `${row.provider}:${row.externalId}`),
  );

  const cutoff = now.getTime() - ORPHAN_BOX_GRACE_MS;
  const orphans = boxes.filter(
    (box) =>
      !keep.has(`${box.provider}:${box.externalId}`) &&
      box.createdAt != null &&
      box.createdAt.getTime() <= cutoff,
  );

  let stopped = 0;
  let errors = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < orphans.length && stopped + errors < ORPHAN_REAP_MAX_PER_PASS) {
      const box = orphans[cursor++];
      try {
        await getProvider(box.provider).stop(box.externalId);
        // Reconcile any DB row (state drift) + close billing; no-op when there's none.
        await reconcileSandboxStoppedByExternalId(box.externalId, now).catch(() => {});
        stopped += 1;
      } catch (err) {
        errors += 1;
        if (errors <= 5) {
          console.warn(
            `[reaper] orphan-box stop failed for ${box.externalId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, orphans.length) }, worker));
  if (stopped || errors) {
    console.log('[reaper] orphan-box sweep', { listed: boxes.length, orphans: orphans.length, stopped, errors });
  }
  return { listed: boxes.length, orphans: orphans.length, stopped, errors };
}
