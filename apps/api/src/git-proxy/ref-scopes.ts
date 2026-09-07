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
import { actorForToken } from '../iam/actor';
import { authorize } from '../iam/authorize';
import { deriveRequestContext } from '../iam/cache';
import type { GitPrincipal, GitRefScope } from './ref-policy';

/**
 * True when the principal holds `scope`.
 *
 * A SESSION reads its agent grant; a PERSON is asked of the IAM engine, the
 * same way every other project route asks. `project.gitops.push` authorizes
 * *a* push, not every destructive shape of one: deleting a ref is not
 * recoverable from the client that issued it, and a branch is frequently
 * someone else's — another session's head, a colleague's feature branch. The
 * migration seeds `.ref.delete` into `manager`, so a manager is unaffected and
 * a plain member with push rights can no longer delete a branch.
 *
 * `internal` is server-side machinery, gated at its own routes.
 */
export async function principalHoldsRefScope(
  c: Context,
  principal: GitPrincipal,
  project: { projectId: string; accountId: string },
  scope: GitRefScope,
): Promise<boolean> {
  switch (principal.kind) {
    case 'internal':
      return true;
    case 'monitor':
      // No principal behind a monitor box to hold anything.
      return false;
    case 'user': {
      // An account-scoped API key carries NO user identity, so there is no
      // principal to evaluate a role against — the same reasoning
      // `authorizeGitProxy` applies when it lets account ownership stand alone.
      // Ownership was already proven to get here.
      if (!principal.userId) return true;
      const verdict = await authorize(
        await actorForToken(principal.userId, project.accountId, principal.tokenId, {
          ctx: deriveRequestContext(c),
        }),
        scope,
        { type: 'project', id: project.projectId },
      );
      return verdict.allowed;
    }
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
export async function denialsAfterScopes<T extends { requires?: GitRefScope[] }>(
  c: Context,
  principal: GitPrincipal,
  project: { projectId: string; accountId: string },
  denials: T[],
): Promise<T[]> {
  const standing: T[] = [];
  for (const denial of denials) {
    if (!denial.requires || denial.requires.length === 0) {
      standing.push(denial); // structural
      continue;
    }
    // EVERY named leaf must be held. Deleting another ref names both `.ref.any`
    // and `.ref.delete`; holding only one must not authorize it. Sequential, not
    // Promise.all: the common case is one leaf, and a denied first leaf should
    // not pay for a second authorization round trip.
    let holdsAll = true;
    for (const scope of denial.requires) {
      if (!(await principalHoldsRefScope(c, principal, project, scope))) {
        holdsAll = false;
        break;
      }
    }
    if (!holdsAll) standing.push(denial);
  }
  return standing;
}
