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
 * Per-request context surfaced from middleware. V2 uses MFA AAL for the
 * account-wide MFA gate. Optional everywhere — call sites that don't have
 * the data simply omit it.
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
