/**
 * A runtime that is started again after the provider had it STOPPED comes back
 * with nothing in memory: every pause Kortix issues or observes is a
 * `keepMemory:false` pause (E2B), a stop (Daytona) or a lifecycle stop
 * (Platinum). Any turn that was open on that box is therefore over — the
 * OpenCode process that owned it is gone — and its last assistant message sits
 * in the transcript with `tokens 0/0/0` and no parts.
 *
 * Essentia 2026-08-25: the provider paused two boxes mid-turn; the UI's next
 * request woke them through the proxy (`wakeSandbox`) without touching the turn
 * authority, the fresh runtime answered `idle`, and one turn was closed
 * `completed` — the user saw the agent "just stop", with no error and nothing
 * to resume. The other box, confirmed stopped by the reaper first, closed
 * `runtime_gone` but its accepted prompt was never redelivered, so the user had
 * to type "go on".
 *
 * This is the single place a restart-under-a-turn is repaired: settle every
 * open ledger row `runtime_gone`, drop the turn authority the dead runtime held,
 * and redeliver each prompt those turns carried. `hold:false` on a wake —
 * the box is up and someone is looking — so the interrupted work continues by
 * itself; `MAX_PROMPT_REDELIVERIES` in redelivery.ts bounds any loop.
 */
import { eq, sql } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { settleOpenSandboxTurns, storedSandboxTurns } from '../sandbox-turn-lifecycle';
import { type PromptRedelivery, requeueAbandonedPrompt } from './redelivery';

export interface LostTurn {
  token: string;
  messageId: string | null;
  state: string;
}

export interface RuntimeRestartRecoveryDeps {
  settleLostTurns: (sandboxId: string) => Promise<LostTurn[]>;
  requeue: (input: {
    sessionId: string;
    wireMessageId: string | null;
    turnToken: string;
    endReason: 'runtime_gone';
    hold: boolean;
  }) => Promise<PromptRedelivery>;
  log?: (message: string, meta: Record<string, unknown>) => void;
}

export interface RuntimeRestartRecoveryResult {
  lost: LostTurn[];
  redeliveries: Array<{ token: string; outcome: PromptRedelivery | 'error' }>;
}

/**
 * Settle every open turn of a sandbox whose runtime just restarted and drop the
 * metadata authority that would otherwise let the fresh runtime's first idle
 * read close those turns as `completed`.
 */
export async function settleTurnsLostToRuntimeRestart(sandboxId: string): Promise<LostTurn[]> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .for('update')
      .limit(1);
    const turns = storedSandboxTurns(row?.metadata as Record<string, unknown> | null);
    if (turns.length === 0) return [];
    await tx
      .update(sessionSandboxes)
      .set({
        metadata: sql`(coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
          - 'activeTurn'
          - 'activeTurns'
          - 'pendingStopObservedAtMs')`,
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, sandboxId));
    await settleOpenSandboxTurns(tx, sandboxId, 'runtime_gone');
    return turns.map((turn) => ({
      token: turn.token,
      messageId: turn.messageId ?? null,
      state: turn.state,
    }));
  });
}

const liveDeps: RuntimeRestartRecoveryDeps = {
  settleLostTurns: settleTurnsLostToRuntimeRestart,
  requeue: (input) => requeueAbandonedPrompt(input),
  log: (message, meta) => console.log(message, meta),
};

export async function recoverTurnsAfterRuntimeRestart(
  input: { sandboxId: string; sessionId: string; externalId?: string | null; hold?: boolean },
  deps: RuntimeRestartRecoveryDeps = liveDeps,
): Promise<RuntimeRestartRecoveryResult> {
  const lost = await deps.settleLostTurns(input.sandboxId);
  const redeliveries: RuntimeRestartRecoveryResult['redeliveries'] = [];
  for (const turn of lost) {
    try {
      const outcome = await deps.requeue({
        sessionId: input.sessionId,
        wireMessageId: turn.messageId,
        turnToken: turn.token,
        endReason: 'runtime_gone',
        hold: input.hold ?? false,
      });
      redeliveries.push({ token: turn.token, outcome });
    } catch (err) {
      redeliveries.push({ token: turn.token, outcome: 'error' });
      deps.log?.('[runtime-restart] prompt redelivery failed', {
        sandboxId: input.sandboxId,
        turn: turn.token,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (lost.length > 0) {
    deps.log?.('[runtime-restart] runtime restarted under open turns; settled runtime_gone', {
      sandboxId: input.sandboxId,
      externalId: input.externalId ?? null,
      turns: lost.map((turn) => `${turn.token}:${turn.state}`),
      redeliveries,
      hold: input.hold ?? false,
    });
  }
  return { lost, redeliveries };
}
