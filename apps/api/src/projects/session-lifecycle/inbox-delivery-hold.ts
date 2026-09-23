import { sessionLifecycleCommands } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

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

/**
 * The POST's own commit: the last statement before an inbox prompt goes to
 * the runtime.
 *
 * It marks the claimed row `post_committed_at`, and only while nothing has
 * taken the row back: it must still be `running` (a Remove deletes a claimed,
 * uncommitted row — `deleteInboxPrompt`), and not held by a Stop. The mark and
 * the Remove are single statements on one row, so the row lock orders them:
 * if the Remove ran first this matches nothing and the delivery stops here;
 * if this ran first the Remove leaves the row to the cancel path, which knows
 * the runtime may already hold the message.
 *
 * Idempotent: a retry of the same POST re-marks the same row.
 */
export async function commitInboxPost(commandId: string): Promise<void> {
  const committed = await db
    .update(sessionLifecycleCommands)
    .set({
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
        || jsonb_build_object('post_committed_at', to_jsonb(now()))`,
    })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, commandId),
        eq(sessionLifecycleCommands.status, 'running'),
        sql`COALESCE(${sessionLifecycleCommands.result}->>'held', '') <> 'true'`,
        sql`COALESCE(${sessionLifecycleCommands.payload}->>'stopPausedOnDelivery', '') <> 'true'`,
      ),
    )
    .returning({ commandId: sessionLifecycleCommands.commandId });
  if (committed.length === 0) throw new InboxDeliveryPaused();
}

export async function releasePausedInboxDelivery(commandId: string): Promise<void> {
  // Preserve the CURRENT hold. Resume may have cleared it since the read above.
  // Only release our running claim; a deleted row must never be resurrected.
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
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, commandId),
        eq(sessionLifecycleCommands.status, 'running'),
      ),
    );
}

