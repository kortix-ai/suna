/**
 * The monitor box was removed (Apps replace it). A box that was still live
 * when the code went out has nothing left to reconcile it, so each maintenance
 * pass removes it at the provider, closes its compute window and marks it
 * `deleted`. Once no environment holds a live box, this module, the
 * `project_monitor_boxes` table and the billing/reaping reads of it go
 * together in one migration (expand/contract).
 */
import { projectMonitorBoxes } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { endComputeSession } from '../../billing/services/compute-metering';
import type { SandboxProviderName } from '../../config';
import { logger } from '../../lib/logger';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';

const LIVE = ['provisioning', 'starting', 'running', 'stopping', 'stopped', 'error'];

export async function retireMonitorBoxes(): Promise<{ retired: number; errors: number }> {
  const boxes = await db.select().from(projectMonitorBoxes).where(inArray(projectMonitorBoxes.status, LIVE)).limit(50);
  let retired = 0;
  let errors = 0;
  for (const box of boxes) {
    try {
      if (box.externalId) await getProvider(box.provider as SandboxProviderName).remove(box.externalId);
      await endComputeSession(box.boxId);
      await db.update(projectMonitorBoxes).set({ status: 'deleted', updatedAt: new Date() }).where(eq(projectMonitorBoxes.boxId, box.boxId));
      retired += 1;
    } catch (error) {
      errors += 1;
      logger.warn('[monitors] retiring a monitor box failed', { boxId: box.boxId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { retired, errors };
}
