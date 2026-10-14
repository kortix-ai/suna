import type { Credential } from '../../iam/actor';

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
 * A human is a Supabase session — or the person's OWN CLI Personal Access
 * Token (`callerCredentialKind: 'pat'`). That token row carries a real user,
 * binds to no session and stands behind no service account: the same person
 * their browser session is, so the same manager-or-launcher rule governs
 * `kortix sessions approvals … approve` (KRTX-1921). What stays refused:
 * session-bound credentials (an agent connector token — self-approval),
 * service-account bearers, sandbox API keys and OAuth clients — every
 * credential that is not one person's own identity. A PAT whose token row
 * names a service account classifies as `agent_session` and is refused here.
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
  /** The caller's resolved IAM credential kind (Actor.credential.kind) —
   *  'pat' when the request carried a personal token with no service account
   *  behind it. Null when no actor was resolved. */
  callerCredentialKind: Credential['kind'] | null;
  /** The caller's OWN session when its credential is bound to one (a sandbox
   *  token). Non-null means an automated caller. */
  callerSessionId: string | null;
}): { allowed: true } | { allowed: false; reason: ApprovalRefusal } {
  if (input.callerAuthType !== 'supabase' && input.callerCredentialKind !== 'pat') {
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

  return humanMayResolveApproval(input);
}

/** The caller half of `mayResolveApproval`'s input. Every surface that shows or
 *  takes a decision reads it from the request through `approvalCallerOf`
 *  (`http-approval-caller.ts`), so `can_resolve`, the resolve route's 403 and
 *  the approval page's 403 come from the same facts. */
export type ApprovalCaller = Omit<
  Parameters<typeof mayResolveApproval>[0],
  'targetSessionOrigin' | 'targetSessionCreatedBy'
>;

/**
 * The rule for a caller already known to be a human (a Supabase session, a
 * personal CLI PAT, or a chat identity a person linked by signing in): a
 * project manager, or the person who launched the session.
 */
export function humanMayResolveApproval(input: {
  isManager: boolean;
  targetSessionOrigin: string | null;
  targetSessionCreatedBy: string | null;
  callerUserId: string;
}): { allowed: true } | { allowed: false; reason: 'not_launcher_or_manager' } {
  // A manager is a human with project authority; that stands.
  if (input.isManager) return { allowed: true };

  const isLauncher =
    approvalResolvers(input) === 'managers_and_launcher' &&
    input.targetSessionCreatedBy === input.callerUserId;

  return isLauncher ? { allowed: true } : { allowed: false, reason: 'not_launcher_or_manager' };
}

/** Who may decide a call on this session, as a class. Clients name it to a
 *  viewer who may not decide (`resolvers`, KRTX-1724). */
export type ApprovalResolvers = 'managers' | 'managers_and_launcher';

/**
 * The launcher half of the rule applies only to a session one person started.
 * `created_by` of a backend-created session (`origin: 'backend'`: a CLI PAT, a
 * service account, a user API key) is the wrapper, shared by every end-user,
 * so it cannot confer launcher status: only managers decide there.
 */
export function approvalResolvers(target: {
  targetSessionOrigin: string | null;
  targetSessionCreatedBy: string | null;
}): ApprovalResolvers {
  return target.targetSessionOrigin !== 'backend' && target.targetSessionCreatedBy !== null
    ? 'managers_and_launcher'
    : 'managers';
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
