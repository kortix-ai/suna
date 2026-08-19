/**
 * Reconcile a live session token's agent grant with the current manifest.
 *
 * `account_tokens.agent_grant` starts from the session's create-time agent.
 * The connector and Kortix-CLI gates (`agentMayUseConnector`,
 * `agentMayPerform`) read that row at call time. The row must therefore follow
 * both in-session agent switches and same-agent manifest edits:
 *
 *     create session with agent A (connectors: [slack])
 *     update A to connectors: [slack, google_workspace]
 *       -> the token still carries the old list unless it is reconciled
 *       -> the existing session receives connector_not_assigned
 *
 * Secrets are replaced through the pre-prompt env sync (see `secret-grant.ts`).
 * Nothing refuses a switch. Connector and CLI grants are checked against this
 * row at CALL time, so rewriting it genuinely re-scopes every subsequent call —
 * which is why the re-mint, not a refusal, is the mechanism that protects them.
 */

import { type AgentGrant, accountTokens, projectSessions, projects } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { agentGrantDiffers, resolveSessionAgentGrant } from './secret-grant';

/** The re-mint could not be written. The caller must FAIL the prompt: letting it
 *  through would run the new agent against the previous agent's grant, which is
 *  the escalation this module exists to close. */
export class SessionGrantRemintError extends Error {
  constructor(
    readonly sessionId: string,
    cause: unknown,
  ) {
    super(
      `could not re-mint the agent grant for session '${sessionId}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'SessionGrantRemintError';
  }
}

/**
 * Rewrite the grant on every LIVE token belonging to this session.
 *
 * Scoped to active, unrevoked rows: a revoked token must stay dead, and
 * rewriting its grant would quietly resurrect a credential the operator killed.
 *
 * Writing `null` is meaningful — it is the UNRESTRICTED grant a project without
 * per-agent governance gets — so the update is unconditional once the caller has
 * decided the grant changed. Returns how many rows were rewritten; zero is not
 * an error (a session whose token already expired has nothing to re-scope, and
 * its next call 401s anyway).
 */
export async function remintSessionAgentGrant(
  sessionId: string,
  grant: AgentGrant | null,
): Promise<number> {
  try {
    const rows = await db
      .update(accountTokens)
      .set({ agentGrant: grant })
      .where(
        and(
          eq(accountTokens.sessionId, sessionId),
          eq(accountTokens.status, 'active'),
          isNull(accountTokens.revokedAt),
        ),
      )
      .returning({ tokenId: accountTokens.tokenId });
    return rows.length;
  } catch (err) {
    throw new SessionGrantRemintError(sessionId, err);
  }
}

export type RemintDecision =
  | { action: 'skip' }
  | { action: 'write'; grant: AgentGrant }
  | { action: 'refuse'; reason: string };

/**
 * Pure policy: what to do with the token's grant when `running` is the agent a
 * prompt will actually execute and `stored` is what the token currently holds.
 *
 * The `refuse` case is the one worth reading. A `null` grant means UNRESTRICTED
 * (see `agent-scope.ts`), and resolution returns `null` both for "this project
 * declares no per-agent governance" and for "the manifest could not be read at
 * all" (no default branch). The first is harmless — a project with no
 * governance minted a `null` grant at boot too, so `stored` is already `null`
 * and this is a `skip`. The second is not: writing `null` over a real grant
 * would hand the switched-to agent every connector and CLI action in the
 * account because we momentarily could not read the file that says otherwise.
 * So a re-mint may re-point or narrow, never blank out.
 */
export function remintDecisionFor(
  stored: AgentGrant | null,
  running: AgentGrant | null,
): RemintDecision {
  if (!agentGrantDiffers(stored, running)) return { action: 'skip' };
  if (running === null) {
    return {
      action: 'refuse',
      reason:
        'the agent this prompt runs resolved to an UNRESTRICTED grant while the session token holds a narrower one — refusing rather than widening the token',
    };
  }
  return { action: 'write', grant: running };
}

async function loadStoredSessionGrant(sessionId: string): Promise<AgentGrant | null> {
  try {
    const [token] = await db
      .select({ agentGrant: accountTokens.agentGrant })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.sessionId, sessionId),
          eq(accountTokens.status, 'active'),
          isNull(accountTokens.revokedAt),
        ),
      )
      .limit(1);
    return token?.agentGrant ?? null;
  } catch (err) {
    throw new SessionGrantRemintError(sessionId, err);
  }
}

async function resolveCurrentGrant(input: {
  projectId: string;
  sessionId: string;
  sessionAgent: string;
  runningAgent: string;
  forceRefresh: boolean;
}): Promise<AgentGrant | null> {
  try {
    const [project] = await db
      .select({
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        manifestPath: projects.manifestPath,
      })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);

    return await resolveSessionAgentGrant({
      projectId: input.projectId,
      repoUrl: project?.repoUrl ?? '',
      defaultBranch: project?.defaultBranch,
      manifestPath: project?.manifestPath,
      sessionAgent: input.sessionAgent,
      requestedAgent: input.runningAgent,
      forceRefresh: input.forceRefresh,
    });
  } catch (err) {
    throw new SessionGrantRemintError(input.sessionId, err);
  }
}

async function applyResolvedGrant(
  sessionId: string,
  stored: AgentGrant | null,
  running: AgentGrant | null,
): Promise<RemintDecision> {
  const decision = remintDecisionFor(stored, running);
  if (decision.action === 'refuse') {
    throw new SessionGrantRemintError(sessionId, new Error(decision.reason));
  }
  if (decision.action === 'write') {
    await remintSessionAgentGrant(sessionId, decision.grant);
  }
  return decision;
}

/**
 * Re-point a session token's grant at the agent a prompt actually runs.
 *
 * Resolve on every prompt. The manifest can change while the session remains
 * active, including through `kortix connectors add --apply`. Comparing only
 * agent names leaves the token frozen at its create-time connector and CLI
 * lists.
 *
 * Throws `SessionGrantRemintError` if the grant cannot be resolved or written;
 * the caller must fail the prompt rather than run the new agent under the old
 * agent's grant.
 *
 * KNOWN LIMIT — concurrent prompts. Two prompts naming different agents on the
 * SAME session race: both resolve, both write, last writer wins, and the loser's
 * agent then runs under the winner's grant for the rest of that turn. The token
 * is one row shared by one box, so this cannot be fixed by locking here — it
 * needs either a per-turn credential or a serialised prompt path. Documented
 * rather than papered over; the single-prompt path (every ordinary session) is
 * correct.
 */
export async function remintGrantForAgentSwitch(input: {
  projectId: string;
  sessionId: string;
  /** `project_sessions.agent_name` — the agent the session was CREATED with. */
  sessionAgent: string;
  /** The agent this prompt asked to run, verbatim from the body. */
  requestedAgent: string | null;
}): Promise<RemintDecision> {
  const requested = input.requestedAgent?.trim();
  // The agent that will ACTUALLY run. `project_sessions.agent_name` is the
  // create-time agent and nothing ever updates it, so it is the fallback, not
  // the reference point.
  const runningAgent =
    requested && requested !== DEFAULT_AGENT_SENTINEL ? requested : input.sessionAgent;

  const stored = await loadStoredSessionGrant(input.sessionId);
  const running = await resolveCurrentGrant({
    ...input,
    runningAgent,
    forceRefresh: true,
  });
  return applyResolvedGrant(input.sessionId, stored, running);
}

/**
 * Resolve the grant represented by an existing session token from the current
 * project manifest.
 *
 * Connector and Kortix CLI requests can occur after the session changes
 * `kortix.yaml` in the same turn. The prompt hook cannot observe that later
 * mutation. Gateway authorization therefore calls this function before it
 * evaluates the stored grant.
 *
 * The stored grant identifies the agent that currently owns the token after an
 * in-session agent switch. A null legacy or unrestricted grant falls back to
 * `project_sessions.agent_name`.
 */
export async function reconcileStoredSessionAgentGrant(input: {
  projectId: string;
  sessionId: string;
}): Promise<AgentGrant | null> {
  const stored = await loadStoredSessionGrant(input.sessionId);

  let runningAgent = stored?.agent?.trim() ?? '';
  if (!runningAgent) {
    try {
      const [session] = await db
        .select({ agentName: projectSessions.agentName })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, input.sessionId),
            eq(projectSessions.projectId, input.projectId),
          ),
        )
        .limit(1);
      runningAgent = session?.agentName?.trim() || DEFAULT_AGENT_SENTINEL;
    } catch (err) {
      throw new SessionGrantRemintError(input.sessionId, err);
    }
  }

  // This path refreshes connector and CLI authorization only. Secret delivery
  // already ran at prompt time, so resolve this agent against itself.
  const running = await resolveCurrentGrant({
    ...input,
    sessionAgent: runningAgent,
    runningAgent,
    forceRefresh: true,
  });
  await applyResolvedGrant(input.sessionId, stored, running);
  return running;
}
