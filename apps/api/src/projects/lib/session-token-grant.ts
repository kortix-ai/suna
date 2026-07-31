/**
 * Re-mint a live session token's agent grant when a prompt switches agents.
 *
 * `account_tokens.agent_grant` is written ONCE, at session mint, from the agent
 * the session was created with. Nothing ever rewrote it, and nothing updates
 * `project_sessions.agent_name` either — but in-session agent switching is
 * allowed and the proxy forwards a prompt's concrete `agent` field untouched.
 * So the connector and Kortix-CLI gates (`agentMayUseConnector`,
 * `agentMayPerform`) read the BOOT agent's grant no matter which agent is
 * actually running:
 *
 *     create session with agent A (connectors: all)
 *     prompt {"agent": "B"}  where B declares connectors: [calendar]
 *       -> opencode runs B
 *       -> the token still carries A's grant
 *       -> B calls A's connectors, including ones its own manifest denies it
 *
 * Secrets are replaced through the pre-prompt env sync (see `secret-grant.ts`).
 * An operator can enable the strict secret-grant lock to refuse a boundary
 * switch because narrowing later cannot un-read a value the previous agent
 * already consumed. Connector and CLI grants have no such residue: they are
 * checked against this row at CALL time, so rewriting it genuinely re-scopes
 * every subsequent call.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { accountTokens, projects, type AgentGrant } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import {
  AgentSecretGrantMismatchError,
  agentGrantDiffers,
  resolveSessionAgentGrant,
} from './secret-grant';

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

/**
 * Re-point a session token's grant at the agent a prompt actually runs.
 *
 * A no-op — and, importantly, no manifest read — unless the prompt names a
 * concrete agent that differs from the session's. Ordinary turns are the
 * overwhelming majority and must not pay for this.
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

  let stored: AgentGrant | null;
  try {
    const [token] = await db
      .select({ agentGrant: accountTokens.agentGrant })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.sessionId, input.sessionId),
          eq(accountTokens.status, 'active'),
          isNull(accountTokens.revokedAt),
        ),
      )
      .limit(1);
    stored = token?.agentGrant ?? null;
  } catch (err) {
    throw new SessionGrantRemintError(input.sessionId, err);
  }

  // Skip — and pay NO manifest read — only when the token already represents the
  // agent about to run.
  //
  // The earlier version skipped whenever `requested === sessionAgent`, which was
  // wrong the moment a re-mint had happened: switch to a broader agent once, then
  // switch back (or simply omit `agent`), and the token kept the BROADER grant
  // while the narrower agent ran. `agent_name` never changes, so it could not
  // detect that the token had moved. The grant's own `agent` field can.
  if (stored?.agent === runningAgent) return { action: 'skip' };
  // A null stored grant means the project declares no per-agent governance, so
  // boot minted null too. Nothing to revert unless a concrete DIFFERENT agent is
  // named — which is the only case worth a manifest read.
  if (stored === null && runningAgent === input.sessionAgent) return { action: 'skip' };

  let running: AgentGrant | null;
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

    running = await resolveSessionAgentGrant({
      projectId: input.projectId,
      repoUrl: project?.repoUrl ?? '',
      defaultBranch: project?.defaultBranch,
      manifestPath: project?.manifestPath,
      sessionAgent: input.sessionAgent,
      requestedAgent: runningAgent,
      enforceGrantLock: config.KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK,
    });
  } catch (err) {
    // A secret-boundary refusal is the env sync's error to report, not ours —
    // rethrow it unchanged so the proxy still answers 409, not 503.
    if (err instanceof AgentSecretGrantMismatchError) throw err;
    throw new SessionGrantRemintError(input.sessionId, err);
  }

  const decision = remintDecisionFor(stored, running);
  if (decision.action === 'refuse') {
    throw new SessionGrantRemintError(input.sessionId, new Error(decision.reason));
  }
  if (decision.action === 'write') {
    await remintSessionAgentGrant(input.sessionId, decision.grant);
  }
  return decision;
}
