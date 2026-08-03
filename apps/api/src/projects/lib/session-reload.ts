/**
 * Bringing a RUNNING session up to the latest config — the documented reload.
 *
 * Until this existed there was no answer to "I merged an agent change, how do I
 * get it into my open session?". `git pull` inside the sandbox updated the
 * working tree but not the agent's behaviour (the compiled config never came
 * from the working tree), restarting re-read the daemon's unchanged env and
 * rebuilt the same bytes, and killing opencode from inside the session killed
 * the turn doing the killing. The honest answer was "start a new session".
 *
 * A reload is two steps against a box that stays up:
 *
 *   1. Refresh the workspace — `POST /kortix/refresh?restart=0`. Explicitly NO
 *      restart here: step 2 restarts, and doing it twice would cost a second
 *      opencode boot and two windows where the box 503s.
 *   2. Recompile the agent config from the session's ref and push it, which
 *      restarts opencode so it rebuilds its config. This is the step that makes
 *      the agent's behaviour actually change; opencode reads config only at
 *      spawn, so nothing short of that applies.
 *
 * WHAT IT DOES NOT DO, said plainly because the difference bites:
 *
 *   - It does not preserve an in-flight turn. The restart ends it. Callers
 *     default to refusing while the session is busy rather than discarding work
 *     silently.
 *   - It does not change what the agent already read. A reload is "from here
 *     on", exactly like a secrets re-scope.
 *   - It cannot rewrite a session's identity: its branch, its tokens, its
 *     `runtime_context` are create-time and stay create-time.
 */

import { and, eq } from 'drizzle-orm';
import { projects, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { agentConfigEtag, resolveCompiledAgentConfigForSession } from './compile-agent-config';
import { pushSessionAgentConfigToSandbox } from './sandbox-env-sync';

const SANDBOX_SERVICE_PORT = 8000;

export interface SessionReloadResult {
  /** True when the agent config the box runs was actually replaced. */
  applied: boolean;
  /** What the box was running before, as reported by the box itself. */
  previous_etag: string | null;
  /** What it runs now (or would run — see `applied`). */
  etag: string | null;
  /** Whether the workspace was pulled, and to what. */
  repo_refreshed: boolean;
  commit_sha: string | null;
  /** Present when nothing was applied. */
  reason?: string;
}

/** What the sandbox says it is running right now. */
export async function readSandboxConfigState(input: {
  sessionId: string;
  /** Also ask whether a turn is running. Costs a call into opencode, so opt-in. */
  includeTurnState?: boolean;
}): Promise<{
  etag: string | null;
  commitSha: string | null;
  reachable: boolean;
  /** `null` when the box could not tell us — see the reload gate. */
  turnInFlight: boolean | null;
}> {
  try {
    const [row] = await db
      .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(
        and(eq(sessionSandboxes.sessionId, input.sessionId), eq(sessionSandboxes.status, 'active')),
      )
      .limit(1);
    const unreachable = { etag: null, commitSha: null, reachable: false, turnInFlight: null };
    if (!row?.externalId) return unreachable;
    const serviceKey = (row.config as Record<string, unknown> | null)?.serviceKey;
    if (typeof serviceKey !== 'string') return unreachable;

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    const res = await fetch(
      `${url.replace(/\/$/, '')}/kortix/health${input.includeTurnState ? '?turn=1' : ''}`,
      {
        headers: { ...headers, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return unreachable;
    const body = (await res.json()) as {
      agent_config_etag?: unknown;
      commit_sha?: unknown;
      turn_in_flight?: unknown;
    };
    return {
      etag: typeof body.agent_config_etag === 'string' ? body.agent_config_etag : null,
      commitSha: typeof body.commit_sha === 'string' ? body.commit_sha : null,
      reachable: true,
      // Tri-state on purpose: `true` busy, `false` idle, `null` could not tell.
      // Absent (the caller did not ask) is also null.
      turnInFlight:
        body.turn_in_flight === true ? true : body.turn_in_flight === false ? false : null,
    };
  } catch {
    return { etag: null, commitSha: null, reachable: false, turnInFlight: null };
  }
}

/**
 * The etag this session WOULD get if it were reloaded right now.
 *
 * Recompiles from the session's own ref; delivers nothing. Cheap enough to call
 * from a status endpoint — the git mirror is TTL-cached and the compile is pure.
 */
export async function latestAgentConfigEtag(input: {
  projectId: string;
  accountId: string;
  baseRef?: string | null;
}): Promise<string | null> {
  const [project] = await db
    .select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(and(eq(projects.projectId, input.projectId), eq(projects.accountId, input.accountId)))
    .limit(1);
  if (!project?.defaultBranch) return null;
  const compiled = await resolveCompiledAgentConfigForSession(
    {
      projectId: input.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      manifestPath: project.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    },
    input.baseRef,
  ).catch(() => null);
  return agentConfigEtag(compiled);
}

/**
 * Is this session behind?
 *
 * `null` when it cannot be told — the box is unreachable, or the project has no
 * compiled config to compare against. Deliberately not `false`: reporting
 * "up to date" because we failed to ask is the failure mode this exists to
 * prevent.
 */
export function isConfigStale(runningEtag: string | null, latestEtag: string | null): boolean | null {
  if (!latestEtag || !runningEtag) return null;
  return runningEtag !== latestEtag;
}

export async function reloadSessionConfig(input: {
  projectId: string;
  accountId: string;
  sessionId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath?: string | null;
  baseRef?: string | null;
  /** Pull the workspace before recompiling. Default true — the usual intent. */
  refreshRepo?: boolean;
  /** Reload even if a turn is running. It will be ended. */
  force?: boolean;
}): Promise<SessionReloadResult> {
  const before = await readSandboxConfigState({
    sessionId: input.sessionId,
    includeTurnState: input.force !== true,
  });
  if (!before.reachable) {
    return {
      applied: false,
      previous_etag: null,
      etag: null,
      repo_refreshed: false,
      commit_sha: null,
      reason: 'no reachable sandbox',
    };
  }

  // `null` counts as busy. "Could not tell" is not permission to restart — that
  // would defeat the one promise this gate makes, in precisely the case where
  // opencode is slow because it IS working.
  if (input.force !== true && before.turnInFlight !== false) {
    // The push restarts opencode, which ends the turn. Say so instead of
    // discarding someone's work silently.
    return {
      applied: false,
      previous_etag: before.etag,
      etag: before.etag,
      repo_refreshed: false,
      commit_sha: before.commitSha,
      reason:
        before.turnInFlight === true
          ? 'session is mid-turn'
          : 'could not confirm the session is idle',
    };
  }

  let repoRefreshed = false;
  let commitSha = before.commitSha;
  if (input.refreshRepo !== false) {
    const refreshed = await refreshSandboxWorkspace(input.sessionId);
    repoRefreshed = refreshed.ok;
    commitSha = refreshed.commitSha ?? commitSha;
  }

  const push = await pushSessionAgentConfigToSandbox({
    projectId: input.projectId,
    sessionId: input.sessionId,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch,
    manifestPath: input.manifestPath,
    baseRef: input.baseRef,
  });

  const latest = await latestAgentConfigEtag({
    projectId: input.projectId,
    accountId: input.accountId,
    baseRef: input.baseRef,
  });

  return {
    applied: push.applied,
    previous_etag: before.etag,
    // On a refusal the box still runs what it ran; do not report the new hash as
    // though it had landed.
    etag: push.applied ? latest : before.etag,
    repo_refreshed: repoRefreshed,
    commit_sha: commitSha,
    ...(push.applied ? {} : { reason: push.reason ?? 'agent config unchanged' }),
  };
}

/**
 * `POST /kortix/refresh?restart=0` — pull the workspace, leave opencode alone.
 *
 * `restart=0` matters: the config push right after restarts opencode anyway, and
 * restarting twice doubles the boot cost and the window where the box 503s.
 */
async function refreshSandboxWorkspace(
  sessionId: string,
): Promise<{ ok: boolean; commitSha: string | null }> {
  try {
    const [row] = await db
      .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.status, 'active')))
      .limit(1);
    const serviceKey = (row?.config as Record<string, unknown> | null)?.serviceKey;
    if (!row?.externalId || typeof serviceKey !== 'string') return { ok: false, commitSha: null };

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    const res = await fetch(`${url.replace(/\/$/, '')}/kortix/refresh?restart=0`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ok: false, commitSha: null };
    const body = (await res.json()) as { repo?: { commit?: unknown } };
    const commit = body.repo?.commit;
    return { ok: true, commitSha: typeof commit === 'string' ? commit : null };
  } catch {
    // A failed pull is not a failed reload: the config recompiles from the git
    // MIRROR, not the sandbox's working tree, so the agent still updates.
    return { ok: false, commitSha: null };
  }
}
