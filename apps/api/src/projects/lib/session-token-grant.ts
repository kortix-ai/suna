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

import { type AgentGrant, accountTokens, readStoredAgentGrant, projectSessions, projects } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { DEFAULT_AGENT_SENTINEL, grantFromLoadedAgents, isLaunchableAgentName, loadProjectAgents, type LoadedAgents } from '../agents';
import { type MirrorRefresh, existingProjectMirrorPath, runGitCapture } from '../git/mirror';
import {
  agentGrantDiffers,
  isAgentLaunchableForProject,
  resolveSessionAgentGrant,
  withGrantProvenance,
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
      { cause },
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
    return readStoredAgentGrant(token?.agentGrant);
  } catch (err) {
    throw new SessionGrantRemintError(sessionId, err);
  }
}

async function loadGitProjectRow(projectId: string) {
  const [project] = await db
    .select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return project;
}

/**
 * Is `agentName` an agent this session's project declares? FAIL CLOSED: a read
 * that throws answers `false`, and the caller falls back to the session agent.
 */
export async function agentLaunchableInProject(
  projectId: string,
  agentName: string,
): Promise<boolean> {
  try {
    return await launchableInProjectRow(await loadGitProjectRow(projectId), projectId, agentName);
  } catch {
    return false;
  }
}

/** `agentLaunchableInProject` against a project row the caller already read —
 *  the reconcile loads the row once for this gate and the grant resolution. */
async function launchableInProjectRow(
  project: Awaited<ReturnType<typeof loadGitProjectRow>>,
  projectId: string,
  agentName: string,
): Promise<boolean> {
  try {
    return await isAgentLaunchableForProject({
      projectId,
      repoUrl: project?.repoUrl ?? '',
      defaultBranch: project?.defaultBranch,
      manifestPath: project?.manifestPath,
      agentName,
    });
  } catch {
    return false;
  }
}

async function resolveCurrentGrant(input: {
  projectId: string;
  sessionId: string;
  sessionAgent: string;
  runningAgent: string;
  forceRefresh: MirrorRefresh;
}): Promise<AgentGrant | null> {
  try {
    const project = await loadGitProjectRow(input.projectId);

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

function describeGrant(grant: AgentGrant | null): Record<string, unknown> {
  if (!grant) return { grant: null };
  return {
    agent: grant.agent,
    connectors: grant.connectors,
    permissions: grant.permissions,
    env: grant.env ?? 'all',
    apps: grant.apps ?? [],
    manifestRevision: grant.manifestRevision ?? null,
    manifestCommit: grant.manifestCommit ?? null,
  };
}

async function applyResolvedGrant(
  input: { projectId: string; sessionId: string },
  stored: AgentGrant | null,
  running: AgentGrant | null,
  /** A second, forced read of the manifest. Used ONLY to break the same-blob
   *  tie: the stored grant and the fresh grant claim the same blob yet differ,
   *  and nothing in either says which one is the glitch. Two consistent fresh
   *  reads beat one stored value; one fresh read that the next read
   *  contradicts is the glitch, and the stored grant stays. */
  reresolve?: () => Promise<AgentGrant | null>,
): Promise<RemintDecision> {
  const staleRead = agentGrantDiffers(stored, running)
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
  const requested = input.requestedAgent?.trim();
  // The agent that will ACTUALLY run. `project_sessions.agent_name` is the
  // create-time agent and nothing ever updates it, so it is the fallback, not
  // the reference point.
  let runningAgent =
    requested && requested !== DEFAULT_AGENT_SENTINEL ? requested : input.sessionAgent;
  // INC-2026-09-15. A name this project does not declare NEVER reaches the
  // token. `chief-of-staff`, an agent of a different project, was written onto
  // ~50 session tokens of unrelated projects and stripped every one of them of
  // its CLI and connector access. The proxy already drops such a name from the
  // body before this runs; this is the last line, for any path that does not.
  if (
    runningAgent !== input.sessionAgent &&
    !(await agentLaunchableInProject(input.projectId, runningAgent))
  ) {
    console.error('[session-token-grant] refused to re-point a session token at an undeclared agent', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      sessionAgent: input.sessionAgent,
      requestedAgent: runningAgent,
    });
    runningAgent = input.sessionAgent;
  }

  // The stored grant and the manifest read need nothing from each other: they
  // start together. Awaited in the original order.
  const storedRead = loadStoredSessionGrant(input.sessionId);
  storedRead.catch(() => undefined);
  // Synchronous for the same-agent case too — every ordinary turn. This ran in
  // the background for one release (the manifest read is a git fetch of the
  // project mirror, ~0.8s on the path of every prompt) and the security review
  // was right to refuse it: generic Kortix CLI/API authorization reads
  // `account_tokens.agent_grant` straight from the token row (`middleware/
  // auth.ts` → `requireScope`), so a `kortix.yaml` that NARROWED the running
  // agent's `permissions` in the previous turn was still enforced with the old,
  // broader grant for the first calls of the next turn. Only the connector
  // gateway reconciles at call time (`reconcileStoredSessionAgentGrant`).
  // The prompt must not be forwarded before the row is rewritten.
  //
  // `'tip-proof'`, not `true`: the read ran `git ls-remote` (~600 ms) on every
  // prompt to learn that the manifest had not moved. A manifest change made
  // through Kortix drops the proof in every API process, so the case above
  // still reads the new manifest before the turn (see `MirrorRefresh`). The
  // tie-break read stays strict: it exists to contradict the first one.
  const resolve = (forceRefresh: MirrorRefresh) =>
    resolveCurrentGrant({ ...input, runningAgent, forceRefresh });
  const runningRead = resolve('tip-proof');
  runningRead.catch(() => undefined);
  const stored = await storedRead;
  const running = await runningRead;
  return applyResolvedGrant(input, stored, running, () => resolve(true));
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
  /** The grant the caller read off the token row this request. When given, the
   *  reconcile skips its own by-session read: a re-mint rewrites every ACTIVE
   *  token of the session in one statement, so the row the auth middleware just
   *  validated already carries the session's stored grant. Every /call saves
   *  one `account_tokens` round trip. */
  storedGrant?: AgentGrant | null;
}): Promise<AgentGrant | null> {
  const stored =
    input.storedGrant !== undefined ? input.storedGrant : await loadStoredSessionGrant(input.sessionId);

  // The git project row feeds both the launch check and the grant resolution;
  // read it once. A failed read is the manifest-unreadable path's twin: keep
  // the last-known-good grant when there is one, fail closed otherwise — the
  // shared keep-stored block below serves both.
  let project: Awaited<ReturnType<typeof loadGitProjectRow>> | null = null;
  let rowError: unknown = null;
  try {
    project = await loadGitProjectRow(input.projectId);
  } catch (err) {
    rowError = err;
  }

  let runningAgent = stored?.agent?.trim() ?? '';
  // ONE manifest read answers every gate this request needs: whether the stored
  // agent is still declared (INC-2026-09-15) and what grant the agent holds.
  // The launch check and the grant resolution used to load the manifest agents
  // twice per call — two more round trips to the same rows.
  let loaded: LoadedAgents | null = null;
  let manifestError: unknown = null;
  if (!rowError && project?.defaultBranch) {
    try {
      loaded = await loadProjectAgents(
        {
          projectId: input.projectId,
          repoUrl: project.repoUrl ?? '',
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath,
          gitAuthToken: null,
        },
        // Runs on EVERY connector call: the tip proof bounds the remote reads
        // to one per refresh interval, and a manifest commit handled by another
        // replica drops it (see `MirrorRefresh`).
        { rethrowReadErrors: true, forceRefresh: 'tip-proof' },
      );
    } catch (err) {
      manifestError = err;
    }
  }
  // Self-heal INC-2026-09-15: a stored agent the project does not declare is not
  // an identity to keep serving. Fall back to the session's own agent below.
  // Only a READ manifest can prove non-declaration; an unreadable one goes to
  // the keep-stored path below untouched.
  if (runningAgent && loaded && !isLaunchableAgentName(runningAgent, loaded)) {
    console.error('[session-token-grant] stored session grant names an undeclared agent; healing to the session agent', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      storedAgent: runningAgent,
    });
    runningAgent = '';
  }
  if (!runningAgent && !rowError) {
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
  // already ran at prompt time, so resolve this agent against itself — from the
  // manifest agents already loaded above, exactly as `resolveSessionAgentGrant`
  // would (same `loadGrantForRunningAgent` derivation, minus the duplicate
  // manifest read).
  let running: AgentGrant | null;
  if (rowError || manifestError) {
    // The manifest cannot be read (mirror fetch failed, git proxy hop timed
    // out, or the project row itself did). A token with a stored grant keeps
    // it; one without fails closed.
    const unreadableError = rowError ?? manifestError;
    if (!stored) throw new SessionGrantRemintError(input.sessionId, unreadableError);
    console.error('[session-token-grant] manifest unreadable; serving the last-known-good session grant', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      reason: 'manifest_unreadable' satisfies RemintKeepReason,
      error: unreadableError instanceof Error ? unreadableError.message : String(unreadableError),
      stored: describeGrant(stored),
    });
    return stored;
  }
  if (!project?.defaultBranch) {
    // No git context: no per-agent governance, the unrestricted grant.
    running = null;
  } else if (loaded) {
    running = withGrantProvenance(grantFromLoadedAgents(runningAgent, loaded), loaded);
  } else {
    // Unreachable with `rethrowReadErrors: true` (a failed read throws, and a
    // successful one returns agents); if it ever happens, serve the stored
    // grant rather than derive from nothing.
    running = stored;
  }
  let decision: RemintDecision;
  try {
    decision = await applyResolvedGrant(input, stored, running, () =>
      resolveCurrentGrant({ ...input, sessionAgent: runningAgent, runningAgent, forceRefresh: true }),
    );
  } catch (err) {
    // A refused widening (`running` unrestricted, `stored` narrower) or a
    // failed row write. Neither changes what this call may do: the stored
    // grant is the authority the token already carries, so answer with it and
    // let the next call retry the write. Only a token with nothing stored
    // has no safe answer.
    if (!stored) throw err;
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
