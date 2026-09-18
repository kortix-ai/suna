import { projects, projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { reloadSessionConfig, type SessionReloadResult } from './session-reload';

/**
 * Bring a session that just came back up onto its base branch's CURRENT config.
 *
 * WHY IT IS NEEDED. A sandbox holds the config of the moment it was provisioned:
 * the env block is minted once, and a resume or restart hands the same VM back
 * with the same working tree. Nothing on those paths re-reads the base branch,
 * so a long-lived session — and every one of the 16,685 sessions imported from
 * legacy Suna on 2026-09-15/16 — runs the agents, skills and governance of its
 * provision day until someone finds the reload button.
 *
 * `scheduleSandboxRuntimeRefresh` already does this for the platform's half (the
 * `kortix` CLI, the daemon, the managed-skill overlay). This is the project's
 * half: `.kortix/opencode` from the base ref, plus the compiled agent config.
 *
 * WHAT IT RUNS. `reloadSessionConfig` — the same operation as the reload button,
 * so there is one definition of "converged" — with two differences:
 *
 *   - `onlyIfStale`. A reload restarts opencode. A box that is already current
 *     must not pay that on every wake, so the push is skipped unless the file
 *     sync replaced something or the compiled etag moved.
 *   - never `force`. An automatic path has no standing to end a turn. A busy
 *     session is retried later, and a session that stays busy keeps its config
 *     until the next wake.
 *
 * WHY IT RETRIES ON TWO CLOCKS. "Not reachable yet" clears in seconds: the
 * provider reports `running` before the guest daemon binds its port. "Busy" and
 * "refused the file sync" clear in minutes: a turn has to end, and a box whose
 * daemon predates the platform-ownership fix (git.ts, `OPENCODE_PLUGIN_PACKAGE`)
 * refuses with `local changes` until its staged replacement swaps in, which the
 * supervisor allows only after ~5 min of idle uptime.
 *
 * NEVER blocks a caller and never throws: every call site is already past the
 * point where the session was reported ready to the user.
 */

const RETRY_SOON_MS = [5_000, 10_000, 15_000, 30_000] as const;
/** Past the daemon's 5-minute self-update gate, then once more. */
const RETRY_LATER_MS = [6 * 60_000, 20 * 60_000] as const;

export interface SessionConfigConvergenceTarget {
  projectId: string;
  accountId: string;
  sessionId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string | null;
  baseRef: string | null;
}

export interface SessionConfigConvergenceDeps {
  loadTarget: (sessionId: string) => Promise<SessionConfigConvergenceTarget | null>;
  reload: (
    input: SessionConfigConvergenceTarget & { onlyIfStale: true; force: false },
  ) => Promise<SessionReloadResult>;
  sleep: (ms: number) => Promise<void>;
}

async function loadTarget(sessionId: string): Promise<SessionConfigConvergenceTarget | null> {
  const [row] = await db
    .select({
      projectId: projects.projectId,
      accountId: projects.accountId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
      baseRef: projectSessions.baseRef,
    })
    .from(projectSessions)
    .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  return { ...row, sessionId, baseRef: row.baseRef ?? row.defaultBranch };
}

const defaultDeps: SessionConfigConvergenceDeps = {
  loadTarget,
  reload: (input) => reloadSessionConfig(input),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type SessionConfigConvergenceOutcome =
  /** The box now runs the base branch's config. */
  | 'converged'
  /** It already did. Nothing was restarted. */
  | 'current'
  /** The session edited its own agent files. Kept — that is the contract. */
  | 'kept-session-edits'
  /** A turn was running at every attempt. */
  | 'busy'
  | 'unreachable'
  | 'no-session'
  | 'failed';

type Attempt =
  | { done: SessionConfigConvergenceOutcome }
  | { retry: 'soon' | 'later'; as: SessionConfigConvergenceOutcome };

function classify(result: SessionReloadResult): Attempt {
  if (result.reason === 'no reachable sandbox') return { retry: 'soon', as: 'unreachable' };
  if (
    result.reason === 'session is mid-turn' ||
    result.reason === 'could not confirm the session is idle'
  ) {
    return { retry: 'later', as: 'busy' };
  }
  // `unknown` is a daemon too old to report the sync. Same remedy as a refusal:
  // its replacement is staged on this wake.
  if (result.agent_files === 'kept-yours' || result.agent_files === 'unknown') {
    return { retry: 'later', as: 'kept-session-edits' };
  }
  return { done: result.applied ? 'converged' : 'current' };
}

/**
 * Awaitable core — exported so tests can assert the schedule without a timer.
 * Production call sites use `scheduleSessionConfigConvergence`.
 */
export async function convergeSessionConfig(
  sessionId: string,
  deps: SessionConfigConvergenceDeps = defaultDeps,
): Promise<SessionConfigConvergenceOutcome> {
  try {
    const target = await deps.loadTarget(sessionId);
    if (!target) return 'no-session';

    let soon = 0;
    let later = 0;
    for (;;) {
      const attempt = classify(await deps.reload({ ...target, onlyIfStale: true, force: false }));
      if ('done' in attempt) return attempt.done;
      const delay = attempt.retry === 'soon' ? RETRY_SOON_MS[soon++] : RETRY_LATER_MS[later++];
      if (delay === undefined) return attempt.as;
      await deps.sleep(delay);
    }
  } catch (error) {
    logger.warn('[projects] session config convergence threw', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/**
 * Fire-and-forget form for the restart/resume call sites. Returns immediately.
 */
export function scheduleSessionConfigConvergence(sessionId: string, context: string): void {
  void convergeSessionConfig(sessionId).then((outcome) => {
    if (outcome === 'current') return;
    logger.info('[projects] session config convergence finished', {
      session_id: sessionId,
      context,
      outcome,
    });
  });
}
