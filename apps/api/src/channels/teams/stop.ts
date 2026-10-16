import { config } from '../../config';
import { chatUser } from '../core/identity';
import { CHAT_TURN_STOP_REFUSED, type ChatTurnStopVerdict, chatTurnStopVerdict } from '../core/turn-stop';
import { claimFinalize, deleteTurn, finalizeTurn, loadTurn } from './turn';
import type { TeamsLiveTurn } from './types';

/**
 * Who may press Stop on a live turn: the sender of the message it answers,
 * the session owner, a project manager, or the linked user who prompted the
 * running turn from another surface (`chatTurnStopVerdict`). An approved
 * participant who is none of these is refused, under `project_open` and
 * `owner_approval` alike. A lookup that fails refuses too.
 */
async function mayStopTeamsTurn(handle: TeamsLiveTurn, teamsUserId: string): Promise<ChatTurnStopVerdict> {
  // Callers pass `teamsUserId(activity)`: the AAD object id when Teams sends
  // one, which it does for every signed-in user. Comparing that with the
  // sender's Bot Framework id (`29:…`) alone never matched, so the person who
  // sent the message could not stop it.
  const origin = handle.originatingActivity?.from;
  const sentIt = Boolean(teamsUserId && origin && (origin.aadObjectId === teamsUserId || origin.id === teamsUserId));
  try {
    return await chatTurnStopVerdict({
      user: chatUser('teams', handle.tenantId, teamsUserId),
      projectId: handle.projectId,
      sessionId: handle.sessionId,
      sentIt,
      // Without linked identities the conversation runs as the installer, and
      // only the sender is known.
      requireIdentity: config.TEAMS_REQUIRE_USER_IDENTITY,
    });
  } catch (err) {
    console.warn('[teams-webhook] stop authorization failed (refusing)', err);
    return { allowed: false };
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
  const verdict = await mayStopTeamsTurn(handle, input.teamsUserId);
  if (!verdict.allowed) return { stopped: false, notice: CHAT_TURN_STOP_REFUSED };

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
    stoppedRuntime = await abortRuntimeTurn(input.sessionId, { requestedStop: true, stoppedBy: verdict.userId });
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
