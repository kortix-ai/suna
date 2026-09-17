import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { clearSandboxTurn, storedSandboxTurns } from '../sandbox-turn-lifecycle';
import { observeSandboxTurn } from '../sandbox-turn-observation';

type Box = Pick<typeof sessionSandboxes.$inferSelect, 'sessionId' | 'sandboxId' | 'externalId' | 'provider' | 'metadata'>;

export async function settleCompletedInboxTurns(
  box: Box,
  deps = { observe: observeSandboxTurn, clear: clearSandboxTurn, provider: getProvider },
): Promise<boolean> {
  if (!box.externalId) return false;
  let settled = false;
  for (const turn of storedSandboxTurns(box.metadata)) {
    // Never infer completion from a reservation or a missing/unanswered prompt.
    if (turn.state !== 'active' || !turn.messageId || !turn.opencodeSessionId) continue;
    const reading = await deps.observe(deps.provider(box.provider), box.externalId, box.sandboxId, turn);
    if (reading.observation === 'terminal' &&
        (reading.endReason === 'completed' || reading.endReason === 'failed')) {
      // Token-scoped CAS cannot erase a newer turn that started during the read.
      const cleared = await deps.clear(box.sandboxId, turn.token, undefined, reading.endReason);
      settled = cleared || settled;
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

async function wakeRecoveredSession(sessionId: string): Promise<void> {
  const { promoteNextInboxRow } = await import('./store');
  const idempotencyKey = await promoteNextInboxRow(sessionId);
  if (!idempotencyKey) return;
  const { drainSessionLifecycleQueue } = await import('./engine');
  await drainSessionLifecycleQueue({ idempotencyKey, coalesce: false });
}

/** Keep reloads from reviving a completed turn while its terminal relay is missing. */
export function scheduleSessionTurnRecovery(
  box: Box,
  recover: typeof settleCompletedInboxTurns = settleCompletedInboxTurns,
  wake: (sessionId: string) => Promise<void> = wakeRecoveredSession,
): void {
  if (!box.externalId || recoveryInFlight.has(box.sandboxId)) return;
  recoveryInFlight.add(box.sandboxId);
  void recover(box)
    .then((settled) => { if (settled) return wake(box.sessionId); })
    .catch((error) => console.warn('[session-turn] terminal recovery failed', error))
    .finally(() => recoveryInFlight.delete(box.sandboxId));
}
