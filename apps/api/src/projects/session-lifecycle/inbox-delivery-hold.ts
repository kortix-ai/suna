import { sessionLifecycleCommands } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { type CommandLease, ownedByLease } from './command-lease';
import { isHeld, isStopPausedOnDelivery } from './delivery-state';

export class InboxDeliveryPaused extends Error {
  constructor() {
    super('Prompt delivery paused');
  }
}

/**
 * Re-read the row before each POST, including retries inside the readiness
 * loop. Two things stop the POST: a Stop (the hold), and a claim this delivery
 * no longer owns — a shutdown handed the row back (`handBackClaims`) and
 * another pod may already be sending it. A `succeeded` row is still ours: a
 * placement repair re-sends after its own forward closed the claim.
 */
export async function assertInboxDeliveryActive(lease: CommandLease): Promise<void> {
  const [row] = await db
    .select({
      status: sessionLifecycleCommands.status,
      lockedBy: sessionLifecycleCommands.lockedBy,
      result: sessionLifecycleCommands.result,
      payload: sessionLifecycleCommands.payload,
    })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.commandId, lease.commandId))
    .limit(1);
  if (
    !row ||
    (row.status !== 'succeeded' && row.lockedBy !== lease.lockedBy) ||
    isHeld(row.result) ||
    isStopPausedOnDelivery(row.payload)
  ) {
    throw new InboxDeliveryPaused();
  }
}

/**
 * Give a claimed row back to the queue, due now, with the claim's attempt
 * increment returned. Preserves the CURRENT hold: Resume may have cleared it
 * since the read above, and a held inbox row is not claimed again until it is
 * lifted. Only our own running claim; a deleted row must never be resurrected.
 */
export async function returnClaimToQueue(lease: CommandLease): Promise<void> {
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      attempts: sql`GREATEST(0, ${sessionLifecycleCommands.attempts} - 1)`,
      availableAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(ownedByLease(lease));
}
