/**
 * Convergence triggers (docs/specs/config-releases.md, "Convergence
 * triggers"): turn end, a base branch moved by an API write, and a push to
 * the base branch through the git proxy. Each one only schedules
 * `convergeSessionConfig`; none of them ends or delays a turn.
 *
 * Limits, per API process:
 * - Turn end: debounced per session, `TURN_END_DEBOUNCE_MS` after the last
 *   turn end. A session whose next turn already started is busy; the
 *   convergence returns at once and the next turn end tries again.
 * - Base move: at most one fan-out per `(project, branch)` per
 *   `BASE_MOVE_WINDOW_MS`. A move inside the window schedules one trailing
 *   fan-out at the window's end, so the last move is never lost. One fan-out
 *   reaches at most `MAX_SESSIONS_PER_BASE_MOVE` sessions, and only running
 *   sessions with an active sandbox on that base ref. Never a stopped session.
 * - All triggered convergences share `MAX_CONCURRENT_TRIGGERED_CONVERGENCES`
 *   slots and a queue of `MAX_QUEUED_TRIGGERED_CONVERGENCES`. A session
 *   already queued or running is not queued twice; a trigger that arrives
 *   while it runs re-runs it once afterwards.
 */

import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { convergeSessionConfig, type SessionConfigConvergenceOutcome } from './session-config-convergence';

export const TURN_END_DEBOUNCE_MS = 5_000;
export const BASE_MOVE_WINDOW_MS = 30_000;
export const MAX_SESSIONS_PER_BASE_MOVE = 200;
export const MAX_CONCURRENT_TRIGGERED_CONVERGENCES = 8;
export const MAX_QUEUED_TRIGGERED_CONVERGENCES = 2_000;

export interface ConvergenceTriggerDeps {
  /** One convergence on the trigger schedule. */
  converge: (sessionId: string, context: string) => Promise<SessionConfigConvergenceOutcome>;
  /** Running sessions with an active sandbox whose base ref is `branch`. */
  listRunningSessionsOnBase: (projectId: string, branch: string, limit: number) => Promise<string[]>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

export interface ConvergenceTriggers {
  turnEnded(sessionId: string): void;
  baseMoved(projectId: string, branch: string, context: string): void;
  /** Tests only: resolves when no convergence is queued or running. */
  settled(): Promise<void>;
}

/** `refs/heads/main` → `main`. */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function createConvergenceTriggers(deps: ConvergenceTriggerDeps): ConvergenceTriggers {
  const queue: Array<{ sessionId: string; context: string }> = [];
  const queued = new Set<string>();
  const running = new Set<string>();
  const rerun = new Map<string, string>();
  let active = 0;
  let waiters: Array<() => void> = [];

  const notifySettled = () => {
    if (active > 0 || queue.length > 0) return;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const pump = () => {
    while (active < MAX_CONCURRENT_TRIGGERED_CONVERGENCES && queue.length > 0) {
      const next = queue.shift()!;
      queued.delete(next.sessionId);
      running.add(next.sessionId);
      active++;
      void deps
        .converge(next.sessionId, next.context)
        .then((outcome) => {
          if (outcome !== 'current') {
            logger.info('[projects] triggered config convergence finished', {
              session_id: next.sessionId,
              context: next.context,
              outcome,
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          active--;
          running.delete(next.sessionId);
          const again = rerun.get(next.sessionId);
          rerun.delete(next.sessionId);
          if (again) enqueue(next.sessionId, again);
          pump();
          notifySettled();
        });
    }
    notifySettled();
  };

  const enqueue = (sessionId: string, context: string) => {
    if (running.has(sessionId)) {
      rerun.set(sessionId, context);
      return;
    }
    if (queued.has(sessionId)) return;
    if (queue.length >= MAX_QUEUED_TRIGGERED_CONVERGENCES) {
      logger.warn('[projects] triggered config convergence queue full; dropped', { session_id: sessionId, context });
      return;
    }
    queued.add(sessionId);
    queue.push({ sessionId, context });
    pump();
  };

  const turnTimers = new Map<string, unknown>();
  const turnEnded = (sessionId: string) => {
    const previous = turnTimers.get(sessionId);
    if (previous !== undefined) deps.clearTimer(previous);
    turnTimers.set(
      sessionId,
      deps.setTimer(() => {
        turnTimers.delete(sessionId);
        enqueue(sessionId, 'turn-end');
      }, TURN_END_DEBOUNCE_MS),
    );
  };

  const lastFanOut = new Map<string, number>();
  const trailing = new Map<string, unknown>();
  const fanOut = async (projectId: string, branch: string, context: string) => {
    lastFanOut.set(`${projectId}\0${branch}`, deps.now());
    let sessionIds: string[];
    try {
      sessionIds = await deps.listRunningSessionsOnBase(projectId, branch, MAX_SESSIONS_PER_BASE_MOVE);
    } catch (error) {
      logger.warn('[projects] base-move fan-out could not list sessions', {
        project_id: projectId,
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const sessionId of sessionIds) enqueue(sessionId, context);
  };

  const baseMoved = (projectId: string, ref: string, context: string) => {
    const branch = branchName(ref);
    const key = `${projectId}\0${branch}`;
    if (trailing.has(key)) return;
    const last = lastFanOut.get(key);
    const now = deps.now();
    if (last === undefined || now - last >= BASE_MOVE_WINDOW_MS) {
      void fanOut(projectId, branch, context);
      return;
    }
    trailing.set(
      key,
      deps.setTimer(() => {
        trailing.delete(key);
        void fanOut(projectId, branch, context);
      }, last + BASE_MOVE_WINDOW_MS - now),
    );
  };

  return {
    turnEnded,
    baseMoved,
    settled: () =>
      active === 0 && queue.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)),
  };
}

export async function listRunningSessionsOnBase(projectId: string, branch: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .innerJoin(
      sessionSandboxes,
      and(eq(sessionSandboxes.sessionId, projectSessions.sessionId), eq(sessionSandboxes.status, 'active')),
    )
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.status, 'running'),
        or(
          inArray(projectSessions.baseRef, [branch, `refs/heads/${branch}`]),
          and(sql`${projectSessions.baseRef} IS NULL`, eq(projects.defaultBranch, branch)),
        ),
      ),
    )
    .limit(limit);
  return [...new Set(rows.map((row) => row.sessionId))];
}

let triggers: ConvergenceTriggers | null = null;
function productionTriggers(): ConvergenceTriggers {
  triggers ??= createConvergenceTriggers({
    converge: (sessionId) => convergeSessionConfig(sessionId, undefined, { schedule: 'trigger', refreshRepo: false }),
    listRunningSessionsOnBase,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
  return triggers;
}

/** A session's turn ended. Never throws, never waits. */
export function notifySessionTurnEnded(sessionId: string): void {
  try {
    productionTriggers().turnEnded(sessionId);
  } catch {
    // A trigger must never fail the turn-end relay.
  }
}

/**
 * An API write or a proxied push moved `ref` in the project. Sessions whose
 * base ref is that branch converge; every other session is untouched.
 * Never throws, never waits.
 */
export function notifyBaseBranchMoved(projectId: string, ref: string, context: string): void {
  try {
    productionTriggers().baseMoved(projectId, ref, context);
  } catch {
    // A trigger must never fail the write that moved the branch.
  }
}

/** A session branch is named by its session ID. No session uses one as its base. */
const SESSION_BRANCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_OID = /^0+$/;

/**
 * The branches a receive-pack created or moved, minus deletions and session
 * branches. A 2xx from the upstream does not prove it accepted every ref; a
 * convergence against an unchanged base is a no-op.
 */
export function pushedBaseCandidates(updates: ReadonlyArray<{ ref: string; newSha: string }>): string[] {
  const branches = new Set<string>();
  for (const update of updates) {
    if (!update.ref.startsWith('refs/heads/') || ZERO_OID.test(update.newSha)) continue;
    const branch = update.ref.slice('refs/heads/'.length);
    if (!SESSION_BRANCH.test(branch)) branches.add(branch);
  }
  return [...branches];
}

/** A push through the git proxy succeeded. Never throws, never waits. */
export function notifyPushedRefs(projectId: string, updates: ReadonlyArray<{ ref: string; newSha: string }>): void {
  for (const branch of pushedBaseCandidates(updates)) notifyBaseBranchMoved(projectId, branch, 'git-push');
}
