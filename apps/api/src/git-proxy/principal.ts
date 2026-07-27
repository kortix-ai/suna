/**
 * Who is pushing — the git proxy's principal model.
 *
 * PURE — no DB/network imports (same discipline as `parse.ts`), so every token
 * shape can be pinned by unit tests.
 *
 * The proxy is deliberately NOT wrapped in `combinedAuth` (git sends
 * Basic/Bearer through a credential helper), so none of the auth middleware's
 * context exists here. `authorizeGitProxy` is the only thing that knows which
 * validator accepted the credential, and it now hands the answer forward as a
 * discriminated `GitPrincipal`.
 */

export type GitPrincipal =
  /** Sandbox runtime token (`type: 'sandbox'`). Only a sandbox ever holds one. */
  | { kind: 'sandbox'; sandboxId: string; accountId: string }
  /** Session-bound PAT: the executor token injected into a sandbox as
   *  KORTIX_CLI_TOKEN. This is what the in-sandbox `kortix` CLI and any
   *  `git push` the agent runs authenticate with. */
  | {
      kind: 'session';
      accountId: string;
      sessionId: string | null;
      tokenId?: string;
      userId?: string;
    }
  /** A human's PAT — laptop CLI, possibly project-scoped. */
  | { kind: 'user'; accountId: string; userId?: string; tokenId?: string }
  /** Account-scoped API key (`type: 'user'`). Carries no user identity. */
  | { kind: 'api_key'; accountId: string; keyId?: string };

export type GitPrincipalClass = 'agent' | 'human';

/**
 * Classify a PAT validation result as a session (agent) token or a human's.
 *
 * THE TRAP: `projectId !== null` is NOT an agent signal. Humans mint
 * project-scoped PATs (`POST /v1/projects/:id/tokens` names them
 * `cli · <project name>`), and those have sessionId/agentGrant/serviceAccountId
 * all null. Classifying on projectId would deny a human's laptop push.
 *
 * `sessionId` alone is sufficient today — `mintExecutorToken` is the only
 * minter of session PATs and always sets it. `agentGrant` and
 * `serviceAccountId` are belt-and-braces: each is independently fail-safe-to-
 * null if its resolution hiccups at mint time, and a future minter might set
 * only one of them.
 */
export function isAgentAccountToken(result: {
  sessionId?: string | null;
  agentGrant?: unknown;
  serviceAccountId?: string | null;
}): boolean {
  return Boolean(result.sessionId) || Boolean(result.agentGrant) || Boolean(result.serviceAccountId);
}

/**
 * Map a principal to the class the ref-level control keys on.
 *
 * An exhaustive switch over the discriminant: adding a token kind without
 * classifying it is a COMPILE ERROR, not a silent allow. The unreachable
 * runtime default returns 'agent' and logs — a token kind nobody classified is
 * far more likely a machine than a person at a keyboard, and every human path
 * is exhaustively enumerable today.
 *
 * DELIBERATE RESIDUAL: account API keys are 'human' in v1. They carry no user
 * identity at all, so they are indistinguishable from legitimate CI that pushes
 * the default branch, and no sandbox is ever issued one. Reclassifying them is
 * its own change with its own blast-radius review.
 */
export function classifyGitPrincipal(principal: GitPrincipal): GitPrincipalClass {
  switch (principal.kind) {
    case 'sandbox':
      return 'agent';
    case 'session':
      return 'agent';
    case 'user':
      return 'human';
    case 'api_key':
      return 'human';
    default: {
      const exhaustive: never = principal;
      console.error(
        '[git-proxy] unclassified git principal kind — defaulting to agent',
        (exhaustive as { kind?: string })?.kind,
      );
      return 'agent';
    }
  }
}

/**
 * The protected ref set: the UNION of both `default_branch` columns.
 *
 * There are two — `projects.default_branch` and
 * `project_git_connections.default_branch`. They are written together at
 * registration, but `PATCH /v1/projects/:id` updates ONLY the `projects`
 * column and leaves the connection row stale. Checking one leaves the other as
 * a bypass. The union over-denies (an agent also cannot push the FORMER default
 * branch) — the correct direction to err.
 *
 * Exact byte comparison: no globbing, no case folding. Git ref names are
 * case-sensitive, and a glob here would be a way to over-deny by accident.
 */
export function protectedRefsFor(input: {
  projectDefaultBranch?: string | null;
  connectionDefaultBranch?: string | null;
}): string[] {
  const refs = new Set<string>();
  for (const branch of [input.projectDefaultBranch, input.connectionDefaultBranch]) {
    const trimmed = typeof branch === 'string' ? branch.trim() : '';
    if (!trimmed) continue;
    // Callers pass a branch NAME; the wire carries a fully-qualified ref.
    refs.add(trimmed.startsWith('refs/') ? trimmed : `refs/heads/${trimmed}`);
  }
  return [...refs];
}
