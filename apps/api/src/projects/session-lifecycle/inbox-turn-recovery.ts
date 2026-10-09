import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { notifyClosedTurn } from '../../notifications/session-push';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { clearSandboxTurn } from '../sandbox-turn-lifecycle';
import { storedSandboxTurns } from '../session-turn-ledger';
import { observeSandboxTurn } from '../sandbox-turn-observation';

type Box = Pick<typeof sessionSandboxes.$inferSelect, 'sessionId' | 'sandboxId' | 'externalId' | 'provider' | 'metadata'>;

/** The end reasons of the turns THIS call closed (its `clear` won). */
export async function settleCompletedInboxTurns(
  box: Box,
  deps = { observe: observeSandboxTurn, clear: clearSandboxTurn, provider: getProvider },
): Promise<('completed' | 'failed')[]> {
  const settled: ('completed' | 'failed')[] = [];
  if (!box.externalId) return settled;
  for (const turn of storedSandboxTurns(box.metadata)) {
    // Never infer completion from a reservation or a missing/unanswered prompt.
    if (turn.state !== 'active' || !turn.messageId || !turn.runtimeSessionId) continue;
    const reading = await deps.observe(deps.provider(box.provider), box.externalId, box.sandboxId, turn);
    if (reading.observation === 'terminal' &&
        (reading.endReason === 'completed' || reading.endReason === 'failed')) {
      // Token-scoped CAS cannot erase a newer turn that started during the read.
      if (await deps.clear(box.sandboxId, turn.token, undefined, reading.endReason)) settled.push(reading.endReason);
    }
  }
  return settled;
}

export async function reconcileInboxTurn(sessionId: string): Promise<void> {
  const [box] = await db.select().from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId)).limit(1);
  if (box) await settleCompletedInboxTurns(box);
}

const recoveryInFlight = new Set<string>();

/** True when a queued prompt was promoted: the session keeps running. */
async function wakeRecoveredSession(sessionId: string): Promise<boolean> {
  const { promoteNextInboxRow } = await import('./store');
  const idempotencyKey = await promoteNextInboxRow(sessionId);
  if (!idempotencyKey) return false;
  const { drainSessionLifecycleQueue } = await import('./drain');
  await drainSessionLifecycleQueue({ idempotencyKey, coalesce: false });
  return true;
}

/** Keep reloads from reviving a completed turn while its terminal relay is missing. */
export function scheduleSessionTurnRecovery(
  box: Box,
  recover: typeof settleCompletedInboxTurns = settleCompletedInboxTurns,
  wake: (sessionId: string) => Promise<boolean> = wakeRecoveredSession,
  notify: typeof notifyClosedTurn = notifyClosedTurn,
): void {
  if (!box.externalId || recoveryInFlight.has(box.sandboxId)) return;
  recoveryInFlight.add(box.sandboxId);
  void recover(box)
    .then(async (settled) => {
      if (settled.length === 0) return;
      const promoted = await wake(box.sessionId);
      // This read closed the turn, so the relay's late `end` gets
      // `already_closed` and sends nothing: the push is ours. One per settle.
      void notify({ sessionId: box.sessionId, reason: settled.includes('failed') ? 'failed' : 'completed', promoted });
    })
    .catch((error) => console.warn('[session-turn] terminal recovery failed', error))
    .finally(() => recoveryInFlight.delete(box.sandboxId));
}
