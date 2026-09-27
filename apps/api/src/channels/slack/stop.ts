import { and, eq } from 'drizzle-orm';
import { chatThreadParticipants } from '@kortix/db';
import { db } from '../../shared/db';
import { claimFinalize, deleteTurn, finalizeTurn, loadTurn } from './turn';
import type { LiveTurn } from './types';
export { SLACK_STOP_ACTION } from './stop-action';

const PLATFORM = 'slack';

/**
 * Who may press Stop on a live turn.
 *
 * The button sits on a message the whole thread can see, so the check happens
 * on the press, not when it is drawn. Two people may stop a run:
 *
 *  - whoever sent the message this turn is answering, which is the only
 *    correct answer in an open thread where the session owner and the person
 *    actually waiting are routinely different people;
 *  - anyone already approved on this thread, which is how the owner and every
 *    accepted joiner are recorded.
 *
 * Anyone else is refused, and an unresolvable lookup refuses too. Failing
 * closed is the safe direction: the worst case is a bystander waiting for a
 * run to end, not a bystander ending someone else's work.
 */
async function mayStopSlackTurn(handle: LiveTurn, slackUserId: string): Promise<boolean> {
  if (!slackUserId) return false;
  if (handle.originatingEvent?.user === slackUserId) return true;
  const threadId = handle.originatingEvent?.thread_ts ?? handle.originatingEvent?.ts ?? handle.triggerTs;
  if (!threadId) return false;
  try {
    const [row] = await db
      .select({ status: chatThreadParticipants.status })
      .from(chatThreadParticipants)
      .where(
        and(
          eq(chatThreadParticipants.platform, PLATFORM),
          eq(chatThreadParticipants.workspaceId, handle.teamId),
          eq(chatThreadParticipants.threadId, threadId),
          eq(chatThreadParticipants.platformUserId, slackUserId),
        ),
      )
      .limit(1);
    return row?.status === 'approved';
  } catch (err) {
    console.warn('[slack-webhook] stop participant lookup failed (refusing)', err);
    return false;
  }
}

export type SlackStopOutcome =
  | { stopped: true; stoppedRuntime: boolean }
  | { stopped: false; notice: string };

/**
 * End the run behind a live plan message.
 *
 * Closing the message is not ending the run. OpenCode can hold its assistant
 * message open, and while it does every later prompt in the thread is accepted
 * and never runs — the failure Teams hit on dev 2026-09-19, where two of the
 * user's messages vanished over two days. Slack has the same shape and, until
 * now, no lever at all: the only way out was to wait for the GC.
 *
 * The ordering is load-bearing, twice, and mirrors `teams/stop.ts`:
 *
 *  1. CLAIM the finalize first. The abort makes OpenCode end the turn, which
 *     relays back as `relayTurnEnd(status: 'error')` and claims the same row —
 *     without the claim, a deliberate stop is repainted "Run failed" by the
 *     failure it caused.
 *  2. Abort the runtime BEFORE settling the message. A message that says
 *     "stopped" over a turn that is still running is the worse lie.
 */
export async function stopSlackTurn(input: {
  sessionId: string;
  slackUserId: string;
  byName?: string;
}): Promise<SlackStopOutcome> {
  const handle = await loadTurn(input.sessionId);
  if (!handle || handle.finalized) {
    return { stopped: false, notice: 'That run has already finished.' };
  }
  if (!(await mayStopSlackTurn(handle, input.slackUserId))) {
    return {
      stopped: false,
      notice: 'Only the person who sent this message, or someone already working in this session, can stop it.',
    };
  }
  if (!(await claimFinalize(input.sessionId))) {
    return { stopped: false, notice: 'That run has already finished.' };
  }

  let stoppedRuntime = false;
  try {
    // Lazily imported so the channel modules keep no static edge into the
    // session-lifecycle engine — the rule turn.ts already follows for the GC.
    const { abortRuntimeTurn } = await import('../../projects/session-lifecycle/abort-runtime-turn');
    stoppedRuntime = await abortRuntimeTurn(input.sessionId, { requestedStop: true });
  } catch (err) {
    console.warn('[slack-webhook] runtime abort failed on stop', {
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
