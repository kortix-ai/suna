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
import { invalidateProjectMirror, type GitBackedProject } from '../git';
import { agentConfigEtag, resolveCompiledAgentConfigForSession } from './compile-agent-config';
import { pushSessionAgentConfigToSandbox } from './sandbox-env-sync';

const SANDBOX_SERVICE_PORT = 8000;

/**
 * What happened to the agent `.md` files opencode actually reads.
 *
 * Six outcomes and not a boolean, because three of them are successes, one is a
 * deliberate refusal, and two are "we did not find out" for different reasons.
 * Collapsing any of those together is how a reload ends up warning about a
 * success — or, worse, calling a no-op a success.
 */
export type ReloadAgentFiles =
  /** Brought forward from base. The agent WILL behave differently. */
  | 'updated'
  /** Nothing to do — they already matched base. */
  | 'already-current'
  /** Refused: this session has its own edits or commits there. Kept. */
  | 'kept-yours'
  /** The project keeps no agent files in the repo. */
  | 'not-applicable'
  /** `refresh_repo: false` — never attempted. */
  | 'not-requested'
  /** A daemon built before the sync shipped could not say. */
  | 'unknown';

/** Map the daemon's raw answer onto the outcome the surfaces branch on. */
export function classifyAgentFiles(input: {
  requested: boolean;
  synced: boolean | null;
  reason?: string;
}): ReloadAgentFiles {
  if (!input.requested) return 'not-requested';
  if (input.synced === true) return 'updated';
  if (input.synced === null) return 'unknown';
  switch (input.reason) {
    case 'already matches base':
      return 'already-current';
    case 'local changes':
    case 'local commits':
      return 'kept-yours';
    case 'no tracked config dir':
    case 'not in base':
      return 'not-applicable';
    default:
      // fetch failed / checkout failed / anything new: we cannot claim the agent
      // changed, and we must not claim the user's version was deliberately kept.
      return 'unknown';
  }
}

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
  /**
   * What happened to the agent files opencode ACTUALLY reads.
   *
   * This, not `applied`, decides whether the agent behaves differently: opencode
   * is spawned with `OPENCODE_CONFIG_DIR` pointing into the working tree, and
   * the `.md` files there beat the compiled config this pushes as JSON. So
   * `applied: true` with anything but `updated` means the etag moved and the
   * agent did not.
   *
   * A boolean was not enough. `false` conflated a deliberate refusal with two
   * outcomes that are plain successes (nothing to do, project keeps no agent
   * files), and `null` conflated "an old daemon could not say" with "we never
   * tried because refresh_repo was false" — so both the CLI and the web toast
   * classified real successes as warnings and vice versa.
   */
  agent_files: ReloadAgentFiles;
  /** Present when nothing was applied. */
  reason?: string;
}

/**
 * One sentence for the reload, and the only place that decides whether we are
 * allowed to say the agent changed.
 *
 * The old copy — "Reloaded. The next prompt runs the new config." — was
 * unconditional, and measurably false whenever the agent's `.md` files were not
 * brought forward: the etag moved, opencode kept reading the working tree, and
 * the user was told the opposite.
 */
export function reloadDetail(result: SessionReloadResult): string {
  if (!result.applied) return `Nothing to apply: ${result.reason ?? 'unchanged'}.`;
  switch (result.agent_files) {
    case 'updated':
      return 'Reloaded. The next prompt runs the new config.';
    case 'already-current':
      return 'Reloaded. The agent files were already current.';
    case 'not-applicable':
      return 'Reloaded. This project keeps no agent files in the repo, so only the compiled config changed.';
    case 'kept-yours':
      return 'Config pushed, but this session has its own changes to its agent files — those were kept, so the agent still runs YOUR version.';
    case 'not-requested':
      return 'Compiled config pushed. Agent files were left alone because the repo refresh was skipped.';
    default:
      return 'Config pushed, but this sandbox could not confirm its agent files were updated — restart the session if the agent still behaves the old way.';
  }
}

/**
 * Is this an outcome the user should be nudged about?
 *
 * Only two are: their own version was kept, or we could not confirm. Everything
 * else — including the two cases where nothing needed doing — is a success, and
 * warning on those was the first thing the review caught.
 */
export function reloadNeedsAttention(result: SessionReloadResult): boolean {
  if (!result.applied) return true;
  return result.agent_files === 'kept-yours' || result.agent_files === 'unknown';
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
 * "Latest" has to mean latest — drop the mirror's TTL before compiling.
 *
 * The git mirror is TTL-cached (60s by default) and every read through
 * `readRepoFile` / `resolveCommitSha` takes the warm hit. On an ordinary
 * endpoint that is right. On THIS one it is self-defeating: the whole feature is
 * "I merged a change, get it into my session", and the merge is by definition
 * seconds old. Reloading inside the window recompiled the PRE-merge manifest,
 * produced an unchanged etag, and answered "already up to date" — the exact
 * confusion the reload exists to end, moved one layer up.
 *
 * Invalidating rather than force-fetching keeps it to a single network op: the
 * compile's own first read does the fetch and re-stamps `lastRefreshAt`, so the
 * reads after it in the same request are warm again.
 */
/**
 * The etag this session WOULD get if it were reloaded right now.
 *
 * Recompiles from the session's own ref; delivers nothing.
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
  const gitProject: GitBackedProject = {
    projectId: input.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath ?? 'kortix.yaml',
    gitAuthToken: null,
  };
  // Without this, `stale: false` is answerable from a cache that predates the
  // very commit the caller is asking about.
  invalidateProjectMirror(input.projectId);
  const compiled = await resolveCompiledAgentConfigForSession(gitProject, input.baseRef).catch(
    () => null,
  );
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
  // Before anything reads the mirror — the base_sha resolve, the compile inside
  // the push, the etag compare. See `invalidateProjectMirror` above: a reload
  // served from a 60s cache can apply the pre-merge config and report success.
  invalidateProjectMirror(input.projectId);

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
      agent_files: 'unknown',
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
      agent_files: 'unknown',
      reason:
        before.turnInFlight === true
          ? 'session is mid-turn'
          : 'could not confirm the session is idle',
    };
  }

  let repoRefreshed = false;
  let commitSha = before.commitSha;
  // `null` until the box answers — a daemon built before the config-dir sync
  // shipped ignores the request and reports nothing, which is not the same as
  // declining to sync.
  let configDirSynced: boolean | null = null;
  let configDirReason: string | undefined;
  if (input.refreshRepo !== false) {
    const refreshed = await refreshSandboxWorkspace(input.sessionId);
    repoRefreshed = refreshed.ok;
    commitSha = refreshed.commitSha ?? commitSha;
    configDirSynced = refreshed.configDirSynced;
    configDirReason = refreshed.configDirReason;
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
    agent_files: classifyAgentFiles({
      requested: input.refreshRepo !== false,
      synced: configDirSynced,
      reason: configDirReason,
    }),
    ...(push.applied ? {} : { reason: push.reason ?? 'agent config unchanged' }),
  };
}

/**
 * `POST /kortix/refresh?restart=0` — fast-forward the session's own branch.
 *
 * NEVER `base=1`. That flag routes the daemon to `syncWorkspaceToBase`, whose
 * entire body is `git checkout -B <cfg.branchName> <baseSha>` — and
 * `cfg.branchName` is the SESSION ID. On a session with commits of its own that
 * force-moves the working branch onto the base tip, orphaning every one of them
 * and deleting the files they introduced. The helper says so itself: "safe
 * because a fresh session has no local work yet". Its only other caller invokes
 * it at session CREATE on a restored warm snapshot, which is exactly that
 * pristine case. A reload runs against an established session, where the
 * precondition does not hold.
 *
 * It is tempting to gate the reset on "does this session have local commits" and
 * the API cannot answer that: the mirror is the only thing it can inspect, and a
 * session branch that was committed but never pushed does not exist there. The
 * check would return "no local work" for precisely the session that has the most
 * to lose. So the destructive path is not used at all.
 *
 * What is left is `git pull --ff-only origin <sessionId>` — it cannot discard
 * anything, and it fails cleanly (swallowed below as `repo_refreshed: false`)
 * for a branch that was never pushed. It does NOT bring the base branch's
 * commits into the workspace. That is a real limit and it is the correct one:
 * moving a live session onto a new base is a merge with conflicts, not a side
 * effect of a button labelled "Reload config".
 *
 * None of this weakens the reload's actual job. The agent config is compiled
 * server-side from the git MIRROR at the session's ref; it never came from the
 * sandbox's working tree, so it updates either way.
 *
 * `restart=0`: the config push right after restarts opencode anyway, and
 * restarting twice doubles the boot cost and the window where the box 503s.
 */
async function refreshSandboxWorkspace(sessionId: string): Promise<{
  ok: boolean;
  commitSha: string | null;
  configDirSynced: boolean | null;
  configDirReason?: string;
}> {
  const unreachable = { ok: false, commitSha: null, configDirSynced: null };
  try {
    const [row] = await db
      .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.status, 'active')))
      .limit(1);
    const serviceKey = (row?.config as Record<string, unknown> | null)?.serviceKey;
    if (!row?.externalId || typeof serviceKey !== 'string') return unreachable;

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    // `config_dir=1` is the half that makes a reload change behaviour — see the
    // comment above. Sent unconditionally: a daemon built before it shipped just
    // ignores the query parameter and answers without `config_dir`, which reads
    // back as `null` ("could not tell") rather than `false`.
    const res = await fetch(`${url.replace(/\/$/, '')}/kortix/refresh?restart=0&config_dir=1`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return unreachable;
    // The daemon answers `{repo: {before, after}}` — there is no `repo.commit`,
    // so the old read was always undefined and `commit_sha` always reported the
    // PRE-reload value, making a successful pull look like a no-op.
    const body = (await res.json()) as {
      repo?: { after?: { commit?: unknown } };
      config_dir?: { synced?: unknown; skipped?: unknown };
    };
    const commit = body.repo?.after?.commit;
    const dir = body.config_dir;
    return {
      ok: true,
      commitSha: typeof commit === 'string' ? commit : null,
      configDirSynced: typeof dir?.synced === 'boolean' ? dir.synced : null,
      ...(typeof dir?.skipped === 'string' ? { configDirReason: dir.skipped } : {}),
    };
  } catch {
    // A failed pull is not a failed reload: the config recompiles from the git
    // MIRROR, not the sandbox's working tree, so the agent still updates.
    return unreachable;
  }
}
