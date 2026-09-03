/**
 * Which refs may a given principal move? — the git proxy's ref-level authority.
 *
 * Until this module existed, git authorization was one boolean for the whole
 * repository: `git-receive-pack` ⇒ "write", and the request body streamed to the
 * upstream unread. Any token that could push at all could push anything — a
 * session agent could commit straight onto `main`, force-rewind it, or delete
 * another session's branch, and the only thing standing in the way was a
 * sentence in a prompt telling the agent not to. Verified on dev 2026-08-31: a
 * sandbox token force-rewound `main` to its root commit through the proxy.
 *
 * Authority has TWO layers, and the split is the whole design.
 *
 * LAYER 1 — STRUCTURAL. Not expressible as a permission, not grantable by any
 * role, grant, or manifest:
 *
 *   - A session credential addresses exactly ONE branch: its own. That is the
 *     credential's IDENTITY, the same way a sandbox token addresses exactly one
 *     project — nobody would model that as a grantable permission either. It
 *     must also hold on an UNGOVERNED project, where the agent grant is null;
 *     the grant system reads null as "no restriction" (agent-scope.ts), so a
 *     binding expressed as a grant would evaporate on exactly the projects that
 *     never opted into governance.
 *   - The default branch is never deletable, by anyone, including `internal`.
 *     A floor, not a knob.
 *
 * LAYER 2 — GRANTABLE SCOPES. Everything above the binding is an ordinary
 * capability leaf (`GitRefScope`), held through a project role or listed in an
 * agent's `kortix_cli`. A denial names the leaf that would permit it and the
 * CALLER resolves it, so a project that deliberately wants an agent pushing
 * beyond its own branch says so in `kortix.yaml`, reviewed and merged, visible
 * in `kortix grants ls` — instead of it being the silent default it used to be.
 *
 * Defaults per principal, before any scope is consulted:
 *
 *   session  → its own branch. That is the entire git surface a session needs:
 *              the daemon pushes `HEAD:refs/heads/<branch>` and nothing else,
 *              and work reaches any other ref through a change request a human
 *              merges. Widened by `project.gitops.ref.any` / `.ref.delete`.
 *   monitor  → nothing. Monitor boxes clone at default-branch HEAD and never
 *              push; there is no principal behind one to hold a scope.
 *   user     → any ref. A human at a laptop running `kortix ship` on `main` is
 *              a shipped, advertised flow, and they hold the ref scopes through
 *              their project role rather than being re-derived per push.
 *   internal → unconstrained above the floor. Server-side writers
 *              (change-request merge, dashboard config commits) do not traverse
 *              this proxy at all; the variant exists so that "who may move a
 *              ref" has exactly one answer in the codebase rather than four.
 *
 * DELIBERATELY NOT HERE: rejecting a non-fast-forward (force) push. Whether an
 * update is a fast-forward is a question about commit ancestry, and the new
 * commits live in the pack that has not been uploaded yet — the proxy would
 * have to receive and index the pack, i.e. become a git server, to answer it.
 * That check belongs on the upstream, which already has the objects: a GitHub
 * ruleset blocking force-pushes and deletions on the default branch. Such a
 * ruleset does NOT block the change-request merge path, because that path
 * pushes an ordinary fast-forward or merge commit. See the PR description.
 */
import { isDelete, type RefUpdate } from './receive-pack';

/**
 * Who is pushing. Minted by `authorizeGitProxy`, which is the only place that
 * knows which class of credential authenticated the request — before this type
 * existed it collapsed that knowledge into `{ ok: true }` and threw the rest
 * away, which is why no ref rule could be written.
 */
export type GitPrincipal =
  /** A session's sandbox token, or an account token scoped to that session. */
  | { kind: 'session'; sessionId: string; branch: string }
  /** A monitor box's sandbox token — no session row by design. */
  | { kind: 'monitor' }
  /** A human credential: account API key, CLI PAT, dashboard. */
  | { kind: 'user'; userId: string | null }
  /** Server-side Kortix machinery. Never reaches the proxy today. */
  | { kind: 'internal' };

export interface RefPolicyContext {
  /** The project's default branch, e.g. `main`. */
  defaultBranch: string;
}

/** One refused ref update, carrying the reason git will print to the user. */
export interface RefDenial {
  ref: string;
  reason: string;
  /**
   * Every capability leaf that would have to be held for this update, when a
   * set of them exists. Deleting ANOTHER ref needs both `.ref.any` (to touch a
   * ref outside your lane) and `.ref.delete` (to remove one) — a single leaf
   * could not express that, and reading it as "either" would let `.ref.any`
   * alone authorize a deletion.
   *
   * `undefined` means STRUCTURAL: no grant, role, or manifest can allow it.
   * The session -> own-branch binding and the default branch's undeletability
   * are structural on purpose — the first is the credential's identity rather
   * than a permission, and the second is a floor.
   *
   * Resolving these is deliberately the CALLER's job and happens only when a
   * denial exists, so the common paths (a session pushing its own branch, a
   * person pushing anything) pay no authorization round trip at all.
   */
  requires?: GitRefScope[];
}

/** Capability leaves that widen ref authority. Mirrors PROJECT_ACTIONS. */
export type GitRefScope = 'project.gitops.ref.any' | 'project.gitops.ref.delete';

const HEADS_PREFIX = 'refs/heads/';

/**
 * Evaluate every ref update in one push. Returns a denial per refused ref;
 * an empty array means the whole push is allowed.
 *
 * A push is all-or-nothing at the call site: if ANY ref is denied the proxy
 * refuses the request outright rather than forwarding a subset, because the
 * pack is a single stream and splitting it is not possible.
 */
export function evaluateRefUpdates(
  principal: GitPrincipal,
  ctx: RefPolicyContext,
  updates: RefUpdate[],
): RefDenial[] {
  const denials: RefDenial[] = [];
  for (const update of updates) {
    const denial = denyFor(principal, ctx, update);
    if (denial) denials.push({ ref: update.ref, ...denial });
  }
  return denials;
}

type DenialBody = { reason: string; requires?: GitRefScope[] };

function denyFor(
  principal: GitPrincipal,
  ctx: RefPolicyContext,
  update: RefUpdate,
): DenialBody | null {
  // STRUCTURAL FLOOR, checked before anything a scope can widen: the default
  // branch is never deletable, by anyone. `project.gitops.ref.delete` widens
  // deletion of ordinary refs, never this one.
  if (isDelete(update) && update.ref === `${HEADS_PREFIX}${ctx.defaultBranch}`) {
    return { reason: `${ctx.defaultBranch} is the default branch and cannot be deleted` };
  }

  switch (principal.kind) {
    case 'internal':
      return null;

    case 'monitor':
      // A monitor box has no session and no user behind it; there is no
      // principal to hold a scope, so this is structural too.
      return { reason: 'monitor sandboxes have read-only repository access' };

    case 'session': {
      const own = `${HEADS_PREFIX}${principal.branch}`;
      const outsideLane = update.ref !== own;
      const requires: GitRefScope[] = [];
      if (outsideLane) requires.push('project.gitops.ref.any');
      if (isDelete(update)) requires.push('project.gitops.ref.delete');
      if (requires.length === 0) return null;
      return {
        reason: outsideLane
          ? `a session may only push its own branch (${principal.branch}); ` +
            'commit there and open a change request to land this elsewhere'
          : // The session branch is the head of any change request opened from
            // this session; deleting it strands the CR with an unresolvable head.
            'a session may not delete its own branch',
        requires,
      };
    }

    case 'user':
      // Deletion is stated as a requirement for every principal so the policy
      // asks one question rather than branching on who is asking. A person
      // holds both leaves through their project role (see ref-scopes.ts), so
      // this is behaviour-neutral today — and the day we want to narrow a
      // human role, the question is already being asked here.
      if (isDelete(update)) {
        return {
          reason: `deleting ${update.ref} requires git ref-delete authority`,
          requires: ['project.gitops.ref.delete'],
        };
      }
      return null;
  }
}

/**
 * Short, stable label for logs and audit rows. Never includes the branch name,
 * which can carry user content.
 */
export function principalLabel(principal: GitPrincipal): string {
  switch (principal.kind) {
    case 'session':
      return `session:${principal.sessionId}`;
    case 'monitor':
      return 'monitor';
    case 'user':
      return principal.userId ? `user:${principal.userId}` : 'user';
    case 'internal':
      return 'internal';
  }
}
