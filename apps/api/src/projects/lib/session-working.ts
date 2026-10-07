/**
 * Is a session working? Decided ONCE, here, for every client (R5.2).
 *
 * Before this, every client combined six signals with six age limits
 * (`@kortix/sdk` `core/session/working.ts`): the `/turn` poll, the inbox poll,
 * runtime status frames, runtime activity, its own send receipt and its own
 * stop receipt. Two tabs could disagree, and each answer was only as fresh as
 * the slowest poll. The server holds the facts those signals approximated:
 *
 *  1. A live turn (the lifecycle authority, `activeTurns`) is working, unless
 *     the runtime reported that turn ended (`kortix.turn` on the daemon
 *     stream, after the turn started). The ledger closes ~1.7 s after the
 *     runtime idles (the relay POST); the runtime's own frame ends it at once.
 *  2. With no live turn, a prompt on its way to the runtime (queued,
 *     delivering, or waiting on anything but a person) is working with
 *     `pending_delivery`: the composer must not offer Send for it.
 *  3. Otherwise idle, dated by the last ended turn.
 *
 * Pure. The control reconciler calls it with what it just read.
 */
import type { SessionTurnStatus, SessionWorking } from '@kortix/api-contract';

interface WorkingPrompt {
  state: string;
  reason: string | null;
  client_sent_at_ms?: number | null;
}

function isLivePrompt(prompt: WorkingPrompt): boolean {
  if (prompt.state === 'queued' || prompt.state === 'delivering') return true;
  return prompt.state === 'waiting' && prompt.reason !== 'held';
}

export function deriveSessionWorking(
  turn: Pick<SessionTurnStatus, 'turns' | 'last_ended'>,
  prompts: readonly WorkingPrompt[],
  /** Newest `kortix.turn` end per runtime session id, epoch ms. */
  runtimeTurnEnds: ReadonlyMap<string, number>,
): SessionWorking {
  let newestEnd: number | null = null;
  const live = turn.turns.filter((candidate) => {
    const endedAt = candidate.runtime_session_id
      ? runtimeTurnEnds.get(candidate.runtime_session_id)
      : undefined;
    const startedAt = candidate.started_at ? Date.parse(candidate.started_at) : Number.NaN;
    const ended = endedAt !== undefined && Number.isFinite(startedAt) && endedAt >= startedAt;
    if (ended && (newestEnd === null || endedAt! > newestEnd)) newestEnd = endedAt!;
    return !ended;
  });
  if (live.length > 0) {
    // `turns` is newest first (`readSessionTurnState`).
    const newest = live[0]!;
    return { state: 'working', since: newest.started_at, turn_token: newest.turn_token, pending_delivery: false };
  }
  const pending = prompts.filter(isLivePrompt);
  if (pending.length > 0) {
    const sent = pending
      .map((prompt) => prompt.client_sent_at_ms)
      .filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
    return {
      state: 'working',
      since: sent.length > 0 ? new Date(Math.min(...sent)).toISOString() : null,
      turn_token: null,
      pending_delivery: true,
    };
  }
  const lastEnded = turn.last_ended?.ended_at ? Date.parse(turn.last_ended.ended_at) : null;
  const since = Math.max(lastEnded ?? Number.NEGATIVE_INFINITY, newestEnd ?? Number.NEGATIVE_INFINITY);
  return {
    state: 'idle',
    since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    turn_token: null,
    pending_delivery: false,
  };
}
