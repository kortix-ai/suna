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
 *
 * ── The rewrite is guarded by PROVENANCE (INC-2026-09-08-CONNECTOR-GATEWAY) ──
 *
 * Every grant now carries the manifest blob sha and commit it was derived from
 * (`AgentGrant.manifestRevision` / `manifestCommit`, stamped by
 * `withGrantProvenance`). A freshly derived grant REPLACES the stored one only
 * when it is a genuine manifest change:
 *
 *   1. Same blob, different grant → the grant is a pure function of the blob
 *      and the agent name, so this is a glitched read, not a change. KEEP the
 *      stored grant, log at error level.
 *   2. Commit is an ANCESTOR of the stored grant's commit → a stale mirror
 *      served an older manifest. KEEP the stored grant, log.
 *   3. Manifest unreadable on the gateway path → KEEP the stored grant (the
 *      last-known-good) instead of failing every connector call. The prompt
 *      path still fails closed (a prompt can be retried; a turn's every tool
 *      call cannot).
 *
 * Before this guard, one bad read — a session-wide `connectors: []` for a
 * declared `connectors: all` agent — took every connector away from a live
 * session, including the Slack channel the agent answers on, until an
 * unrelated prompt re-minted the row. The project had 59 such denials in the
 * week before the incident.
 */

import { type AgentGrant, accountTokens, projectSessions, projects } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { existingProjectMirrorPath, runGitCapture } from '../git/mirror';
import { agentGrantDiffers, resolveSessionAgentGrant } from './secret-grant';
import { piWorkerRuntimeIdentityFromSessionMetadata, sessionMetadataClaimsPiWorker } from './session-sandbox-metadata';

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

/** Why a resolved grant was NOT applied and the stored one kept instead. */
export type RemintKeepReason =
  /** Same manifest blob as the stored grant, yet a different grant: a glitched
   *  read, since the grant is a pure function of blob + agent name. */
  | 'same_manifest_drift'
  /** The manifest was read at a commit that is an ancestor of the commit the
   *  stored grant came from: a stale mirror. */
  | 'stale_manifest_read'
  /** The manifest could not be read at all; the stored grant is the
   *  last-known-good. Gateway path only. */
  | 'manifest_unreadable';

export type RemintDecision =
  | { action: 'skip' }
  | { action: 'write'; grant: AgentGrant }
  | { action: 'refuse'; reason: string }
  | { action: 'keep'; reason: RemintKeepReason; grant: AgentGrant };

function sameProvenance(stored: AgentGrant | null, running: AgentGrant | null): boolean {
  return (
    (stored?.manifestRevision ?? null) === (running?.manifestRevision ?? null) &&
    (stored?.manifestCommit ?? null) === (running?.manifestCommit ?? null)
  );
}

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
 *
 * `keep` is the provenance guard (see the module comment). `opts.staleRead` is
 * the ancestry verdict the async caller computed against the git mirror; the
 * same-blob rule needs no I/O and lives here.
 */
export function remintDecisionFor(
  stored: AgentGrant | null,
  running: AgentGrant | null,
  opts: { staleRead?: boolean } = {},
): RemintDecision {
  if (!agentGrantDiffers(stored, running)) {
    // Equal grants. Rewrite once when the provenance changed — a token minted
    // before provenance existed, or a manifest commit that did not touch this
    // agent — so the NEXT comparison has a blob and a commit to reason with.
    if (stored && running && !sameProvenance(stored, running) && running.manifestRevision) {
      return { action: 'write', grant: running };
    }
    return { action: 'skip' };
  }
  if (running === null) {
    return {
      action: 'refuse',
      reason:
        'the agent this prompt runs resolved to an UNRESTRICTED grant while the session token holds a narrower one — refusing rather than widening the token',
    };
  }
  if (
    stored &&
    stored.agent === running.agent &&
    stored.manifestRevision &&
    running.manifestRevision &&
    stored.manifestRevision === running.manifestRevision
  ) {
    return { action: 'keep', reason: 'same_manifest_drift', grant: stored };
  }
  if (stored && opts.staleRead) {
    return { action: 'keep', reason: 'stale_manifest_read', grant: stored };
  }
  return { action: 'write', grant: running };
}

/**
 * Is `older` an ancestor of `newer` in this project's mirror? Answers `false`
 * when either commit is unknown to the mirror or the mirror is absent, so an
 * unanswerable question never blocks a genuine change.
 */
async function isAncestorInMirror(
  projectId: string,
  older: string,
  newer: string,
): Promise<boolean> {
  const repoPath = existingProjectMirrorPath({
    projectId,
    repoUrl: '',
    defaultBranch: '',
    manifestPath: '',
  });
  if (!repoPath) return false;
  try {
    const result = await runGitCapture(['merge-base', '--is-ancestor', older, newer], repoPath);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The ancestry verdict for two grants: `true` only when both carry a commit,
 * the commits differ, and the running grant's commit is an ancestor of the
 * stored grant's — i.e. the running grant came from an OLDER manifest.
 */
async function resolvedFromStaleCommit(
  projectId: string,
  stored: AgentGrant | null,
  running: AgentGrant | null,
  isAncestor: typeof isAncestorInMirror = isAncestorInMirror,
): Promise<boolean> {
  const storedCommit = stored?.manifestCommit ?? null;
  const runningCommit = running?.manifestCommit ?? null;
  if (!storedCommit || !runningCommit || storedCommit === runningCommit) return false;
  return isAncestor(projectId, runningCommit, storedCommit);
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
  sourceSha?: string;
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
      defaultBranch: input.sourceSha ?? project?.defaultBranch,
      manifestPath: project?.manifestPath,
      sessionAgent: input.sessionAgent,
      requestedAgent: input.runningAgent,
      forceRefresh: input.forceRefresh,
    });
  } catch (err) {
    throw new SessionGrantRemintError(input.sessionId, err);
  }
}

async function loadSessionAgent(input: { projectId: string; sessionId: string }) {
  const [session] = await db.select({ agentName: projectSessions.agentName, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.projectId, input.projectId)))
    .limit(1);
  if (!sessionMetadataClaimsPiWorker(session?.metadata)) return { agentName: session?.agentName };
  const identity = piWorkerRuntimeIdentityFromSessionMetadata(session?.metadata);
  if (!identity || !session?.agentName?.trim()) {
    throw new SessionGrantRemintError(input.sessionId, new Error('Pi runtime identity is incomplete'));
  }
  return { agentName: session.agentName, sourceSha: identity.sha };
}

function describeGrant(grant: AgentGrant | null): Record<string, unknown> {
  if (!grant) return { grant: null };
  return {
    agent: grant.agent,
    connectors: grant.connectors,
    kortixCli: grant.kortixCli,
    env: grant.env ?? 'all',
    manifestRevision: grant.manifestRevision ?? null,
    manifestCommit: grant.manifestCommit ?? null,
  };
}

async function applyResolvedGrant(
  input: { projectId: string; sessionId: string; sourceSha?: string },
  stored: AgentGrant | null,
  running: AgentGrant | null,
  /** A second, forced read of the manifest. Used ONLY to break the same-blob
   *  tie: the stored grant and the fresh grant claim the same blob yet differ,
   *  and nothing in either says which one is the glitch. Two consistent fresh
   *  reads beat one stored value; one fresh read that the next read
   *  contradicts is the glitch, and the stored grant stays. */
  reresolve?: () => Promise<AgentGrant | null>,
): Promise<RemintDecision> {
  const staleRead = !input.sourceSha && agentGrantDiffers(stored, running)
    ? await resolvedFromStaleCommit(input.projectId, stored, running)
    : false;
  let decision = remintDecisionFor(stored, running, { staleRead });
  if (decision.action === 'keep' && decision.reason === 'same_manifest_drift' && reresolve) {
    const second = await reresolve().catch(() => null);
    if (second && !agentGrantDiffers(second, running) && sameProvenance(second, running)) {
      console.error('[session-token-grant] two consistent manifest reads contradict the stored grant; applying the read', {
        sessionId: input.sessionId,
        projectId: input.projectId,
        stored: describeGrant(stored),
        resolved: describeGrant(running),
      });
      decision = { action: 'write', grant: running as AgentGrant };
    }
  }
  if (decision.action === 'refuse') {
    throw new SessionGrantRemintError(input.sessionId, new Error(decision.reason));
  }
  if (decision.action === 'keep') {
    // Loud on purpose. Either the mirror served an older manifest or the same
    // blob produced two different grants; both are platform faults, and the
    // token keeps its last-known-good grant while they are investigated.
    console.error('[session-token-grant] refused to rewrite the session grant from a suspect manifest read', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      reason: decision.reason,
      stored: describeGrant(stored),
      resolved: describeGrant(running),
    });
  }
  if (decision.action === 'write') {
    await remintSessionAgentGrant(input.sessionId, decision.grant);
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
export async function remintGrantForAgentSwitch(
  input: {
    projectId: string;
    sessionId: string;
    /** `project_sessions.agent_name` — the agent the session was CREATED with. */
    sessionAgent: string;
    /** The agent this prompt asked to run, verbatim from the body. */
    requestedAgent: string | null;
  },
): Promise<RemintDecision> {
  const session = await loadSessionAgent(input);
  const requested = input.requestedAgent?.trim();
  // The agent that will ACTUALLY run. `project_sessions.agent_name` is the
  // create-time agent and nothing ever updates it, so it is the fallback, not
  // the reference point.
  const runningAgent =
    requested && requested !== DEFAULT_AGENT_SENTINEL ? requested : session.agentName ?? input.sessionAgent;
  if (session.sourceSha && runningAgent !== session.agentName) {
    throw new SessionGrantRemintError(input.sessionId, new Error('Pi agent switching requires a new session'));
  }

  const stored = await loadStoredSessionGrant(input.sessionId);
  // Synchronous for the same-agent case too — every ordinary turn. This ran in
  // the background for one release (the manifest read is a git fetch of the
  // project mirror, ~0.8s on the path of every prompt) and the security review
  // was right to refuse it: generic Kortix CLI/API authorization reads
  // `account_tokens.agent_grant` straight from the token row (`middleware/
  // auth.ts` → `requireScope`), so a `kortix.yaml` that NARROWED the running
  // agent's `kortixCli` in the previous turn was still enforced with the old,
  // broader grant for the first calls of the next turn. Only the connector
  // gateway reconciles at call time (`reconcileStoredSessionAgentGrant`).
  // The prompt must not be forwarded before the row is rewritten.
  const resolve = () =>
    resolveCurrentGrant({
      ...input,
      runningAgent,
      forceRefresh: true,
      sourceSha: session.sourceSha,
    });
  const running = await resolve();
  return applyResolvedGrant({ ...input, sourceSha: session.sourceSha }, stored, running, resolve);
}

/**
 * Bound the forced mirror fetch the gateway path performs.
 *
 * `reconcileStoredSessionAgentGrant` runs on EVERY connector call, and a forced
 * refresh is a `git fetch --prune` of the whole project mirror (2,000+ refs on
 * a busy project, ~0.6 s). A turn that fans out five tool calls paid for five
 * fetches. Within this window the mirror is served as-is; a manifest commit
 * from another replica is picked up by the first call after it. The prompt
 * path (`remintGrantForAgentSwitch`) still forces unconditionally — once per
 * turn.
 */
function grantRefreshCooldownMs(): number {
  const value = Number(process.env.KORTIX_GRANT_REFRESH_COOLDOWN_MS || 3_000);
  return Number.isFinite(value) && value >= 0 ? value : 3_000;
}

const lastForcedGrantRefreshAt = new Map<string, number>();

function shouldForceGrantRefresh(projectId: string, now = Date.now()): boolean {
  const last = lastForcedGrantRefreshAt.get(projectId) ?? 0;
  if (now - last < grantRefreshCooldownMs()) return false;
  lastForcedGrantRefreshAt.set(projectId, now);
  return true;
}

/** Test seam: forget every cooldown so the next reconcile forces a refresh. */
export function resetGrantRefreshCooldownForTest(): void {
  lastForcedGrantRefreshAt.clear();
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
 *
 * LAST-KNOWN-GOOD: when the manifest cannot be read (mirror fetch failed, git
 * proxy hop timed out) and the token already holds a grant, that grant is
 * returned unchanged and the failure is logged. A session must not lose every
 * connector — including the channel it answers on — because one git read
 * failed. A token with NO stored grant still fails closed: there is nothing
 * known-good to fall back to.
 */
export async function reconcileStoredSessionAgentGrant(input: {
  projectId: string;
  sessionId: string;
}): Promise<AgentGrant | null> {
  const stored = await loadStoredSessionGrant(input.sessionId);
  const session = await loadSessionAgent(input);
  const runningAgent = (session.sourceSha ? session.agentName : stored?.agent?.trim())
    || session.agentName?.trim() || DEFAULT_AGENT_SENTINEL;

  // This path refreshes connector and CLI authorization only. Secret delivery
  // already ran at prompt time, so resolve this agent against itself.
  let running: AgentGrant | null;
  try {
    running = await resolveCurrentGrant({
      ...input,
      sessionAgent: runningAgent,
      runningAgent,
      forceRefresh: session.sourceSha ? true : shouldForceGrantRefresh(input.projectId),
      sourceSha: session.sourceSha,
    });
  } catch (err) {
    if (session.sourceSha || !stored) throw err;
    console.error('[session-token-grant] manifest unreadable; serving the last-known-good session grant', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      reason: 'manifest_unreadable' satisfies RemintKeepReason,
      error: err instanceof Error ? err.message : String(err),
      stored: describeGrant(stored),
    });
    return stored;
  }
  let decision: RemintDecision;
  try {
    decision = await applyResolvedGrant({ ...input, sourceSha: session.sourceSha }, stored, running, () =>
      resolveCurrentGrant({ ...input, sessionAgent: runningAgent, runningAgent, forceRefresh: true, sourceSha: session.sourceSha }),
    );
  } catch (err) {
    // A refused widening (`running` unrestricted, `stored` narrower) or a
    // failed row write. Neither changes what this call may do: the stored
    // grant is the authority the token already carries, so answer with it and
    // let the next call retry the write. Only a token with nothing stored
    // has no safe answer.
    if (session.sourceSha || !stored) throw err;
    console.error('[session-token-grant] could not apply the resolved session grant; serving the stored grant', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
      stored: describeGrant(stored),
      resolved: describeGrant(running),
    });
    return stored;
  }
  if (decision.action === 'keep') return decision.grant;
  return running;
}
