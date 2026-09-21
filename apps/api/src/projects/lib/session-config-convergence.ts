import { projects, projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { PREVIOUS_REPOSITORY_REASON, reloadSessionConfig, type SessionReloadResult } from './session-reload';

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
 * WHY IT RETRIES ON TWO CLOCKS. "Not reachable yet" and "cannot tell whether a
 * turn is running" clear in seconds: the provider reports `running` before the
 * guest daemon binds its port, and opencode answers a few seconds after that.
 * They escalate to the slow clock only if they persist. "Mid-turn" and
 * "refused the file sync" clear in minutes: a turn has to end, and a box whose
 * daemon predates the platform-ownership fix (git.ts, `OPENCODE_PLUGIN_PACKAGE`)
 * refuses with `local changes` until its staged replacement swaps in, which the
 * supervisor allows only after ~5 min of idle uptime.
 *
 * NEVER blocks a caller and never throws: every call site is already past the
 * point where the session was reported ready to the user.
 */

const RETRY_SOON_MS = [5_000, 10_000, 15_000, 30_000] as const;
/**
 * 6 min: past the daemon's 5-minute self-update gate.
 *
 * 60 s after that: the staged daemon does not swap on a timer. It swaps on the
 * next runtime-assets pass once the gate is open, and the reload's own
 * `/kortix/refresh` call is what schedules that pass. Measured on the #7403
 * preview: `agent=staged` held for 567 s, one refresh, and the new daemon was
 * serving 10 s later. So the 6-minute attempt is refused by the OLD daemon and
 * triggers the swap; this follow-up is the first one the NEW daemon answers.
 * Without it a box imported before the fix waited for the 20-minute attempt.
 *
 * 20 min: one last try for a turn that was still running.
 */
const RETRY_LATER_MS = [6 * 60_000, 60_000, 20 * 60_000] as const;

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
    input: SessionConfigConvergenceTarget & { onlyIfStale: true; force: false; refreshRepo?: boolean },
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
  /**
   * The daemon declined the release (proven check failed) or has it in its
   * box quarantine. Retrying the same release cannot pass; the next base move
   * or trigger brings a new one.
   */
  | 'declined'
  /** The daemon predates config releases. It converges after its self-update. */
  | 'awaiting-daemon-update'
  /** The session belongs to a previous repository generation. It keeps its config. */
  | 'previous-repository'
  | 'failed';

type Attempt =
  | { done: SessionConfigConvergenceOutcome }
  /**
   * `transient` clears in seconds and is retried on the quick ladder first,
   * then on the slow one. `slow` needs minutes and skips the quick ladder.
   */
  | { retry: 'transient' | 'slow'; as: SessionConfigConvergenceOutcome };

function classify(result: SessionReloadResult): Attempt {
  if (result.reason === PREVIOUS_REPOSITORY_REASON) return { done: 'previous-repository' };
  if (result.reason === 'no reachable sandbox') return { retry: 'transient', as: 'unreachable' };
  // Right after a wake opencode is not answering yet, so the reload cannot tell
  // whether a turn is running. Measured on the #7403 preview: unanswerable at
  // +1 s, idle at +9 s. It is NOT evidence of a turn — treating it as one cost
  // a 6-minute wait and 371 s of stale config on a session nobody was using.
  if (result.reason === 'could not confirm the session is idle') {
    return { retry: 'transient', as: 'busy' };
  }
  // A turn is running. It will not be over in five seconds.
  if (result.reason === 'session is mid-turn') return { retry: 'slow', as: 'busy' };
  // A daemon with config releases reports an explicit outcome.
  if (result.config_path === 'release') {
    switch (result.release_outcome) {
      case 'applied':
        return { done: 'converged' };
      case 'unchanged':
        return { done: 'current' };
      case 'session-files':
        // The API chose this mode from the session's own edits. Retrying
        // cannot change it; the next trigger re-evaluates.
        return { done: 'kept-session-edits' };
      case 'declined':
      case 'quarantined':
        // The same release fails the same way. No fast loop.
        return { done: 'declined' };
      case 'failed':
        return { retry: 'slow', as: 'failed' };
      default:
        // No converge answer: the box was restarting or the call timed out.
        return { retry: 'transient', as: 'unreachable' };
    }
  }
  // A daemon without config releases received only the refresh, which stages
  // its replacement. The replacement swaps after 5 min of idle uptime, so the
  // 6- and 7-minute attempts reach it. The quick ladder cannot.
  if (result.config_path === 'legacy') return { retry: 'slow', as: 'awaiting-daemon-update' };
  // The session edited its own agent files — or the box runs a daemon that
  // predates the platform-ownership fix and refuses on the platform's files,
  // in which case its staged replacement swaps in after ~5 min of idle uptime.
  if (result.agent_files === 'kept-yours') return { retry: 'slow', as: 'kept-session-edits' };
  // The daemon did not report the sync: a fetch that failed while the network
  // came back, or a daemon too old to know the flag.
  if (result.agent_files === 'unknown') return { retry: 'transient', as: 'kept-session-edits' };
  return { done: result.applied ? 'converged' : 'current' };
}

/**
 * Awaitable core — exported so tests can assert the schedule without a timer.
 * Production call sites use `scheduleSessionConfigConvergence`.
 */
export interface ConvergeSessionConfigOptions {
  /**
   * `wake` (default): the resume and restart schedule, both clocks.
   * `trigger`: one attempt plus the quick ladder for a box that is not
   * answering yet. A busy session or an old daemon ends the attempt: the next
   * turn end or base move triggers again. Used by the turn-end and base-move
   * triggers, which fire often.
   */
  schedule?: 'wake' | 'trigger';
  /** Pull the session branch. Default true (the wake path). Triggers pass false. */
  refreshRepo?: boolean;
}

export async function convergeSessionConfig(
  sessionId: string,
  deps: SessionConfigConvergenceDeps = defaultDeps,
  options: ConvergeSessionConfigOptions = {},
): Promise<SessionConfigConvergenceOutcome> {
  try {
    const target = await deps.loadTarget(sessionId);
    if (!target) return 'no-session';

    let soon = 0;
    let later = 0;
    for (;;) {
      const attempt = classify(
        await deps.reload({
          ...target,
          onlyIfStale: true,
          force: false,
          ...(options.refreshRepo === false ? { refreshRepo: false } : {}),
        }),
      );
      if ('done' in attempt) return attempt.done;
      if (options.schedule === 'trigger' && attempt.retry === 'slow') return attempt.as;
      const delay =
        attempt.retry === 'transient' && soon < RETRY_SOON_MS.length
          ? RETRY_SOON_MS[soon++]
          : options.schedule === 'trigger'
            ? undefined
            : RETRY_LATER_MS[later++];
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
