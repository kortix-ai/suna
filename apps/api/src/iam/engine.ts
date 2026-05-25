// IAM engine — public type surface only.
//
// The V1 policy-based engine implementation (authorize, listAccessibleResources,
// policyMatchesTarget, checkConditions, actionPassesBoundary, system-role
// permission cache) lived in this file until PR5d, when V2 became the only
// authorization path. The file is kept as a type-only module so that
// downstream importers (dispatcher, cache, repositories, route handlers,
// tests) keep working without churn — the actual runtime now lives in
// ./engine-v2 and is reached through ./dispatcher.
//
// AccessibleResources is the wider V1 union (it had an additional
// 'all_except' variant) collapsed to what V2 actually returns.

/**
 * Subject of an authorization check.
 * - `account`: the action targets the account as a whole (e.g. invite a member).
 * - `project`/`sandbox`/etc.: the action targets a specific resource. The
 *   engine resolves whether the caller has access to that target.
 */
export type AuthorizeTarget =
  | { type: 'account'; id?: never }
  | { type: 'project'; id: string }
  | { type: 'sandbox'; id: string }
  | { type: 'trigger'; id: string }
  | { type: 'channel'; id: string }
  | { type: 'member'; id: string }
  | { type: 'group'; id: string };

export type AuthorizeResult = {
  allowed: boolean;
  /** Free-text "why was this denied" — surfaced in HTTPException messages. */
  reason?: string;
};

/**
 * Per-request context surfaced from middleware: caller IP, MFA AAL.
 * Reserved fields for future role-condition evaluation (e.g. require_mfa
 * on a project_members row). Optional everywhere — call sites that
 * don't have the data simply omit it.
 */
export interface RequestContext {
  /** Caller's source IP, taken from x-forwarded-for or x-real-ip. */
  ip?: string;
  /** JWT's aal claim — 'aal1' = password-only, 'aal2' = MFA-verified. */
  mfaAal?: string;
}

/**
 * The result of asking "which resources of type T can the caller perform
 * `action` on". V2 emits one of three shapes:
 *   - `all`: super-admin or account owner/admin — every resource passes.
 *   - `allow_only`: explicit set of IDs. Empty set = no access.
 *   - `none`: caller cannot perform the action on anything.
 */
export type AccessibleResources =
  | { mode: 'all' }
  | { mode: 'none' }
  | { mode: 'allow_only'; allowed: Set<string> };
