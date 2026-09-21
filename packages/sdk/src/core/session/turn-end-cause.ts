import { isAbortError } from '../http/abort-error';
import { TURN_END_SETTLE_MS } from './turn-end-settle';
import type {
  SessionTurnEndError,
  SessionTurnEnded,
  SessionTurnFailure,
} from '../rest/projects-client/sessions';

/** The parts of a `/turn` read that can say why a turn ended. */
export interface SessionTurnOutcome {
  last_ended?: SessionTurnEnded;
  recent_failures?: SessionTurnFailure[];
  /** When the control plane took this reading, in epoch ms. */
  atMs?: number;
}

/**
 * The cause the control plane recorded for the turn that answered `messageId`,
 * or `null` when there is none worth showing.
 *
 * The transcript of an interrupted turn only says `MessageAbortedError`. An
 * abort is the effect of whatever stopped the turn; when the sandbox named that
 * cause (a memory guard, say), the control plane carries it. `recent_failures`
 * is searched first: `last_ended` is one row and vanishes the moment the next
 * turn starts. A recorded abort is a plain Stop and has no cause to show.
 */
export function turnEndCause(
  outcome: SessionTurnOutcome | undefined,
  messageId: string | null | undefined,
): SessionTurnEndError | null {
  if (!outcome || !messageId) return null;
  const listed = outcome.recent_failures?.find((failure) => failure.message_id === messageId);
  const lastEnded = outcome.last_ended;
  const error =
    listed?.error ??
    (lastEnded?.message_id === messageId && lastEnded.end_reason === 'failed'
      ? lastEnded.error
      : undefined);
  if (!error?.message) return null;
  if (isAbortError({ name: error.name ?? undefined, message: error.message })) return null;
  return error;
}

/** The sandbox daemon's memory guard: it stops the turn before the kernel would. */
const SANDBOX_MEMORY_GUARD = 'SandboxMemoryGuard';

/**
 * What to tell the user under a turn that ended badly. Typed, so a host maps a
 * `kind` to its own copy and never parses the sandbox's message.
 */
export type TurnEndNotice =
  /** The sandbox ran out of memory. `usedPct` and `detail` are for the copy and
   *  for support; both are `null` when the message did not carry them. */
  | { kind: 'sandbox-memory'; usedPct: number | null; detail: string | null }
  /** Some other cause the sandbox named. `message` is its own wording. */
  | { kind: 'cause'; name: string | null; message: string }
  /** The turn died and nobody named why. */
  | { kind: 'unexplained' };

/**
 * The notice for the turn that answered `messageId`, or `null` for nothing.
 *
 * `null` when the transcript carries a real error of its own — that one is more
 * specific — and for every turn `recent_failures` does not list: a completed
 * turn, a running one, and a stop somebody ASKED for (the control plane records
 * the request, so a Stop never reads as a failure, also after a reload).
 */
export function turnEndNotice(
  outcome: SessionTurnOutcome | undefined,
  messageId: string | null | undefined,
  transcript: { hasError: boolean; isAbort: boolean },
): TurnEndNotice | null {
  if (!outcome || !messageId) return null;
  if (transcript.hasError && !transcript.isAbort) return null;

  const cause = turnEndCause(outcome, messageId);
  if (cause?.message) {
    if (cause.name !== SANDBOX_MEMORY_GUARD) {
      return { kind: 'cause', name: cause.name, message: cause.message };
    }
    const pct = cause.message.match(/(\d{1,3})%/)?.[1];
    // Everything after the first ':' is the daemon's rationale, not detail.
    const detail = cause.message.split(':')[0]?.trim() || null;
    return { kind: 'sandbox-memory', usedPct: pct ? Number(pct) : null, detail };
  }

  const listed = outcome.recent_failures?.find((failure) => failure.message_id === messageId);
  if (!listed) return null;
  const endedMs = listed.ended_at ? Date.parse(listed.ended_at) : Number.NaN;
  const provisional =
    Number.isFinite(endedMs) &&
    typeof outcome.atMs === 'number' &&
    outcome.atMs - endedMs < TURN_END_SETTLE_MS;
  return provisional ? null : { kind: 'unexplained' };
}
