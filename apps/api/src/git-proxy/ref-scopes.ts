/**
 * Resolving the git ref scopes a principal actually holds.
 *
 * Split from `ref-policy.ts` (which stays pure) because answering "does this
 * principal hold `project.gitops.ref.any`?" needs the IAM engine and the agent
 * grant, i.e. database reads.
 *
 * LAZY BY CONSTRUCTION. This is called only when the pure policy has already
 * produced a denial, so the paths that matter pay nothing:
 *
 *   - a session pushing its own branch  → no denial, no call, no query
 *   - a person pushing anything         → no denial, no call, no query
 *   - a session pushing `main`          → one authorization check, almost
 *                                         always another denial
 *
 * The alternative — resolving a full scope set up front on every push — would
 * put a cross-region round trip on the hot path of every clone and fetch, which
 * is exactly what the 30 s authorization memo above it exists to avoid.
 *
 * DEFAULT-DENY, unlike the rest of the agent-grant fold. `agentMayPerform(null,
 * …)` returns TRUE — a null grant means "no restriction" — and null is what
 * every project that never adopted `agents:` in its manifest has. Reading these
 * leaves through that helper would hand unrestricted ref authority to exactly
 * the ungoverned projects this whole change exists to protect. So a session
 * principal must find the leaf EXPLICITLY listed in its grant; absent is denied.
 */
import type { Context } from 'hono';

import { getAgentGrant } from '../iam/agent-scope';
import type { GitPrincipal, GitRefScope } from './ref-policy';

/**
 * True when the principal holds `scope`.
 *
 * `user` and `internal` principals hold both by construction: a person's ref
 * authority comes from their project role, which the proxy already checked when
 * it authorized the push, and server-side machinery is gated at its own routes.
 * Only a session principal is narrowed here.
 */
export function principalHoldsRefScope(
  c: Context,
  principal: GitPrincipal,
  scope: GitRefScope,
): boolean {
  switch (principal.kind) {
    case 'user':
    case 'internal':
      return true;
    case 'monitor':
      // No principal behind a monitor box to hold anything.
      return false;
    case 'session': {
      const grant = getAgentGrant(c);
      if (!grant) return false; // Default-deny — see the header note.
      if (grant.kortixCli === 'all') return true;
      return grant.kortixCli.includes(scope);
    }
  }
}

/**
 * Filter a denial list down to the ones that stand after scopes are consulted.
 *
 * A denial with no `requires` is structural and always stands. A denial that
 * names scopes stands unless the principal holds EVERY one of them.
 */
export function denialsAfterScopes<T extends { requires?: GitRefScope[] }>(
  c: Context,
  principal: GitPrincipal,
  denials: T[],
): T[] {
  return denials.filter((denial) => {
    if (!denial.requires || denial.requires.length === 0) return true; // structural
    // EVERY named leaf must be held. Deleting another ref names both `.ref.any`
    // and `.ref.delete`; holding only one must not authorize it.
    return !denial.requires.every((scope) => principalHoldsRefScope(c, principal, scope));
  });
}
