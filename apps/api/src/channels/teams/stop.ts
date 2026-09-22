import { and, eq } from 'drizzle-orm';
import { chatThreadParticipants } from '@kortix/db';
import { db } from '../../shared/db';
import { claimFinalize, deleteTurn, finalizeTurn, loadTurn } from './turn';
import type { TeamsLiveTurn } from './types';

const PLATFORM = 'teams';

/**
 * Who may press Stop on a live turn.
 *
 * An Adaptive Card is posted to the conversation, so the button is visible to
 * everyone in it — the check has to happen when it is pressed, not when it is
 * drawn. Two people may stop a run:
 *
 *  - whoever sent the message this turn is answering (`originatingActivity`),
 *    which is the only correct answer under `project_open`, where the session
 *    owner and the person actually waiting are routinely different people;
 *  - anyone already approved on this conversation, which is how the session
 *    owner and every accepted joiner are recorded.
 *
 * Anyone else is refused. Failing closed on a stop is the safe direction: the
 * worst case is that a bystander waits for the run to end, instead of a
 * bystander ending someone else's work.
 */
async function mayStopTeamsTurn(
  handle: TeamsLiveTurn,
  teamsUserId: string,
): Promise<boolean> {
  if (!teamsUserId) return false;
  if (handle.originatingActivity?.from?.id === teamsUserId) return true;
  try {
    const [row] = await db
      .select({ status: chatThreadParticipants.status })
      .from(chatThreadParticipants)
      .where(
        and(
          eq(chatThreadParticipants.platform, PLATFORM),
          eq(chatThreadParticipants.workspaceId, handle.tenantId),
          eq(chatThreadParticipants.threadId, handle.conversationId),
          eq(chatThreadParticipants.platformUserId, teamsUserId),
        ),
      )
      .limit(1);
    return row?.status === 'approved';
  } catch (err) {
    console.warn('[teams-webhook] stop participant lookup failed (refusing)', err);
    return false;
  }
}

export type TeamsStopOutcome =
  | { stopped: true; stoppedRuntime: boolean }
  | { stopped: false; notice: string };

/**
 * End the run behind a live card.
 *
 * Closing the card is not ending the run: OpenCode can hold its assistant
 * message open, and while it does every later prompt in the conversation is
 * accepted and never runs (dev 2026-09-19, two messages lost over two days).
 * So the abort goes to the runtime first and the card is settled afterwards,
 * in that order — a card that says "stopped" over a turn that is still
 * running is the worse lie.
 *
 * The runtime abort is best effort: a sandbox that is already parked or gone
 * needs none, and the turn still has to be closed either way.
 */
export async function stopTeamsTurn(input: {
  sessionId: string;
  teamsUserId: string;
  byName?: string;
}): Promise<TeamsStopOutcome> {
  const handle = await loadTurn(input.sessionId);
  if (!handle || handle.finalized) {
    return { stopped: false, notice: 'That run has already finished.' };
  }
  if (!(await mayStopTeamsTurn(handle, input.teamsUserId))) {
    return {
      stopped: false,
      notice: 'Only the person who sent this message, or someone already working in this session, can stop it.',
    };
  }

  // Claim the finalize BEFORE touching the runtime. The abort makes OpenCode
  // end the turn, which relays back as `relayTurnEnd(status: 'error')` — and
  // that path claims the same row and repaints the card "Run failed". Winning
  // the claim first makes the relay a no-op, so a deliberate stop cannot be
  // overwritten by the failure it caused. Losing it means the turn settled
  // between `loadTurn` and here; say so rather than paint over the result.
  if (!(await claimFinalize(input.sessionId))) {
    return { stopped: false, notice: 'That run has already finished.' };
  }

  let stoppedRuntime = false;
  try {
    // Lazily imported so the channel modules keep no static edge into the
    // session-lifecycle engine (the same rule turn.ts follows for the GC).
    const { abortRuntimeTurn } = await import('../../projects/session-lifecycle/abort-runtime-turn');
    stoppedRuntime = await abortRuntimeTurn(input.sessionId, { requestedStop: true });
  } catch (err) {
    console.warn('[teams-webhook] runtime abort failed on stop', {
      sessionId: input.sessionId,
      err: (err as Error)?.message,
    });
  }

  const by = input.byName?.trim();
  await finalizeTurn(handle, {
    title: 'Stopped',
    answer: by ? `Stopped by ${by}.` : 'Stopped.',
    unfinished: true,
  });
  await deleteTurn(input.sessionId);
  return { stopped: true, stoppedRuntime };
}
