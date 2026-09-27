import { sessionLifecycleCommands } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { type CommandLease, ownedByLease } from './command-lease';

export class InboxDeliveryPaused extends Error {
  constructor() {
    super('Prompt delivery paused');
  }
}

/** Re-read Stop before each POST, including retries inside the readiness loop. */
export async function assertInboxDeliveryActive(commandId: string): Promise<void> {
  const [row] = await db
    .select({
      result: sessionLifecycleCommands.result,
      payload: sessionLifecycleCommands.payload,
    })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.commandId, commandId))
    .limit(1);
  if (!row || row.result?.held === true || row.payload?.stopPausedOnDelivery === true) {
    throw new InboxDeliveryPaused();
  }
}

export async function releasePausedInboxDelivery(lease: CommandLease): Promise<void> {
  // Preserve the CURRENT hold. Resume may have cleared it since the read above.
  // Only release our own running claim; a deleted row must never be resurrected.
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
