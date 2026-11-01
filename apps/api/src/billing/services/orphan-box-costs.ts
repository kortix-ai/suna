/**
 * Kortix's own cost of the boxes it created and no Kortix row owns. The
 * orphan reaper (projects/reaping/orphan-boxes.ts) lists the running boxes
 * this deployment created on Platinum, and stops each one that no session,
 * App or monitor row names: a create Kortix gave up on, a box whose row was
 * dropped. Compute metering never opened a window for such a box, so no
 * customer paid for it. Before the stop, this records what Platinum charged
 * for the box since it was created (`GET /v1/sandboxes/:id/usage`) in
 * kortix.provider_orphan_box_costs. Nothing here is charged to anyone.
 *
 * One row per box (keyed by the UTC day it was created). A box the reaper
 * sees on several passes (its stop failed) updates the same row to the latest
 * total, and `events` counts the passes.
 */
import { sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { platinumJson, platinumOriginForSandbox } from '../../shared/platinum';

export const ORPHAN_BOX_METER = 'sandbox.lifetime';

export interface OrphanBox {
  provider: string;
  externalId: string;
  createdAt: Date | null;
}

export interface PlatinumSandboxUsage {
  cost_usd?: number;
  uptime_seconds?: number;
}

export interface OrphanBoxCostDeps {
  usage(externalId: string, sinceMs: number): Promise<PlatinumSandboxUsage>;
  record(row: { sandboxId: string; usageDay: string; uptimeSeconds: number; amountMicros: number }): Promise<void>;
}

export const orphanBoxCostDeps: OrphanBoxCostDeps = {
  usage(externalId, sinceMs) {
    return platinumJson<PlatinumSandboxUsage>(
      `/v1/sandboxes/${encodeURIComponent(externalId)}/usage?since_ms=${Math.floor(sinceMs)}`,
      {},
      platinumOriginForSandbox(externalId),
    );
  },
  async record(row) {
    await db.execute(sql`
      INSERT INTO kortix.provider_orphan_box_costs (feed, sandbox_id, usage_day, meter, quantity, amount_micros, events)
      VALUES ('platinum', ${row.sandboxId}, ${row.usageDay}, ${ORPHAN_BOX_METER}, ${row.uptimeSeconds}, ${row.amountMicros}, 1)
      ON CONFLICT (feed, sandbox_id, usage_day, meter) DO UPDATE SET
        quantity = GREATEST(kortix.provider_orphan_box_costs.quantity, excluded.quantity),
        amount_micros = GREATEST(kortix.provider_orphan_box_costs.amount_micros, excluded.amount_micros),
        events = kortix.provider_orphan_box_costs.events + 1,
        updated_at = now()`);
  },
};

/**
 * Record what Platinum charged for one orphan box. Never throws: a failed
 * read must not keep the reaper from stopping the box.
 */
export async function recordOrphanBoxCost(box: OrphanBox, deps: OrphanBoxCostDeps = orphanBoxCostDeps): Promise<number | null> {
  if (box.provider !== 'platinum' || !box.createdAt) return null;
  try {
    const usage = await deps.usage(box.externalId, box.createdAt.getTime());
    const amountMicros = Math.max(Math.round((Number(usage.cost_usd) || 0) * 1_000_000), 0);
    await deps.record({
      sandboxId: box.externalId,
      usageDay: box.createdAt.toISOString().slice(0, 10),
      uptimeSeconds: Math.max(Number(usage.uptime_seconds) || 0, 0),
      amountMicros,
    });
    logger.warn('[orphan-box-costs] Kortix paid for a box no Kortix row owns', {
      externalId: box.externalId,
      createdAt: box.createdAt.toISOString(),
      costMicros: amountMicros,
    });
    return amountMicros;
  } catch (error) {
    logger.error('[orphan-box-costs] could not record the cost of an orphan box', {
      externalId: box.externalId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
