/**
 * The rule for stopping a running turn, decidable without I/O, and the 403
 * every refused stop answers with. The reads that feed the rule live in
 * `projects/session-lifecycle/turn-stop-authority.ts`. This file sits outside
 * `projects/` and imports nothing, so the sandbox proxy and the session stream
 * use it without loading the authority's module graph.
 */
export const NOT_TURN_PROMPTER = 'not_turn_prompter';
export const NOT_TURN_PROMPTER_MESSAGE =
  'Only the member who started this run, the session owner or a project manager can stop it.';

export type TurnStopVerdict =
  | { allowed: true }
  | { allowed: false; prompterUserId: string | null };

/** The person who prompted the run, the session owner or a project manager. Nothing running: allowed. */
export function decideTurnStop(input: {
  /** Owner or manager standing on the session (`canManageLifecycle`). */
  canManageLifecycle: boolean;
  /** The human caller; null for an agent credential, which never counts as a prompter. */
  callerUserId: string | null;
  running: boolean;
  prompterUserId: string | null;
}): TurnStopVerdict {
  if (input.canManageLifecycle || !input.running) return { allowed: true };
  if (input.callerUserId && input.prompterUserId === input.callerUserId) return { allowed: true };
  return { allowed: false, prompterUserId: input.prompterUserId };
}
