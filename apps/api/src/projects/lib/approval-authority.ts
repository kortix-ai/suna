/**
 * Who may resolve (approve / deny) a gated tool call.
 *
 * This is the THIRD surface with the same root cause: `created_by` was treated
 * as "the person who launched this session". In Kortix-as-a-Backend every
 * session is created by the wrapper's single credential, so `created_by`
 * identifies nobody — and the in-sandbox token carries that exact `userId`.
 *
 * Two distinct failures followed:
 *
 *  1. SELF-APPROVAL. The agent holds its own `execution_id` from the 202
 *     `pending_approval` body, and its token's `userId` equals `created_by`.
 *     It could approve the very call `require_approval` exists to hold — which
 *     makes the gate decorative rather than a control.
 *
 *  2. CROSS-END-USER. Sibling `execution_id`s are reachable, and resolving one
 *     writes a standing grant and injects continuation text into the victim's
 *     session.
 *
 * A SESSION-BOUND caller must never be its own approver. That is the whole
 * point of a human-in-the-loop gate, so it is refused outright rather than
 * narrowed to "its own session".
 *
 * Only a Supabase-authenticated Kortix user can resolve an approval. PATs,
 * API keys, service accounts, and session credentials are automated principals.
 */
export type ApprovalRefusal =
  | 'non_human_caller'
  | 'session_bound_caller'
  | 'not_launcher_or_manager';

export function mayResolveApproval(input: {
  /** True when the caller holds project-manager rights. */
  isManager: boolean;
  /** The session that owns the pending execution. */
  targetSessionOrigin: string | null;
  /** `created_by` of that session. */
  targetSessionCreatedBy: string | null;
  /** The acting user. */
  callerUserId: string;
  /** Authentication mechanism for the current request. */
  callerAuthType: string | null;
  /** The caller's OWN session when its credential is bound to one (a sandbox
   *  token). Non-null means an automated caller. */
  callerSessionId: string | null;
}): { allowed: true } | { allowed: false; reason: ApprovalRefusal } {
  if (input.callerAuthType !== 'supabase') {
    return { allowed: false, reason: 'non_human_caller' };
  }
  // ORDER MATTERS. The session-bound check runs FIRST, before the manager
  // branch, because an agent's token inherits the role of the user who minted
  // it — and in Kortix-as-a-Backend that is the wrapper's own account, which is
  // very often a project owner. Checking `isManager` first would hand the agent
  // exactly the authority this refusal exists to withhold.
  //
  // No session-bound caller approves anything, whatever role its token carries.
  if (input.callerSessionId !== null) {
    return { allowed: false, reason: 'session_bound_caller' };
  }

  // A manager is a human with project authority; that stands.
  if (input.isManager) return { allowed: true };

  // `created_by` only means "the launcher" for a session a single person
  // actually started. For a wrapper-created session it is the wrapper, shared
  // by every end-user, so it cannot confer launcher status.
  const createdByIsMeaningful = input.targetSessionOrigin !== 'backend';
  const isLauncher =
    createdByIsMeaningful &&
    input.targetSessionCreatedBy !== null &&
    input.targetSessionCreatedBy === input.callerUserId;

  return isLauncher ? { allowed: true } : { allowed: false, reason: 'not_launcher_or_manager' };
}

/**
 * May this caller SEE a session's pending approvals?
 *
 * The counterpart to mayResolveApproval, and the leak that feeds it: the count
 * endpoint filtered on `createdBy === callerUserId`, which is true for every
 * KaaB session, so one end-user's sandbox could enumerate every other's pending
 * gates — and an execution_id is all the resolve route needs.
 *
 * A session-bound caller may see ONLY its own session. Unlike resolving, this is
 * a narrowing rather than a refusal: an agent legitimately needs to know its own
 * call is waiting.
 */
export function maySeeSessionApprovals(input: {
  isManager: boolean;
  targetSessionId: string;
  targetSessionOrigin: string | null;
  targetSessionCreatedBy: string | null;
  callerUserId: string;
  callerSessionId: string | null;
}): boolean {
  if (input.callerSessionId !== null) return input.callerSessionId === input.targetSessionId;
  if (input.isManager) return true;
  if (input.targetSessionOrigin === 'backend') return false;
  return input.targetSessionCreatedBy === input.callerUserId;
}
