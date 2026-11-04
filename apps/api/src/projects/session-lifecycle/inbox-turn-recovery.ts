import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { getProvider, isProviderName } from '../../platform/providers';
import { db } from '../../shared/db';
import { clearSandboxTurn } from '../sandbox-turn-lifecycle';
import { storedSandboxTurns } from '../session-turn-ledger';
import { observeSandboxTurn } from '../sandbox-turn-observation';

type Box = Pick<typeof sessionSandboxes.$inferSelect, 'sessionId' | 'sandboxId' | 'externalId' | 'provider' | 'metadata'>;

/**
 * The turn-end work of a turn this reader closed: the result excerpt and the
 * idle notices (`onPeerTurnEnded`). The daemon's own end frame then finds the
 * turn `already_closed`. Imported late: peer-messages imports the lifecycle.
 */
async function peerTurnEnded(sessionId: string, outcome: 'idle' | 'error'): Promise<void> {
  const { onPeerTurnEnded } = await import('../peer-messages/service');
  await onPeerTurnEnded(sessionId, outcome);
}

const defaultDeps = { observe: observeSandboxTurn, clear: clearSandboxTurn, provider: getProvider, turnEnded: peerTurnEnded };

/**
 * Close every active turn the box reports over (`completed` or `failed`), and
 * run the turn-end work for each one closed here. A session-list read calls
 * this, so it often closes the turn ~20 ms before the daemon's end frame.
 */
export async function settleCompletedInboxTurns(
  box: Box,
  overrides: Partial<typeof defaultDeps> = {},
): Promise<boolean> {
  const deps = { ...defaultDeps, ...overrides };
  // A legacy `e2b` row has no live provider; nothing to observe.
  if (!box.externalId || !isProviderName(box.provider)) return false;
  let settled = false;
  for (const turn of storedSandboxTurns(box.metadata)) {
    // Never infer completion from a reservation or a missing/unanswered prompt.
    if (turn.state !== 'active' || !turn.messageId || !turn.runtimeSessionId) continue;
    const reading = await deps.observe(deps.provider(box.provider), box.externalId, box.sandboxId, turn);
    if (reading.observation === 'terminal' &&
        (reading.endReason === 'completed' || reading.endReason === 'failed')) {
      // Token-scoped CAS cannot erase a newer turn that started during the read.
      const cleared = await deps.clear(box.sandboxId, turn.token, undefined, reading.endReason);
      if (cleared) await deps.turnEnded(box.sessionId, reading.endReason === 'failed' ? 'error' : 'idle');
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
  const { drainSessionLifecycleQueue } = await import('./drain');
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
