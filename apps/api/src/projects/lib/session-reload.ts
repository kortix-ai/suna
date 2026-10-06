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
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { invalidateProjectMirror } from '../git';
import { projectConfigReleasesEnabled } from '../../config-releases/enabled';
import { recordDaemonConfigReport } from '../../config-releases/quarantine';
import { pushSessionAgentConfigToSandbox } from './sandbox-env-sync';
import {
  parseConvergeResponse,
  toSessionConfigRelease,
  type ConvergeOutcome,
  type DaemonConvergeResponse,
  type SessionConfigRelease,
} from './session-config-release';
import {
  type SandboxEndpoint,
  sandboxServiceEndpoint,
  combineConfigStaleness,
  isSessionConfigDirStale,
  latestAgentConfigEtag,
  readSandboxConfigState,
} from './session-reload-staleness';
import {
  type ReloadAgentFiles,
  type SessionReloadPhase,
  type SessionReloadResult,
  type WorkspaceCheckout,
  classifyAgentFiles,
  classifyWorkspaceCheckout,
  configNeedsPush,
} from './session-reload-result';

// The result/sentence model and the staleness readers live in sibling modules;
// this path re-exports their public surface so every existing importer resolves
// unchanged.
export {
  type ReloadAgentFiles,
  type SessionReloadPhase,
  type SessionReloadResult,
  classifyAgentFiles,
  configNeedsPush,
  reloadDetail,
  reloadNeedsAttention,
} from './session-reload-result';
export {
  type SandboxConfigState,
  LATEST_ETAG_BUDGET_MS,
  latestAgentConfigEtag,
  isConfigStale,
  combineConfigStaleness,
  isSessionConfigDirStale,
  readSandboxConfigState,
} from './session-reload-staleness';

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
  /** The project's `config_releases` flag. False ⇒ the pre-release path. */
  configReleasesEnabled: (projectId: string) => Promise<boolean>;
  /**
   * Repair the turn a config swap took with it.
   *
   * The daemon retires the OpenCode process that was writing a turn. That
   * process emits neither `session.idle` nor `session.error`, so the ledger row
   * it opened would stay open for ever and the client that sent the prompt gets
   * a bare `HTTP 503` with its dedupe claim still held. This settles those rows
   * `runtime_gone` and hands each prompt back to the redelivery path — the SAME
   * repair a provider restart takes, not a second one.
   */
  repairOrphanedTurn: (input: { sessionId: string; orphanedMessageId: string | null }) => Promise<void>;
}

function defaultReloadDeps(): SessionReloadDeps {
  return {
    endpoint: sandboxServiceEndpoint,
    fetch: (url, init) => fetch(url, init),
    pushGovernance: pushSessionAgentConfigToSandbox,
    latestEtag: latestAgentConfigEtag,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    recordReport: recordDaemonConfigReport,
    configReleasesEnabled: projectConfigReleasesEnabled,
    repairOrphanedTurn: repairTurnOrphanedBySwap,
  };
}

/**
 * Settle and redeliver the turn a config swap retired.
 *
 * DYNAMIC import on purpose, for the reason `turn-start-convergence.ts` gives
 * for its own: a static edge would pull the whole session-lifecycle engine into
 * every module graph that reaches a reload. Nothing needs it before this call —
 * it runs only when the daemon reported that its swap orphaned a turn.
 */
async function repairTurnOrphanedBySwap(input: {
  sessionId: string;
  orphanedMessageId: string | null;
}): Promise<void> {
  const [row] = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.sessionId, input.sessionId), eq(sessionSandboxes.status, 'active')))
    .limit(1);
  if (!row?.sandboxId) return;
  const { recoverTurnsAfterRuntimeRestart } = await import(
    '../session-lifecycle/runtime-restart-recovery'
  );
  const result = await recoverTurnsAfterRuntimeRestart({
    sandboxId: row.sandboxId,
    sessionId: input.sessionId,
    externalId: row.externalId,
    // The box is up and the prompt's sender is waiting: redeliver now, do not
    // park it. `MAX_PROMPT_REDELIVERIES` bounds any loop.
    hold: false,
  });
  console.log('[session-reload] a config swap orphaned a turn; settled and redelivered', {
    session_id: input.sessionId,
    orphaned_message_id: input.orphanedMessageId,
    settled: result.lost.length,
    redelivered: result.redeliveries.length,
  });
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

  // CHOKEPOINT — the `config_releases` flag for the reload path. Off ⇒ the daemon's own
  // capability is ignored and this reload takes the pre-release path: the
  // plain refresh plus the compiled-governance push, an etag-based result,
  // and no `release` block for the CLI or the web to render. Nothing is
  // recorded in the quarantine ledger either, because no release is assigned.
  const releasesEnabled = await deps.configReleasesEnabled(input.projectId);
  const capable = releasesEnabled && before.configReleases;

  if (releasesEnabled) {
    await deps.recordReport({ projectId: input.projectId, sessionId: input.sessionId, report: before.release });
  }
  // Present for a daemon with `config.release.v1`: the state it reported
  // before this reload.
  const releaseBefore = capable && before.release ? toSessionConfigRelease(before.release) : null;
  // The checkout half of the reload. Set by whichever branch below runs the
  // refresh; a reload that never reached the refresh reports `not-requested`.
  let checkout: WorkspaceCheckout = 'not-requested';
  const releaseFields = (
    release: SessionConfigRelease | null,
    outcome: ConvergeOutcome | null,
  ): Pick<SessionReloadResult, 'release' | 'release_outcome' | 'config_path' | 'workspace_checkout'> => ({
    ...(capable
      ? { ...(release ? { release } : {}), release_outcome: outcome, config_path: 'release' as const }
      : { config_path: 'legacy' as const }),
    workspace_checkout: checkout,
  });

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
  if (capable) {
    if (pullRepo) {
      input.onPhase?.('refreshing-workspace');
      const refreshed = await refreshSandboxWorkspace(input.sessionId, { pullRepo }, deps);
      repoRefreshed = refreshed.ok;
      checkout = classifyWorkspaceCheckout({
        requested: true,
        ok: refreshed.ok,
        before: before.commitSha,
        after: refreshed.commitSha,
      });
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
    // The swap retired the process that was writing this turn. Settle the row
    // it left open and hand the prompt back, instead of leaving the client with
    // a 503 over a row that never completes. Never fails the reload: the config
    // DID converge, and saying otherwise would hide that.
    if (converged.reload?.orphaned_message_id) {
      await deps
        .repairOrphanedTurn({
          sessionId: input.sessionId,
          orphanedMessageId: converged.reload.orphaned_message_id,
        })
        .catch((error) =>
          console.warn(
            `[session-reload] orphaned-turn repair failed for ${input.sessionId}:`,
            error instanceof Error ? error.message : String(error),
          ),
        );
    }
    // Read the etag the box runs now: the release carried the governance. pi
    // applies a release in place, so `applied` arrives with no `reload`.
    const after =
      converged.outcome === 'applied' ? await readSandboxConfigState({ sessionId: input.sessionId }, deps) : null;
    return {
      ...convergeToReloadResult(converged, { previousEtag: before.etag, etagAfter: after?.etag ?? null }),
      repo_refreshed: repoRefreshed,
      commit_sha: commitSha,
      ...releaseFields(toSessionConfigRelease(converged.config), converged.outcome),
    };
  }

  // ── The pre-release path ────────────────────────────────────────────────
  // Reached two ways: a daemon without `config.release.v1`, and a project
  // whose `config_releases` flag is OFF (spec, "Feature flag"). OpenCode reads
  // the agent files in the session's checkout here, so the refresh also brings
  // the base branch's config dir into it (`base_config=1`). Without that, a fix
  // merged to base never reached a live session (prod 2026-09-30).
  input.onPhase?.('refreshing-workspace');
  const refreshed = await refreshSandboxWorkspace(input.sessionId, { pullRepo, baseConfig: pullRepo }, deps);
  repoRefreshed = pullRepo && refreshed.ok;
  checkout = classifyWorkspaceCheckout({
    requested: pullRepo,
    ok: refreshed.ok,
    before: before.commitSha,
    after: refreshed.commitSha,
  });
  commitSha = refreshed.commitSha ?? commitSha;

  // A daemon built before `base_config` answers without `config_dir`: 'unknown'.
  const agentFiles = classifyAgentFiles({
    requested: pullRepo,
    synced: refreshed.configDirSynced,
    reason: refreshed.configDirReason,
  });
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

  // The daemon reloads the OpenCode config itself when it brought agent files
  // forward (dispose-first, so milliseconds). On a project without releases
  // the push above runs as well and disposes again; both are cheap.
  const daemonReload = agentFiles === 'updated' ? (refreshed.configReload?.how ?? null) : null;
  const applied = push.applied || daemonReload === 'disposed' || daemonReload === 'restarted';
  const opencodeReload = push.opencodeReload ?? daemonReload;
  return {
    applied,
    previous_etag: before.etag,
    // On a refusal the box still runs what it ran; do not report the new hash as
    // though it had landed.
    etag: applied ? latest : before.etag,
    repo_refreshed: repoRefreshed,
    commit_sha: commitSha,
    agent_files: agentFiles,
    opencode_reload: opencodeReload ?? null,
    turn_ended: push.opencodeTurnEnded ?? (daemonReload ? (refreshed.configReload?.turnEnded ?? null) : null),
    ...(applied || daemonReload === 'kept-old'
      ? opencodeReload === 'kept-old'
        ? {
            reason:
              'the new opencode did not start, so the session kept the config it was already running',
          }
        : {}
      : { reason: agentFiles === 'already-current' ? 'already current' : (push.reason ?? 'agent config unchanged') }),
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
    etag: converged.outcome === 'applied' ? (etags.etagAfter ?? etags.previousEtag) : etags.previousEtag,
    // Null for a runtime that applies a release in place (pi): nothing restarted.
    opencode_reload: reloaded ? ('restarted' as const) : null,
    turn_ended: converged.reload?.turn_ended ?? null,
  };
  const failedId = converged.config.failed_release_id?.slice(0, 12);
  switch (converged.outcome) {
    case 'applied':
      return { ...common, applied: true, agent_files: 'updated' };
    case 'unchanged':
      return { ...common, applied: false, agent_files: 'already-current', reason: 'already current' };
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
 * `baseConfig` sends `base_config=1`: the daemon brings the base branch's
 * changes to the OpenCode config dir into the checkout (`syncConfigDirToBase` —
 * file by file, keeping the session's own edits and commits, never moving a
 * ref), and reloads the OpenCode config when files changed, despite
 * `restart=0` (answered as `config_dir.reload`). The pre-release path needs it
 * because OpenCode reads its agent files from this checkout.
 *
 * `restart=0`: the config push right after restarts opencode anyway, and
 * restarting twice doubles the boot cost and the window where the box 503s.
 */
async function refreshSandboxWorkspace(
  sessionId: string,
  opts: { pullRepo: boolean; baseConfig?: boolean },
  deps: SessionReloadDeps,
): Promise<{
  ok: boolean;
  commitSha: string | null;
  /** `null` = the box did not say (a daemon built before `base_config`). */
  configDirSynced: boolean | null;
  configDirReason?: string;
  /** The config reload the daemon ran because it brought files forward. */
  configReload?: { how: 'disposed' | 'restarted' | 'kept-old'; turnEnded: boolean | null };
}> {
  const unreachable = { ok: false, commitSha: null, configDirSynced: null };
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
      res = await deps.fetch(
        `${endpoint.baseUrl}/kortix/refresh?restart=0${opts.pullRepo ? '' : '&repo=0'}${opts.baseConfig ? '&base_config=1' : ''}`,
        {
          method: 'POST',
          headers: endpoint.headers,
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (res.status !== 409 || attempt >= REFRESH_BUSY_RETRIES) break;
      await deps.sleep(REFRESH_BUSY_DELAY_MS);
    }
    if (!res.ok) return unreachable;
    // The daemon answers `{repo: {before, after}}` — there is no `repo.commit`,
    // so the old read was always undefined and `commit_sha` always reported the
    // PRE-reload value, making a successful pull look like a no-op.
    const body = (await res.json()) as {
      repo?: { after?: { commit?: unknown } };
      config_dir?: { synced?: unknown; skipped?: unknown; reload?: unknown; turn_ended?: unknown };
    };
    const commit = body.repo?.after?.commit;
    const dir = body.config_dir;
    const how = dir?.reload;
    return {
      ok: true,
      commitSha: typeof commit === 'string' ? commit : null,
      configDirSynced: typeof dir?.synced === 'boolean' ? dir.synced : null,
      ...(typeof dir?.skipped === 'string' ? { configDirReason: dir.skipped } : {}),
      ...(how === 'disposed' || how === 'restarted' || how === 'kept-old'
        ? { configReload: { how, turnEnded: typeof dir?.turn_ended === 'boolean' ? dir.turn_ended : null } }
        : {}),
    };
  } catch {
    // A failed pull is not a failed reload: the config recompiles from the git
    // MIRROR, not the sandbox's working tree, so the agent still updates.
    return unreachable;
  }
}
