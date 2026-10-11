/**
 * A follow-up prompt from a channel (Slack, Teams, Email) or an API route
 * (a question answer, a change request, a post-create prompt), delivered
 * through the durable queue.
 *
 * These producers used to call `continueSession` directly: no row, a random
 * key, nothing retried once the pod that held the call died, and a
 * redelivered webhook sent the prompt twice. Each now enqueues ONE row under
 * the producer's own stable key, drains exactly that row, and reads its
 * outcome back. The row is `directFollowUp`: admission does not hold it behind
 * a live turn and a dead-letter does not park the session, as with the direct
 * call (see `QueuedContinueSessionPayload.directFollowUp`).
 */
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { drainSessionLifecycleQueue } from './drain';
import { enqueueContinueSessionCommand } from './enqueue-commands';
import { DELIVERY_FAILURE_COPY, type ContinueSessionCommand } from './types';

/**
 * `queued`: the row is durable and not delivered yet (the box is waking, a
 * retry is scheduled); the queue delivers it without the caller.
 */
export type FollowUpOutcome = 'delivered' | 'queued' | 'failed' | 'no-session';

export async function deliverThroughQueue(
  command: ContinueSessionCommand & { idempotencyKey: string },
): Promise<FollowUpOutcome> {
  const [session] = await db
    .select({
      status: projectSessions.status,
      metadata: projectSessions.metadata,
      projectId: projectSessions.projectId,
      accountId: projectSessions.accountId,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, command.sessionId))
    .limit(1);
  if (!session) return 'no-session';
  if (typeof (session.metadata as Record<string, unknown> | null)?.deletedAt === 'string') return 'no-session';
  if (command.projectId && command.projectId !== session.projectId) return 'no-session';
  // A parked session refuses delivery (`continueSession` → `unreachable`); the
  // caller shows its error rather than queueing behind a restart nobody asked for.
  if (session.status === 'failed') return 'failed';

  const { row } = await enqueueContinueSessionCommand({
    source: command.source,
    projectId: session.projectId,
    accountId: session.accountId,
    sessionId: command.sessionId,
    actorUserId: command.userId ?? null,
    text: command.text,
    idempotencyKey: command.idempotencyKey,
    ...(command.parts ? { parts: command.parts } : {}),
    ...(command.overrides ? { overrides: command.overrides } : {}),
    ...(command.opencodeEnv ? { opencodeEnv: command.opencodeEnv } : {}),
    directFollowUp: true,
  });
  await drainSessionLifecycleQueue({ idempotencyKey: command.idempotencyKey, burst: false, coalesce: false });

  const [after] = await db
    .select({ status: sessionLifecycleCommands.status, lastError: sessionLifecycleCommands.lastError })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.commandId, row.commandId))
    .limit(1);
  if (!after) return 'failed';
  if (after.status === 'succeeded') return 'delivered';
  if (after.status === 'queued' || after.status === 'running') return 'queued';
  return after.lastError === DELIVERY_FAILURE_COPY['no-session'] ? 'no-session' : 'failed';
}
