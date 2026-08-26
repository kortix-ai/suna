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
import { reArmRuntimeBlockedPrompts } from './store';

export interface LostTurn {
  token: string;
  messageId: string | null;
  state: string;
}

export interface RuntimeRestartRecoveryDeps {
  settleLostTurns: (sandboxId: string) => Promise<LostTurn[]>;
  /** Make prompts this session parked on a DOWN runtime due now. */
  reArmBlockedPrompts: (sessionId: string) => Promise<number>;
  /** Drain the queue now rather than waiting out the scheduler's next tick. */
  kickDrain: () => void;
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
  /** Prompts re-armed because the runtime is reachable again. */
  reArmed: number;
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
  reArmBlockedPrompts: (sessionId) => reArmRuntimeBlockedPrompts(sessionId),
  // Fire-and-forget: the drain re-checks every claim itself, so a kick that
  // loses a race is a no-op and a lost kick falls back to the scheduler tick.
  //
  // DYNAMIC import on purpose. `sandbox-proxy/backend.ts` imports this module,
  // and pulling the whole engine into that graph statically drags every module
  // the engine touches into tests that only mock part of it — two suites broke
  // on a partially-mocked `shared/daytona` / `projects/git` the moment the
  // static edge existed. Nothing here needs the engine before this call.
  kickDrain: () =>
    void import('./engine')
      .then((m) => m.drainSessionLifecycleQueue({ limit: 5 }))
      .catch(() => undefined),
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
  // THE RUNTIME IS BACK. Every caller of this function has just observed a
  // runtime become reachable again — a confirmed wake, or the proxy finding a
  // restarted box. That is the event a prompt parked on an unreachable runtime
  // has been waiting for, so it goes out now instead of on its backoff ladder.
  // Independent of `lost`: a box can come back with nothing to settle and still
  // owe the user the message they sent while it was down.
  let reArmed = 0;
  try {
    reArmed = await deps.reArmBlockedPrompts(input.sessionId);
    if (reArmed > 0) deps.kickDrain();
  } catch (err) {
    deps.log?.('[runtime-restart] re-arming runtime-blocked prompts failed', {
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { lost, redeliveries, reArmed };
}
