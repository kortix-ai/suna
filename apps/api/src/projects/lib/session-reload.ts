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
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { invalidateProjectMirror, type GitBackedProject } from '../git';
import { resolveCommitSha } from '../git/commits';
import { refreshMirror } from '../git/mirror';
import { opencodeConfigDirChangedBetween } from '../git/opencode-config-dir';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from './compile-agent-config';
import { recordDaemonConfigReport } from '../../config-releases/quarantine';
import { sessionUsesCurrentRepository } from './repository-generation';
import { pushSessionAgentConfigToSandbox } from './sandbox-env-sync';
import {
  hasConfigReleaseCapability,
  parseConvergeResponse,
  parseDaemonConfigReport,
  toSessionConfigRelease,
  type ConvergeOutcome,
  type DaemonConfigReport,
  type DaemonConvergeResponse,
  type SessionConfigRelease,
} from './session-config-release';
import {
  repositoryAccessFromSessionMetadata,
} from './session-sandbox-metadata';

const SANDBOX_SERVICE_PORT = 8000;
/** A competing refresh is a fetch plus a fast-forward: seconds, not minutes. */
const REFRESH_BUSY_RETRIES = 5;
const REFRESH_BUSY_DELAY_MS = 3_000;
/** A convergence can hold the slot for the 90 s proven check: 40 × 3 s. */
const CONVERGE_BUSY_RETRIES = 40;

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

/**
 * Does the box need the push — and the opencode restart that comes with it?
 *
 * Two independent reasons, because the config has two homes. Files that were
 * just brought forward are read only at opencode's spawn, so they need the
 * restart even when the compiled etag did not move (a skill body is not part of
 * it). And a moved etag needs the push even when the files were kept: governance
 * — connectors, secrets, scope — lives in the compiled config alone.
 *
 * An unknown etag on either side is NOT a reason. "Could not tell" is not
 * permission to restart a runtime nobody asked to restart.
 */
export function configNeedsPush(input: {
  agentFiles: ReloadAgentFiles;
  runningEtag: string | null;
  latestEtag: string | null;
}): boolean {
  if (input.agentFiles === 'updated') return true;
  return (
    input.runningEtag !== null &&
    input.latestEtag !== null &&
    input.runningEtag !== input.latestEtag
  );
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
  /**
   * How the box applied the new config, when it said.
   *
   * `kept-old` is the verified swap declining: the daemon booted the new
   * opencode, it never started serving, so the previous one was left running.
   * The push landed and the config did NOT take — which is a FAILED reload with
   * a healthy session, a combination `applied` alone cannot express.
   *
   * `null` means the box did not say (a daemon older than the verified swap, or
   * no reload was needed) — never "it worked".
   */
  opencode_reload: 'disposed' | 'restarted' | 'kept-old' | null;
  /**
   * Did the reload stop a turn the user was waiting on?
   *
   * Reported by the box AFTER the fact — it is true only when the finalize
   * actually aborted an incomplete turn. A pre-flight "is a turn running?"
   * check would race the turn finishing and tell people their work was
   * interrupted when it completed normally.
   *
   * `null` = the box did not say. Never render that as "nothing was
   * interrupted"; say nothing instead.
   */
  turn_ended: boolean | null;
  /** Present when nothing was applied. */
  reason?: string;
  /**
   * The config release state after the reload (spec, "`GET /config`,
   * extended"). Present only for a daemon with `config.release.v1`. Same
   * shape as `SessionConfigRelease` in `@kortix/sdk`.
   */
  release?: SessionConfigRelease;
  /** The converge `outcome`, or null when the daemon did not answer. Present with `release`. */
  release_outcome?: ConvergeOutcome | null;
  /**
   * Which path the reload took: `release` sent `POST /kortix/config/converge`;
   * `legacy` sent only `POST /kortix/refresh?restart=0` plus the compiled
   * governance push. Absent when the box was not reached.
   */
  config_path?: 'release' | 'legacy';
}

/** Server-observed boundaries emitted by the streamed reload route. */
export type SessionReloadPhase =
  | 'checking-session'
  | 'refreshing-workspace'
  | 'compiling-config'
  | 'applying-config'
  | 'confirming-config';

/**
 * One sentence for the reload, and the only place that decides whether we are
 * allowed to say the agent changed.
 *
 * The old copy — "Reloaded. The next prompt runs the new config." — was
 * unconditional, and measurably false whenever the agent's `.md` files were not
 * brought forward: the etag moved, opencode kept reading the working tree, and
 * the user was told the opposite.
 */
/**
 * The sentence appended when the reload STOPPED work someone was waiting on.
 *
 * The reload restarts the runtime, so the command has to report when it ends a
 * turn. Until now the turn simply ended —
 * cleanly, so nothing spun, but silently, so it looked like the agent gave up.
 *
 * Only appended on a definite `true`. `null` means the box could not tell, and
 * inventing "your turn was stopped" for a turn that finished normally is worse
 * than saying nothing.
 */
const TURN_ENDED_SENTENCE =
  'The turn that was running was stopped — send a message to continue.';

function withTurnNotice(sentence: string, result: SessionReloadResult): string {
  return result.turn_ended === true ? `${sentence} ${TURN_ENDED_SENTENCE}` : sentence;
}

/**
 * A fallback outranks every other sentence: the box runs a config other than
 * the one it was assigned, and the CLI prints only this text.
 */
function fallbackSentence(result: SessionReloadResult): string | null {
  const reason = result.release?.fallback_reason;
  if (!reason) return null;
  return `The new config failed to load: ${reason.replace(/\.$/, '')}. An earlier config still runs this session.`;
}

const SESSION_FILES_SENTENCE =
  "This session runs its own config files: it has edits under its config dir, so the base branch's config files are not applied. Compiled governance still comes from the base branch.";

export function reloadDetail(result: SessionReloadResult): string {
  const fallback = fallbackSentence(result);
  if (fallback) return withTurnNotice(fallback, result);
  if (result.release?.mode === 'session-files' && result.agent_files === 'kept-yours') {
    return withTurnNotice(SESSION_FILES_SENTENCE, result);
  }
  if (!result.applied) return `Nothing to apply: ${result.reason ?? 'unchanged'}.`;
  return withTurnNotice(reloadOutcomeSentence(result), result);
}

function reloadOutcomeSentence(result: SessionReloadResult): string {
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
  if (result.release?.fallback_reason) return true;
  if (!result.applied) return true;
  return result.agent_files === 'kept-yours' || result.agent_files === 'unknown';
}

/** The daemon's service endpoint for a session's active sandbox, or null. */
async function sandboxServiceEndpoint(sessionId: string): Promise<SandboxEndpoint | null> {
  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.status, 'active')))
    .limit(1);
  const serviceKey = (row?.config as Record<string, unknown> | null)?.serviceKey;
  if (!row?.externalId || typeof serviceKey !== 'string') return null;
  const { url, headers } = await resolveSandboxIngress(row.externalId, {
    port: SANDBOX_SERVICE_PORT,
    transport: 'http',
  });
  return {
    baseUrl: url.replace(/\/$/, ''),
    headers: { ...(headers as Record<string, string>), Authorization: `Bearer ${serviceKey}` },
  };
}

type SandboxEndpoint = { baseUrl: string; headers: Record<string, string> };

/**
 * Seams for tests. Production uses the defaults: the session's active sandbox
 * row, the global `fetch`, the compiled-governance push, and the etag compile.
 */
export interface SessionReloadDeps {
  endpoint: (sessionId: string) => Promise<SandboxEndpoint | null>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  pushGovernance: typeof pushSessionAgentConfigToSandbox;
  latestEtag: typeof latestAgentConfigEtag;
  /** Wait between busy retries. */
  sleep: (ms: number) => Promise<void>;
  /** Record a daemon's failed and proven releases for the project quarantine. */
  recordReport: typeof recordDaemonConfigReport;
  /** False for a session from a previous repository generation. */
  usesCurrentRepository: (projectId: string, sessionId: string) => Promise<boolean>;
}

/** The reload `reason` for a session from a previous repository generation. */
export const PREVIOUS_REPOSITORY_REASON = 'session belongs to a previous repository';

async function sessionUsesCurrentRepositoryById(projectId: string, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ projectMetadata: projects.metadata, sessionMetadata: projectSessions.metadata })
    .from(projectSessions)
    .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  // No row: nothing to protect; the later steps find no sandbox either.
  if (!row) return true;
  return sessionUsesCurrentRepository(
    row.projectMetadata as Record<string, unknown> | null,
    row.sessionMetadata as Record<string, unknown> | null,
  );
}

function defaultReloadDeps(): SessionReloadDeps {
  return {
    endpoint: sandboxServiceEndpoint,
    fetch: (url, init) => fetch(url, init),
    pushGovernance: pushSessionAgentConfigToSandbox,
    latestEtag: latestAgentConfigEtag,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    recordReport: recordDaemonConfigReport,
    usesCurrentRepository: sessionUsesCurrentRepositoryById,
  };
}

export interface SandboxConfigState {
  etag: string | null;
  commitSha: string | null;
  /** Base commit the box's config dir represents; null before its first sync. */
  configDirSha: string | null;
  reachable: boolean;
  /** `null` when the box could not tell us — see the reload gate. */
  turnInFlight: boolean | null;
  /** The daemon lists `config.release.v1` in `capabilities`. */
  configReleases: boolean;
  /** The health `config` block. Null for a daemon without config releases. */
  release: DaemonConfigReport | null;
}

const UNREACHABLE_STATE: SandboxConfigState = {
  etag: null,
  commitSha: null,
  configDirSha: null,
  reachable: false,
  turnInFlight: null,
  configReleases: false,
  release: null,
};

/** What the sandbox says it is running right now. */
export async function readSandboxConfigState(
  input: {
    sessionId: string;
    /** Also ask whether a turn is running. Costs a call into opencode, so opt-in. */
    includeTurnState?: boolean;
  },
  deps: SessionReloadDeps = defaultReloadDeps(),
): Promise<SandboxConfigState> {
  try {
    const endpoint = await deps.endpoint(input.sessionId);
    if (!endpoint) return UNREACHABLE_STATE;
    const res = await deps.fetch(`${endpoint.baseUrl}/kortix/health${input.includeTurnState ? '?turn=1' : ''}`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return UNREACHABLE_STATE;
    const body = (await res.json()) as {
      agent_config_etag?: unknown;
      commit_sha?: unknown;
      config_dir_sha?: unknown;
      turn_in_flight?: unknown;
      capabilities?: unknown;
      config?: unknown;
    };
    const configReleases = hasConfigReleaseCapability(body.capabilities);
    return {
      etag: typeof body.agent_config_etag === 'string' ? body.agent_config_etag : null,
      commitSha: typeof body.commit_sha === 'string' ? body.commit_sha : null,
      configDirSha: typeof body.config_dir_sha === 'string' ? body.config_dir_sha : null,
      reachable: true,
      // Tri-state on purpose: `true` busy, `false` idle, `null` could not tell.
      // Absent (the caller did not ask) is also null.
      turnInFlight:
        body.turn_in_flight === true ? true : body.turn_in_flight === false ? false : null,
      configReleases,
      release: configReleases ? parseDaemonConfigReport(body.config) : null,
    };
  } catch {
    return UNREACHABLE_STATE;
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
  sessionId?: string;
  baseRef?: string | null;
}): Promise<string | null> {
  const [[project], [session]] = await Promise.all([
    db
      .select({
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        manifestPath: projects.manifestPath,
      })
      .from(projects)
      .where(and(eq(projects.projectId, input.projectId), eq(projects.accountId, input.accountId)))
      .limit(1),
    input.sessionId
      ? db
          .select({
            agentName: projectSessions.agentName,
            metadata: projectSessions.metadata,
          })
          .from(projectSessions)
          .where(eq(projectSessions.sessionId, input.sessionId))
          .limit(1)
      : Promise.resolve([]),
  ]);
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
  const compiled = await (
    !repositoryAccessFromSessionMetadata(session?.metadata) &&
    session?.agentName
      ? resolveSelectedAgentConfigForSession(gitProject, session.agentName, input.baseRef)
      : resolveCompiledAgentConfigForSession(gitProject, input.baseRef)
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

/**
 * One verdict from the two things a session's config is made of.
 *
 * `etagStale` is the compiled agent config (governance, agent frontmatter).
 * `filesStale` is the config dir on disk (skills, tools, plugins, agent bodies).
 * Either one alone is enough to be stale.
 *
 * An unknown `filesStale` does NOT poison a known etag: a daemon built before
 * `config_dir_sha` shipped never reports it, and those boxes must keep the
 * answer they had. An unknown etag still yields `null` unless the files are
 * known to be stale — never `false`, which would read as "up to date".
 */
export function combineConfigStaleness(
  etagStale: boolean | null,
  filesStale: boolean | null,
): boolean | null {
  if (etagStale === true || filesStale === true) return true;
  return etagStale;
}

/**
 * Has the base branch's config dir moved past what this box holds?
 *
 * `configDirSha` when the box has synced at least once, else the commit it
 * booted from. `null` when the mirror cannot answer — most often a session that
 * committed without pushing, whose HEAD only the box has.
 */
export async function isSessionConfigDirStale(input: {
  project: GitBackedProject;
  baseRef: string;
  configDirSha: string | null;
  commitSha: string | null;
}): Promise<boolean | null> {
  const boxSha = input.configDirSha ?? input.commitSha;
  if (!boxSha) return null;
  try {
    const mirror = await refreshMirror(input.project);
    const tipSha = await resolveCommitSha(input.project, input.baseRef);
    return await opencodeConfigDirChangedBetween(mirror, input.project, boxSha, tipSha);
  } catch {
    return null;
  }
}

export async function reloadSessionConfig(input: {
  projectId: string;
  accountId: string;
  sessionId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath?: string | null;
  baseRef?: string | null;
  /**
   * Also fast-forward the session's own branch. Default true. It does NOT gate
   * the config convergence, which never touches the checkout and always runs.
   */
  refreshRepo?: boolean;
  /** Reload even if a turn is running. It will be ended. */
  force?: boolean;
  /**
   * Skip the push — and the opencode restart it costs — when the box is already
   * current. For callers nobody asked: the wake-time convergence runs on every
   * resume, and a current box must not pay a runtime restart for it. The reload
   * button leaves this unset, because a person who asked for a reload gets one.
   */
  onlyIfStale?: boolean;
  /** Optional live progress sink. The JSON route leaves it unset. */
  onPhase?: (phase: SessionReloadPhase) => void;
}, deps: SessionReloadDeps = defaultReloadDeps()): Promise<SessionReloadResult> {
  // Before anything reads the mirror — the base_sha resolve, the compile inside
  // the push, the etag compare. See `invalidateProjectMirror` above: a reload
  // served from a 60s cache can apply the pre-merge config and report success.
  invalidateProjectMirror(input.projectId);

  input.onPhase?.('checking-session');
  // Spec, "Repository replacement": a previous-repository session keeps the
  // config it runs. Nothing from the current repository reaches it: no
  // converge, no refresh, no governance push.
  if (!(await deps.usesCurrentRepository(input.projectId, input.sessionId))) {
    return {
      applied: false,
      previous_etag: null,
      etag: null,
      repo_refreshed: false,
      commit_sha: null,
      agent_files: 'unknown',
      opencode_reload: null,
      turn_ended: null,
      reason: PREVIOUS_REPOSITORY_REASON,
    };
  }
  const before = await readSandboxConfigState(
    {
      sessionId: input.sessionId,
      includeTurnState: input.force !== true,
    },
    deps,
  );
  if (!before.reachable) {
    return {
      applied: false,
      previous_etag: null,
      etag: null,
      repo_refreshed: false,
      commit_sha: null,
      agent_files: 'unknown',
      opencode_reload: null,
      turn_ended: null,
      reason: 'no reachable sandbox',
    };
  }

  await deps.recordReport({ projectId: input.projectId, sessionId: input.sessionId, report: before.release });
  // Present for a daemon with `config.release.v1`: the state it reported
  // before this reload.
  const releaseBefore = before.configReleases && before.release ? toSessionConfigRelease(before.release) : null;
  const releaseFields = (
    release: SessionConfigRelease | null,
    outcome: ConvergeOutcome | null,
  ): Pick<SessionReloadResult, 'release' | 'release_outcome' | 'config_path'> =>
    before.configReleases
      ? { ...(release ? { release } : {}), release_outcome: outcome, config_path: 'release' }
      : { config_path: 'legacy' };

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
      opencode_reload: null,
      turn_ended: null,
      reason:
        before.turnInFlight === true
          ? 'session is mid-turn'
          : 'could not confirm the session is idle',
      ...releaseFields(releaseBefore, null),
    };
  }

  const pullRepo = input.refreshRepo !== false;
  let repoRefreshed = false;
  let commitSha = before.commitSha;

  // ── Capability gate (spec, "Capability gate") ────────────────────────────
  // A daemon with `config.release.v1` converges itself: it fetches the
  // descriptor from the API, which carries the compiled governance, so no
  // separate governance push and no `config_dir=1`.
  if (before.configReleases) {
    if (pullRepo) {
      input.onPhase?.('refreshing-workspace');
      const refreshed = await refreshSandboxWorkspace(input.sessionId, { pullRepo }, deps);
      repoRefreshed = refreshed.ok;
      commitSha = refreshed.commitSha ?? commitSha;
    }
    input.onPhase?.('applying-config');
    const converged = await convergeSandboxConfig(input.sessionId, deps);
    input.onPhase?.('confirming-config');
    if (!converged) {
      return {
        applied: false,
        previous_etag: before.etag,
        etag: before.etag,
        repo_refreshed: repoRefreshed,
        commit_sha: commitSha,
        agent_files: 'unknown',
        opencode_reload: null,
        turn_ended: null,
        reason: 'the sandbox did not answer the config convergence',
        ...releaseFields(releaseBefore, null),
      };
    }
    await deps.recordReport({ projectId: input.projectId, sessionId: input.sessionId, report: converged.config });
    // Read the etag the box runs now: the release carried the governance.
    const after = converged.reload ? await readSandboxConfigState({ sessionId: input.sessionId }, deps) : null;
    return {
      ...convergeToReloadResult(converged, { previousEtag: before.etag, etagAfter: after?.etag ?? null }),
      repo_refreshed: repoRefreshed,
      commit_sha: commitSha,
      ...releaseFields(toSessionConfigRelease(converged.config), converged.outcome),
    };
  }

  // ── A daemon without config releases ────────────────────────────────────
  // Only the plain refresh. It stages the new daemon through runtime assets.
  // Never `config_dir=1`: the old handler writes into `/workspace`.
  input.onPhase?.('refreshing-workspace');
  const refreshed = await refreshSandboxWorkspace(input.sessionId, { pullRepo }, deps);
  repoRefreshed = pullRepo && refreshed.ok;
  commitSha = refreshed.commitSha ?? commitSha;

  // An old daemon cannot report its agent files: the files converge after its
  // self-update, on the convergence scheduler's 6- and 7-minute attempts.
  const agentFiles: ReloadAgentFiles = 'unknown';
  if (input.onlyIfStale) {
    const latestEtag = await deps.latestEtag({
      projectId: input.projectId,
      accountId: input.accountId,
      sessionId: input.sessionId,
      baseRef: input.baseRef,
    });
    if (!configNeedsPush({ agentFiles, runningEtag: before.etag, latestEtag })) {
      return {
        applied: false,
        previous_etag: before.etag,
        etag: before.etag,
        repo_refreshed: repoRefreshed,
        commit_sha: commitSha,
        agent_files: agentFiles,
        opencode_reload: null,
        turn_ended: null,
        reason: 'already current',
        ...releaseFields(null, null),
      };
    }
  }

  const push = await deps.pushGovernance({
    projectId: input.projectId,
    sessionId: input.sessionId,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch,
    manifestPath: input.manifestPath,
    baseRef: input.baseRef,
    onPhase: input.onPhase,
  });

  input.onPhase?.('confirming-config');
  const latest = await deps.latestEtag({
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: input.sessionId,
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
    agent_files: agentFiles,
    opencode_reload: push.opencodeReload ?? null,
    turn_ended: push.opencodeTurnEnded ?? null,
    ...(push.applied
      ? push.opencodeReload === 'kept-old'
        ? {
            reason:
              'the new opencode did not start, so the session kept the config it was already running',
          }
        : {}
      : { reason: push.reason ?? 'agent config unchanged' }),
    ...releaseFields(null, null),
  };
}

/**
 * Map a converge response (spec, "Converge response") onto the reload result.
 * The `release`, `repo_refreshed`, and `commit_sha` fields are the caller's.
 */
export function convergeToReloadResult(
  converged: DaemonConvergeResponse,
  etags: { previousEtag: string | null; etagAfter: string | null },
): Omit<SessionReloadResult, 'repo_refreshed' | 'commit_sha'> {
  const reloaded = converged.reload !== null;
  const common = {
    previous_etag: etags.previousEtag,
    etag: reloaded ? (etags.etagAfter ?? etags.previousEtag) : etags.previousEtag,
    opencode_reload: reloaded ? ('restarted' as const) : null,
    turn_ended: converged.reload?.turn_ended ?? null,
  };
  const failedId = converged.config.failed_release_id?.slice(0, 12);
  switch (converged.outcome) {
    case 'applied':
      return { ...common, applied: true, agent_files: 'updated' };
    case 'unchanged':
      return { ...common, applied: false, agent_files: 'already-current', reason: 'already current' };
    case 'session-files':
      return reloaded
        ? { ...common, applied: true, agent_files: 'kept-yours' }
        : { ...common, applied: false, agent_files: 'kept-yours', reason: 'this session runs its own config files' };
    case 'declined':
      return {
        ...common,
        applied: false,
        agent_files: 'unknown',
        opencode_reload: 'kept-old',
        reason:
          converged.reason ??
          converged.config.fallback_reason ??
          'the new config did not pass its proven check, so the session kept the config it was already running',
      };
    case 'quarantined':
      return {
        ...common,
        applied: false,
        agent_files: 'unknown',
        reason:
          converged.reason ??
          `release ${failedId ?? 'assigned'} already failed on this sandbox, so the session keeps the config it runs`,
      };
    case 'failed':
      return {
        ...common,
        applied: false,
        agent_files: 'unknown',
        reason: converged.reason ?? converged.config.fallback_reason ?? 'config convergence failed',
      };
  }
}

/**
 * `POST /kortix/config/converge` on a daemon with `config.release.v1`. The
 * daemon fetches the descriptor from the API itself; this request has no
 * body. Null when the box did not answer with a converge response.
 *
 * 409 = a convergence already runs (single flight). It is over in seconds to
 * ~90 s (the proven-check budget), so it is waited out.
 */
async function convergeSandboxConfig(
  sessionId: string,
  deps: SessionReloadDeps,
): Promise<DaemonConvergeResponse | null> {
  try {
    const endpoint = await deps.endpoint(sessionId);
    if (!endpoint) return null;
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await deps.fetch(`${endpoint.baseUrl}/kortix/config/converge`, {
        method: 'POST',
        headers: endpoint.headers,
        // Download, verify, and the 90 s proven check fit well inside this.
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status !== 409 || attempt >= CONVERGE_BUSY_RETRIES) break;
      await deps.sleep(REFRESH_BUSY_DELAY_MS);
    }
    if (!res.ok) return null;
    return parseConvergeResponse(await res.json());
  } catch {
    return null;
  }
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
 * NEVER `config_dir=1` (spec, "Capability gate"). On a daemon without
 * `config.release.v1` that handler checks the base config out into
 * `/workspace`; on a capable daemon it is an alias for converge, which the
 * reload sends explicitly.
 *
 * `restart=0`: the config push right after restarts opencode anyway, and
 * restarting twice doubles the boot cost and the window where the box 503s.
 */
async function refreshSandboxWorkspace(
  sessionId: string,
  opts: { pullRepo: boolean },
  deps: SessionReloadDeps,
): Promise<{ ok: boolean; commitSha: string | null }> {
  const unreachable = { ok: false, commitSha: null };
  try {
    const endpoint = await deps.endpoint(sessionId);
    if (!endpoint) return unreachable;
    // 409 = another refresh holds the daemon's single-flight slot. After a
    // resume or restart that is the runtime-asset poke fired alongside this one
    // (`scheduleSandboxRuntimeRefresh`), and it is over in seconds. Reading it as
    // "unreachable" reports a failed pull for a box that was only busy for a
    // moment, so wait it out instead.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      // `repo=0` when the caller did not ask for the session branch to be
      // pulled. The refresh still stages runtime assets, which is how an old
      // daemon receives its replacement.
      res = await deps.fetch(`${endpoint.baseUrl}/kortix/refresh?restart=0${opts.pullRepo ? '' : '&repo=0'}`, {
        method: 'POST',
        headers: endpoint.headers,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status !== 409 || attempt >= REFRESH_BUSY_RETRIES) break;
      await deps.sleep(REFRESH_BUSY_DELAY_MS);
    }
    if (!res.ok) return unreachable;
    // The daemon answers `{repo: {before, after}}` — there is no `repo.commit`,
    // so the old read was always undefined and `commit_sha` always reported the
    // PRE-reload value, making a successful pull look like a no-op.
    const body = (await res.json()) as { repo?: { after?: { commit?: unknown } } };
    const commit = body.repo?.after?.commit;
    return { ok: true, commitSha: typeof commit === 'string' ? commit : null };
  } catch {
    // A failed pull is not a failed reload: the config recompiles from the git
    // MIRROR, not the sandbox's working tree, so the agent still updates.
    return unreachable;
  }
}
