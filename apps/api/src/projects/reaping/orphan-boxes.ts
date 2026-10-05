/**
 * Orphan provider-box reaper.
 *
 * The other sweeps are DB-driven: they reconcile boxes that HAVE a
 * session_sandboxes row. A box that loses its row (migration, a dropped create,
 * a pre-clamp leftover) — or a persistent (autoStop=0) box nothing else reaps —
 * keeps running on the provider forever, invisible to the DB sweep, burning
 * compute (the leak observed 2026-06-21: ~85 running boxes the DB didn't track).
 * This pass closes the gap from the OTHER side: it lists the boxes THIS
 * database and instance own on the provider and stops boxes with no DB reference.
 *
 * Safety:
 *  - Versioned provider markers isolate databases and instances, including
 *    older clients that still use environment-wide cleanup.
 *  - Any DB reference excludes cleanup, regardless of status or age. Re-read
 *    immediately before stop; DB-driven lifecycle paths own referenced boxes.
 *  - Age grace: a box younger than ORPHAN_BOX_GRACE_MS (or whose createdAt we
 *    can't read) is skipped — covers the window between provider-create and the
 *    DB row landing.
 *  - STOP only, never delete; bounded per pass; failures are logged and the
 *    sweep continues.
 */

import { isNotNull } from 'drizzle-orm';
import { appRuntimes, projectMonitorBoxes, sessionSandboxes } from '@kortix/db';
import { config } from '../../config';
import { db } from '../../shared/db';
import { getProvider, type ProviderName } from '../../platform/providers';
import { REAP_CONCURRENCY } from '../reaper-constants';
import { hasProviderBoxReference } from './orphan-box-references';
import {
  EMPTY_ROW_VM_DIVERGENCE,
  closeRowVmDivergence,
  type RowVmDivergenceResult,
} from './row-vm-divergence';

const ORPHAN_BOX_GRACE_MS = 60 * 60_000; // a box must be this old to qualify
const ORPHAN_REAP_MAX_PER_PASS = 50; // bound provider stop() calls per pass

export interface OrphanReapResult {
  listed: number;
  orphans: number;
  stopped: number;
  errors: number;
  /** Parked rows whose VM this pass found running, and stopped. */
  divergence: RowVmDivergenceResult;
}

export async function reapOrphanProviderBoxes(now = new Date()): Promise<OrphanReapResult> {
  const zero: OrphanReapResult = {
    listed: 0,
    orphans: 0,
    stopped: 0,
    errors: 0,
    divergence: EMPTY_ROW_VM_DIVERGENCE,
  };
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

  const [sessionKeepRows, appKeepRows, monitorKeepRows] = await Promise.all([
    db
      .select({
        provider: sessionSandboxes.provider,
        externalId: sessionSandboxes.externalId,
        // Carried for the row↔VM divergence pass below: a row whose status says
        // the box is off, over a box this listing proves is running.
        status: sessionSandboxes.status,
        sandboxId: sessionSandboxes.sandboxId,
      })
      .from(sessionSandboxes)
      .where(isNotNull(sessionSandboxes.externalId)),
    db
      .select({ provider: appRuntimes.provider, externalId: appRuntimes.externalId })
      .from(appRuntimes)
      .where(isNotNull(appRuntimes.externalId)),
    db
      .select({
        provider: projectMonitorBoxes.provider,
        externalId: projectMonitorBoxes.externalId,
      })
      .from(projectMonitorBoxes)
      .where(isNotNull(projectMonitorBoxes.externalId)),
  ]);
  const keepRows = [...sessionKeepRows, ...appKeepRows, ...monitorKeepRows];
  const keep = new Set(
    keepRows
      .filter((row): row is typeof row & { externalId: string } => !!row.externalId)
      .map((row) => `${row.provider}:${row.externalId}`),
  );

  // Same listing, the other divergence direction: a box that IS referenced, by
  // a row that says it should be off. The orphan filter below deliberately
  // keeps every referenced box, so without this pass nothing would ever look.
  const divergence = await closeRowVmDivergence({
    boxes,
    rows: sessionKeepRows.flatMap((row) =>
      row.externalId
        ? [{ provider: row.provider, externalId: row.externalId, status: row.status, sandboxId: row.sandboxId }]
        : [],
    ),
    now,
  }).catch((err) => {
    console.warn('[row-vm] divergence pass failed:', err instanceof Error ? err.message : err);
    return { ...EMPTY_ROW_VM_DIVERGENCE, errors: 1 };
  });

  const cutoff = now.getTime() - ORPHAN_BOX_GRACE_MS;
  const orphans = boxes.filter(
    (box) =>
      !keep.has(`${box.provider}:${box.externalId}`) &&
      box.createdAt != null &&
      box.createdAt.getTime() <= cutoff,
  );

  let stopped = 0;
  let errors = 0;
  let attempted = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < orphans.length && attempted < ORPHAN_REAP_MAX_PER_PASS) {
      const box = orphans[cursor++];
      try {
        if (await hasProviderBoxReference(box.provider, box.externalId)) continue;
        if (attempted >= ORPHAN_REAP_MAX_PER_PASS) break;
        attempted += 1;
        console.log('[reaper] stopping owned unreferenced box', { provider: box.provider, externalId: box.externalId });
        await getProvider(box.provider).stop(box.externalId);
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
  return { listed: boxes.length, orphans: orphans.length, stopped, errors, divergence };
}
