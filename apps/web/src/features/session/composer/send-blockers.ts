/**
 * What still refuses a submission once the server owns prompt ordering.
 *
 * The composer used to consult an eleven-field `QueueDrainGates` before every
 * send — `isServerBusy`, `pendingSendInFlight`, `isOptimisticCompacting`,
 * `hasIncompleteAssistant`, `hasPendingApproval`, `isPaused`, `runtimeReady`,
 * and the rest. Every one of those was a browser tab guessing at a session's
 * state, two tabs guessed differently, and the guess decided whether a message
 * went out or sat in localStorage. They are gone: a prompt is POSTed to the
 * session's durable inbox and the control plane's admission gate — reading the
 * same turn authority `GET .../turn` serves from — decides when it runs.
 *
 * What survives for a PROMPT is only what the server cannot know, and there are
 * three of them. They are refusals, not a queue: nothing is held, the draft
 * stays in the editor, and the user is told why.
 *
 *   - `active_question` — a structured question is on screen. That text would
 *     answer the wrong prompt.
 *   - `pending_permission` — a connector action or permission is waiting on the
 *     user. Sending past it bypasses the gate.
 *   - `read_only` — a viewer with no send rights (the sub-session modal).
 *
 * A `/` COMMAND adds two more (`commandBlocker` below), both for the same
 * reason: it is not an inbox row, so there is nowhere for it to wait.
 *
 * Two gates from the old set are deliberately NOT here:
 *
 *   - `revertStaged`. It blocked the auto-drain from firing into a trajectory
 *     the user had asked to discard. There is no auto-drain, and a staged
 *     revert is precisely the state in which the user types their REPLACEMENT
 *     prompt — refusing it would make edit-and-resend impossible. The
 *     replacement prompt IS what commits the revert: OpenCode truncates on the
 *     next delivery, from any producer. The server's own guard
 *     (`queuedContinueHasStagedRevert`,
 *     `apps/api/src/projects/session-lifecycle/engine.ts`) lets a prompt that
 *     never waited commit the revert for that reason, and refuses the rows that
 *     queued BEFORE it — for every client, which a gate in this tab could never
 *     do.
 *   - `isServerBusy`, for a PROMPT. That is the inbox's decision now.
 *   - `runtimeReady`, for a PROMPT. A prompt typed at a sleeping box becomes an
 *     inbox row and is delivered when the box answers. A COMMAND cannot: see
 *     `commandBlocker`.
 */

export type SendBlocker =
  | 'active_question'
  | 'pending_permission'
  | 'read_only'
  | 'session_working'
  | 'runtime_waking';

export interface SendBlockerInput {
  /** A structured question is on screen for this session. */
  hasActiveQuestion: boolean;
  /**
   * Connector actions and permissions awaiting the user.
   *
   * A count rather than a boolean because that is the quantity the session
   * actually holds; a caller that only has "something is pending" passes 1.
   */
  pendingPermissionCount: number;
  /** This surface cannot send at all (the read-only sub-session modal). */
  readOnly: boolean;
}

/**
 * The first reason this submission cannot go out, or `null`.
 *
 * Ordered by how total the refusal is: a read-only viewer can do nothing about
 * a question or a permission, so naming either of those first would send the
 * user after a fix that is not theirs to make.
 */
export function sendBlocker(input: SendBlockerInput): SendBlocker | null {
  if (input.readOnly) return 'read_only';
  if (input.hasActiveQuestion) return 'active_question';
  if (input.pendingPermissionCount > 0) return 'pending_permission';
  return null;
}

/**
 * The same, for a `/` COMMAND — which has two refusals a prompt does not.
 *
 * A command is dispatched through `runCommand` (a server-expanded template),
 * never through `POST .../prompts`, so no admission gate ever sees it. Both
 * extra refusals follow from that one fact: a prompt has a durable row to wait
 * in, and a command has nowhere to wait at all.
 *
 *   - `session_working` — sent mid-turn the command goes straight onto the wire
 *     ahead of everything the inbox is holding, and a new prompt aborts the turn
 *     in progress (the "Interrupted" symptom).
 *   - `runtime_waking` — the sandbox is stopped or still booting.
 *     `useSession`'s `runCommand` returns a RESOLVED promise when the runtime is
 *     not switched yet: no request, no error, nothing queued. The composer read
 *     that as a successful dispatch, cleared the draft, and left an optimistic
 *     command bubble waiting on a turn that never starts. A PROMPT typed in the
 *     same state is fine — it becomes an inbox row and the drain delivers it
 *     when the box answers, which is what the composer's "Waking this session
 *     up…" notice promises.
 *
 * Until a command is an inbox row too, the honest answer is to refuse it and
 * say when it can run, rather than to hold it in a second, tab-local queue that
 * a closed tab loses.
 */
export function commandBlocker(
  input: SendBlockerInput & { isWorking: boolean; runtimeReady: boolean },
): SendBlocker | null {
  const shared = sendBlocker(input);
  if (shared) return shared;
  // Before `session_working`: nothing is running on a box that is not up, so
  // naming the turn would send the user to wait for something that is not
  // happening.
  if (!input.runtimeReady) return 'runtime_waking';
  return input.isWorking ? 'session_working' : null;
}

/** User-facing copy. One place, so no call site invents its own wording. */
export function sendBlockerMessage(blocker: SendBlocker): {
  message: string;
  description?: string;
} {
  switch (blocker) {
    case 'read_only':
      return { message: 'This session is read-only.' };
    case 'active_question':
      return {
        message: 'Answer the question above to continue.',
        description: 'Sending now would answer it with this text instead.',
      };
    case 'pending_permission':
      return { message: 'Approve or deny the pending action to continue.' };
    case 'session_working':
      return {
        message: 'Wait for the agent to finish before running a command.',
        description: 'A command starts its own turn, so it would interrupt this turn.',
      };
    case 'runtime_waking':
      return {
        message: 'This session is still waking up.',
        description: 'A command needs the sandbox running — send it again in a moment.',
      };
  }
}
