import { and, eq } from 'drizzle-orm';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { TimeoutError, withTimeout } from '../../shared/with-timeout';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import type { GitBackedProject } from '../git';
import { resolveCommitSha } from '../git/commits';
import { refreshMirror } from '../git/mirror';
import { opencodeConfigDirChangedBetween } from '../git/opencode-config-dir';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from './compile-agent-config';
import {
  hasConfigReleaseCapability,
  parseDaemonConfigReport,
  type DaemonConfigReport,
} from './session-config-release';
import {
  parseDaemonRuntimeReport,
  type DaemonRuntimeReport,
} from '../../runtime-assets/daemon-runtime-report';
import {
  repositoryAccessFromSessionMetadata,
} from './session-sandbox-metadata';
import { parseActualRuntime, UNREPORTED_ACTUAL_RUNTIME, type ActualRuntimeDocument } from '../../runtime-convergence/actual';

const SANDBOX_SERVICE_PORT = 8000;

/** The daemon's service endpoint for a session's active sandbox, or null. */
export async function sandboxServiceEndpoint(sessionId: string): Promise<SandboxEndpoint | null> {
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

export type SandboxEndpoint = { baseUrl: string; headers: Record<string, string> };

/**
 * The two daemon calls `readSandboxConfigState` makes. The orchestrator's
 * `SessionReloadDeps` satisfies this structurally; tests may stub just these.
 */
export interface SandboxStateReadDeps {
  endpoint: (sessionId: string) => Promise<SandboxEndpoint | null>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const defaultSandboxStateDeps: SandboxStateReadDeps = {
  endpoint: sandboxServiceEndpoint,
  fetch: (url, init) => fetch(url, init),
};

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
  /**
   * The health `runtime` block — which runtime-asset bytes this box has on disk,
   * and whether the supervisor latched updates off after a rollback.
   *
   * NOT gated on `configReleases`: the two are independent. A daemon can serve
   * `runtime` without `config.release.v1`, and `pinned: true` — a box that
   * crash-looped an update and will not self-heal — must reach the control plane
   * regardless of which config path the project is on.
   */
  runtime: DaemonRuntimeReport | null;
  /**
   * The health `runtime_truth` block (Rule 1, the runtime-convergence contract (PR #7785))
   * — the box's ACTUAL runtime document. Tolerant of a daemon that predates it
   * entirely: {@link UNREPORTED_ACTUAL_RUNTIME}, never null and never a crash,
   * because "this box reports nothing" is itself a diff (`unknown`), not the
   * absence of one. Independent of `configReleases`/`runtime` above for the
   * same reason those two are independent of each other.
   */
  runtimeTruth: ActualRuntimeDocument;
}

const UNREACHABLE_STATE: SandboxConfigState = {
  etag: null,
  commitSha: null,
  configDirSha: null,
  reachable: false,
  turnInFlight: null,
  configReleases: false,
  release: null,
  runtime: null,
  runtimeTruth: UNREPORTED_ACTUAL_RUNTIME,
};

/** What the sandbox says it is running right now. */
export async function readSandboxConfigState(
  input: {
    sessionId: string;
    /** Also ask whether a turn is running. Costs a call into opencode, so opt-in. */
    includeTurnState?: boolean;
  },
  deps: SandboxStateReadDeps = defaultSandboxStateDeps,
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
      runtime?: unknown;
      runtime_truth?: unknown;
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
      runtime: parseDaemonRuntimeReport(body.runtime),
      runtimeTruth: parseActualRuntime(body.runtime_truth),
    };
  } catch {
    return UNREACHABLE_STATE;
  }
}

/**
 * Wall-clock budget for one `latestAgentConfigEtag` resolution, and for the
 * other mirror-reading stages of the same GET /config request. The mirror fetch
 * it can block on has a 30s per-op timeout and retries 3 times, so an unbounded
 * wait outran the 25s request deadline on every poll against a slow mirror
 * (KRTX-818). The budget must stay comfortably under that deadline; GET /config
 * spends it across its stages, so a slow fetch degrades to `stale: null`
 * ("could not tell") instead of a 503.
 */
export const LATEST_ETAG_BUDGET_MS = 20_000;

/**
 * The etag this session WOULD get if it were reloaded right now.
 *
 * Recompiles from the session's own ref; delivers nothing.
 *
 * "Latest" has to mean latest. The git mirror is TTL-cached (60s by default)
 * and every read through `readRepoFile` / `resolveCommitSha` takes the warm
 * hit. On an ordinary endpoint that is right. On THIS one it is self-defeating:
 * the whole feature is "I merged a change, get it into my session", and the
 * merge is by definition seconds old. A TTL-served read recompiled the
 * PRE-merge manifest and answered "already up to date" — the exact confusion
 * the reload exists to end, moved one layer up.
 *
 * So the compile reads force a REF-scoped refresh
 * (`CompileReadOptions.forceRefresh`): `readManifestFromRepo` proves the
 * session's ref against the remote with one `git ls-remote` (~1s) and only runs
 * the whole-mirror fetch when the branch actually moved. That is exact
 * freshness for every read this request makes (they all read the session's base
 * ref) at a fraction of the old cost, which paid a full `git fetch --prune` on
 * every poll.
 *
 * The whole resolution is bounded (`LATEST_ETAG_BUDGET_MS`): on a mirror whose
 * fetch is slow the old unbounded wait outran the request deadline and 503'd
 * the poll; the bounded wait answers `null` and `stale` reads null ("could not
 * tell") — the state every client of this route already handles.
 */
export async function latestAgentConfigEtag(
  input: {
    projectId: string;
    accountId: string;
    sessionId?: string;
    baseRef?: string | null;
  },
  /**
   * Wall-clock budget for the whole resolution. Callers that coordinate several
   * mirror-reading stages under one request deadline (GET /config) pass the
   * budget that is left; everyone else takes the default.
   */
  opts?: { budgetMs?: number },
): Promise<string | null> {
  // The ref-scoped force replaces the old `invalidateProjectMirror` here:
  // invalidating dropped the mirror's freshness stamp, which made the LATER
  // unforced reads in the same request (agent files, the config-dir compare,
  // the desired release) pay their own full fetch. The proof keeps the stamp
  // intact, so one request does at most one network op.
  // The WHOLE resolution — the row reads and the compile — races the budget:
  // a slow database or a slow mirror both mean "cannot be told", and either
  // one unbounded is a 503 on the next poll.
  const compiled = await withTimeout(
    (async () => {
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
      return (
        !repositoryAccessFromSessionMetadata(session?.metadata) && session?.agentName
          ? resolveSelectedAgentConfigForSession(gitProject, session.agentName, input.baseRef, {
              forceRefresh: true,
            })
          : resolveCompiledAgentConfigForSession(gitProject, input.baseRef, { forceRefresh: true })
      ).catch(() => null);
    })(),
    opts?.budgetMs ?? LATEST_ETAG_BUDGET_MS,
    'latest agent-config etag',
  ).catch((error) => {
    if (error instanceof TimeoutError) {
      logger.warn(
        '[session-config] latest etag unresolved within its budget; answering unknown',
        { budget_ms: opts?.budgetMs ?? LATEST_ETAG_BUDGET_MS },
      );
      return null;
    }
    throw error;
  });
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
