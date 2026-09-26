/**
 * C9 — a prompt on a box that is behind converges FIRST, then runs.
 *
 * THE CHOKEPOINT. `forwardToSandbox` (`sandbox-proxy/routes/preview.ts`) is
 * the one funnel every turn passes through: the HTTP proxy calls it, and so
 * does the server-side prompt queue (`session-lifecycle/engine.ts`). The gate
 * is `isTurnStartRequest`, so the OpenCode ports 4096/4097 are covered too —
 * `shouldSyncProjectEnvBeforeProxy` is port-8000-only and would have left a
 * hole exactly where a verified reload had swapped which half is live.
 *
 * WHAT IT COSTS A CURRENT BOX. Nothing, in the common case. Two memos:
 *
 *   1. the desired release per `(project, base ref, session agent, repository
 *      access)`, for `DESIRED_TTL_MS`. Without it every prompt would pay
 *      `resolveDesiredRelease`, which calls `invalidateProjectMirror`
 *      unconditionally and then a `git rev-parse` + a manifest read.
 *   2. the release the API last SAW the box running, learned from the daemon's
 *      own reports through `recordDaemonConfigReport` — the one place the API
 *      is told what a box serves.
 *
 * When those two agree, the turn proceeds with zero network calls.
 *
 * When the API does not KNOW what the box runs — after a restart, or because
 * another API process handled the convergence — one `GET /kortix/health` says
 * so, and only a real difference costs a convergence. That probe is the
 * difference between ~200 ms and a full reload round trip: measured on a real
 * Platinum box on 2026-09-24, a convergence the daemon answered `unchanged`
 * still cost the turn 10 907 ms.
 *
 * WHAT IT NEVER DOES. It never ends a running turn: the convergence runs
 * `reloadSessionConfig` with `force: false` and `onlyIfStale: true`, which
 * refuses on `session is mid-turn` and on `could not confirm the session is
 * idle`. That is the hard invariant of session-config-convergence.ts, and this
 * path does not widen it.
 *
 * WHERE LOST-PROMPT RECOVERY IS WIRED, AND WHY NOT HERE.
 * This gate needs none for ITS OWN request: it runs BEFORE
 * `claimPromptDelivery` and before the first upstream fetch, so at the moment
 * OpenCode is swapped no prompt of this request has been claimed and none has
 * been delivered.
 *
 * That argument covers this request and NOTHING ELSE, and it was once written
 * here as though it covered every convergence. It does not. A convergence
 * started by the base-move trigger (`config-convergence-triggers.ts`) runs
 * while another request's prompt is in flight, and the swap retires the process
 * writing it. DEF-DEV-1: the client got `HTTP 503` and the assistant row stayed
 * `completed = null`. The repair for that lives where the swap is observed —
 * `session-reload.ts`, on the daemon's `reload.orphaned_message_id` — and it
 * reuses `recoverTurnsAfterRuntimeRestart`. Do not re-derive an invariant here
 * from "the gate holds the prompt": the gate holds ITS prompt.
 *
 * ONE ATTEMPT, NOT A LADDER. `schedule: 'turn-start'` takes exactly one
 * attempt and sleeps zero times. A prompt must not sit behind a 60-second
 * retry ladder; a box that could not converge now converges at the next
 * prompt, the next base move, or the next wake.
 */

import { projects, projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { configReleasesEnabled } from '../../config-releases/enabled';
import { resolveDesiredRelease } from '../../config-releases/desired';
import { ownerMayUseAgent } from '../../config-releases/repoint';
import {
  __clearRunningReleasesForTests,
  lastKnownRunningRelease,
  noteRunningRelease,
} from '../../config-releases/running-release';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { ttlMemo } from '../../shared/ttl-memo';
import { repositoryAccessFromSessionMetadata } from './session-sandbox-metadata';
import type { SessionConfigConvergenceOutcome } from './session-config-convergence';

/**
 * How long a resolved desired release stands for a `(project, base ref, agent,
 * access)`.
 *
 * It is long because it is not the freshness mechanism. Every base move the
 * API sees — an API write, a push through the git proxy — drops the entry
 * through `invalidateDesiredRelease`, so a resolve is paid right after a
 * change and never between changes. The TTL is the backstop for a move the API
 * never saw: a push made directly on a BYO upstream, or one another API
 * process handled. Measured on a real Platinum box, 2026-09-24: a miss costs
 * 573-795 ms (mirror refresh plus the remote tip resolve), a hit 0 ms.
 */
export const DESIRED_TTL_MS = 60_000;
const MAX_TRACKED_SESSIONS = 20_000;
/**
 * A base branch moved. Called from `notifyBaseBranchMoved`
 * (config-convergence-triggers.ts), the one place the API learns that.
 *
 * Every branch of the project is dropped, not just the one named: a session's
 * `base_ref` may be stored as `main` or `refs/heads/main`, and the entry for a
 * project is small. Dropping too much costs one resolve; dropping too little
 * would serve a stale desired release to a turn.
 *
 * It drops the entry in EVERY api process, not only this one. See
 * `createDesiredReleaseInvalidation`.
 */
export function invalidateDesiredRelease(projectId: string): void {
  invalidateEverywhere(projectId);
}

export function __resetTurnStartConvergenceForTests(): void {
  __clearRunningReleasesForTests();
  desiredReleases.clear();
  sessionMemo.clear();
}

interface SessionTarget {
  projectId: string;
  accountId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string | null;
  projectMetadata: unknown;
  baseRef: string;
  agentName: string | null;
  sessionMetadata: unknown;
  createdBy: string | null;
}

const sessionMemo = ttlMemo({
  ttlMs: 30_000,
  keyFn: (sessionId: string) => sessionId,
  loader: async (sessionId: string): Promise<SessionTarget | null> => {
    const [row] = await db
      .select({
        projectId: projects.projectId,
        accountId: projects.accountId,
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        manifestPath: projects.manifestPath,
        projectMetadata: projects.metadata,
        baseRef: projectSessions.baseRef,
        agentName: projectSessions.agentName,
        sessionMetadata: projectSessions.metadata,
        createdBy: projectSessions.createdBy,
      })
      .from(projectSessions)
      .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!row) return null;
    return { ...row, baseRef: row.baseRef ?? row.defaultBranch };
  },
  shouldCache: (value) => value !== null,
  maxEntries: MAX_TRACKED_SESSIONS,
});

async function resolveDesiredReleaseFor(target: SessionTarget, sessionId: string): Promise<string | null> {
  const subject = {
    projectId: target.projectId,
    accountId: target.accountId,
    sessionId,
    ownerUserId: target.createdBy,
  };
  const desired = await resolveDesiredRelease({
    project: {
      projectId: target.projectId,
      repoUrl: target.repoUrl,
      defaultBranch: target.defaultBranch,
      manifestPath: target.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    },
    baseRef: target.baseRef,
    sessionAgent: target.agentName,
    repositoryAccess: repositoryAccessFromSessionMetadata(target.sessionMetadata),
    // A turn start is not an assignment. The daemon's own descriptor request
    // records it, and only that request persists a re-point.
    ownerMayUseAgent: (agent) => ownerMayUseAgent(subject, agent),
  });
  return desired.descriptor.release_id;
}

/** One api process's memo of the desired release per `(project, base ref, agent, access, owner)`. */
export interface DesiredReleaseCache {
  get: (target: SessionTarget, sessionId: string) => Promise<string | null>;
  /** Drop every entry of a project. LOCAL to this cache — see `createDesiredReleaseInvalidation`. */
  invalidate: (projectId: string) => void;
  clear: () => void;
}

/**
 * A cache, not a singleton, so a test can hold two and prove they are dropped
 * independently — which is the whole shape of the bug this closes.
 */
export function createDesiredReleaseCache(
  loader: (target: SessionTarget, sessionId: string) => Promise<string | null> = resolveDesiredReleaseFor,
  opts: { enableInTests?: boolean } = {},
): DesiredReleaseCache {
  const memo = ttlMemo({
    ttlMs: DESIRED_TTL_MS,
    // Deliberately NOT keyed by session: every session of a project on the same
    // base ref, agent and access shares one resolve. `createdBy` is in the key
    // because the re-point decision is authorized against the session's owner.
    keyFn: (target: SessionTarget, _sessionId: string) =>
      [
        target.projectId,
        target.baseRef,
        target.agentName ?? '',
        repositoryAccessFromSessionMetadata(target.sessionMetadata) ? '1' : '0',
        target.createdBy ?? '',
      ].join('\0'),
    loader,
    // Never cache "the base ref did not resolve": the next prompt must retry.
    shouldCache: (value) => value !== null,
    maxEntries: 5_000,
    enableInTests: opts.enableInTests,
  });
  return {
    get: (target, sessionId) => memo(target, sessionId),
    invalidate: (projectId) => memo.invalidateByPrefix(`${projectId}\0`),
    clear: () => memo.clear(),
  };
}

/**
 * How one api process tells the others that a base branch moved.
 *
 * `publish` must never throw and must never block the caller: it runs inside
 * the write that moved the branch. `subscribe` is called once, at wiring time.
 */
export interface DesiredInvalidationTransport {
  publish: (projectId: string) => void;
  subscribe: (handler: (projectId: string) => void) => void;
}

/**
 * Drop a project's desired release HERE and everywhere else.
 *
 * Dev runs two API pods. A push arrives at one of them, and only that one used
 * to drop its memo — so the other served a release resolved before the push for
 * up to `DESIRED_TTL_MS`, and the turn-start gate answered `current` on a box
 * that was behind (DEF-DEV-1, R1). Shortening the TTL narrows that window and
 * never closes it; a broadcast closes it.
 *
 * Degrades to exactly the old behaviour: with no transport, or with one whose
 * connection is down, the local drop still happens and the TTL is the backstop.
 */
export function createDesiredReleaseInvalidation(
  cache: DesiredReleaseCache,
  transport: DesiredInvalidationTransport | null,
): (projectId: string) => void {
  transport?.subscribe((projectId) => {
    try {
      cache.invalidate(projectId);
    } catch {
      // A notification must never take a process down.
    }
  });
  return (projectId: string) => {
    cache.invalidate(projectId);
    try {
      transport?.publish(projectId);
    } catch {
      // The write that moved the branch must not fail because the fan-out did.
    }
  };
}

const desiredReleases = createDesiredReleaseCache();
let invalidateEverywhere = createDesiredReleaseInvalidation(desiredReleases, null);

/**
 * Wire the process-to-process fan-out. Called once at boot
 * (`startReplicaServices`). Before it runs — and in every test — the local drop
 * plus the TTL is the behaviour.
 */
export function useDesiredInvalidationTransport(transport: DesiredInvalidationTransport): void {
  invalidateEverywhere = createDesiredReleaseInvalidation(desiredReleases, transport);
}

export interface TurnStartConvergenceDeps {
  loadTarget: (sessionId: string) => Promise<SessionTarget | null>;
  desiredReleaseId: (target: SessionTarget, sessionId: string) => Promise<string | null>;
  runningReleaseId: (sessionId: string) => string | null | undefined;
  /** One `GET /kortix/health`. Asked only when the API does not know already. */
  probeRunningRelease: (sessionId: string) => Promise<string | null | undefined>;
  converge: (sessionId: string) => Promise<SessionConfigConvergenceOutcome>;
  releasesEnabled: (metadata: unknown) => boolean;
  now: () => number;
}

/**
 * Ask the box what it runs, and remember the answer.
 *
 * `undefined` means "could not tell" — an unreachable box, or a daemon that
 * predates config releases. Neither is evidence of being current, so neither is
 * remembered.
 */
async function probeRunningRelease(sessionId: string): Promise<string | null | undefined> {
  const { readSandboxConfigState } = await import('./session-reload');
  const state = await readSandboxConfigState({ sessionId }).catch(() => null);
  if (!state?.reachable || !state.configReleases || !state.release) return undefined;
  noteRunningRelease(sessionId, state.release.release_id);
  return state.release.release_id;
}

const defaultDeps: TurnStartConvergenceDeps = {
  loadTarget: (sessionId) => sessionMemo(sessionId),
  desiredReleaseId: (target, sessionId) => desiredReleases.get(target, sessionId),
  runningReleaseId: lastKnownRunningRelease,
  probeRunningRelease,
  // DYNAMIC import on purpose. `sandbox-proxy/routes/preview.ts` calls this
  // gate on every turn start, and a static edge would pull the whole reload
  // graph — `session-reload` and `sandbox-env-sync` among them — into the
  // proxy's module graph. Five proxy unit tests that partially mock
  // `sandbox-env-sync` broke on exactly that. Same reasoning as the `./engine`
  // import in session-lifecycle/runtime-restart-recovery.ts. Nothing needs it
  // before this call: a box that is already current never reaches it.
  converge: async (sessionId) =>
    (await import('./session-config-convergence')).convergeSessionConfig(sessionId, undefined, {
      schedule: 'turn-start',
      refreshRepo: false,
    }),
  releasesEnabled: configReleasesEnabled,
  now: () => Date.now(),
};

export type TurnStartDecision =
  /** The flag is off for this project, or the session is gone. Nothing ran. */
  | 'skipped'
  /** The box already runs the desired release. Nothing ran, no network call. */
  | 'current'
  /** One convergence attempt ran. `outcome` says what it did. */
  | 'converged';

export interface TurnStartConvergenceResult {
  decision: TurnStartDecision;
  outcome: SessionConfigConvergenceOutcome | null;
  /** Wall-clock cost this gate added to the turn. */
  ms: number;
}

/**
 * Bring a box onto the project's current config before its turn starts.
 * NEVER throws: a turn is never refused because this could not run.
 */
export async function convergeBeforeTurnStart(
  sessionId: string,
  deps: TurnStartConvergenceDeps = defaultDeps,
): Promise<TurnStartConvergenceResult> {
  const startedAt = deps.now();
  const done = (decision: TurnStartDecision, outcome: SessionConfigConvergenceOutcome | null) => ({
    decision,
    outcome,
    ms: deps.now() - startedAt,
  });
  try {
    const target = await deps.loadTarget(sessionId);
    if (!target) return done('skipped', null);
    // CHOKEPOINT — the `config_releases` flag on the turn path. Off ⇒ the box
    // keeps reading its workspace config dir and no release is ever resolved,
    // so nothing here may cost the turn a single call.
    if (!deps.releasesEnabled(target.projectMetadata)) return done('skipped', null);

    const desired = await deps.desiredReleaseId(target, sessionId).catch(() => null);
    let running = deps.runningReleaseId(sessionId);
    // Not known: one health GET, not a convergence. A cold memo is the normal
    // state after a deploy and whenever another API process did the work, and
    // a full converge round trip is two orders of magnitude more expensive
    // than asking.
    if (running === undefined) running = await deps.probeRunningRelease(sessionId).catch(() => undefined);
    if (desired !== null && running !== undefined && running === desired) {
      return done('current', null);
    }
    const outcome = await deps.converge(sessionId);
    return done('converged', outcome);
  } catch (error) {
    logger.warn('[projects] turn-start convergence threw', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return done('skipped', null);
  }
}
