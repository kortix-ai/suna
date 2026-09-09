/**
 * FETCH THE MANIFEST WHILE THE USER IS READING, NOT WHILE THEY ARE WAITING.
 *
 * `remintGrantForAgentSwitch` forces a mirror refresh before every prompt, so
 * that a `kortix.yaml` the agent NARROWED in the previous turn is enforced from
 * the first call of the next one. That is the right guarantee and it costs one
 * authenticated round trip to GitHub. Measured on dev 2026-09-09, on the path of
 * a one-word reply:
 *
 *   [pre-prompt] timing total=702ms {"syncEnv":119,"remintGrant":583}
 *   [session-create:request] total=630ms {"agents":575,...}
 *
 * ~490 ms, paid by the person who just pressed enter.
 *
 * The guarantee does not require paying it THEN. The only event that can change
 * the manifest mid-session is the turn that just ended, so refreshing at TURN
 * END makes the next prompt's forced refresh free without weakening anything:
 *
 *  - if the fetch has finished by the time the prompt arrives, the coalesce
 *    window serves it (forced-refresh-window.ts) — measured 485 ms -> 15 ms;
 *  - if it is still in flight, `refreshMirror`'s lock makes the prompt JOIN it
 *    rather than start a second round trip;
 *  - either way the prompt still runs against a mirror fetched AFTER the turn
 *    that could have changed the manifest. That is the invariant, and it is the
 *    same one the blocking fetch provided.
 *
 * Pure, so the policy is asserted instead of raced against a git remote.
 */

export type TurnEndMirrorWarmupPlan =
  /** Kick a forced refresh now, off the request's critical path. */
  | 'warm'
  /** Do nothing — the next prompt will fetch for itself. */
  | 'skip';

export interface TurnEndMirrorWarmupInput {
  /**
   * Did the turn actually END? `session.error` also fires while the model is
   * RETRYING (a 429 backoff, a transient upstream 5xx). A retrying turn has not
   * written its final `kortix.yaml`, so warming on one buys a fetch that the
   * real turn end would have to redo.
   */
  terminal: boolean;
  /**
   * The forced-refresh coalesce window (`KORTIX_GIT_FORCE_COALESCE_MS`).
   * With coalescing OFF, `force` means "one round trip per caller" and the next
   * prompt fetches again regardless — so warming would be pure cost, twice the
   * GitHub traffic for the same latency.
   */
  coalesceWindowMs: number;
  /** A session whose project has no git mirror has nothing to warm. */
  gitBacked: boolean;
}

export function planTurnEndMirrorWarmup(input: TurnEndMirrorWarmupInput): TurnEndMirrorWarmupPlan {
  if (!input.terminal) return 'skip';
  if (!input.gitBacked) return 'skip';
  if (!Number.isFinite(input.coalesceWindowMs) || input.coalesceWindowMs <= 0) return 'skip';
  return 'warm';
}

/**
 * Kick the warm-up for one session's project. Never throws, never awaited by a
 * request — a manifest fetch must not be able to fail a turn-end report.
 *
 * The collaborators are imported lazily on purpose. This module is imported by
 * `routes/r4.ts`, and binding `db` and the mirror at module-evaluation time
 * would pull both into every suite that imports the route — the hazard
 * `pre-prompt-env-sync.ts` documents at length. Nothing here runs unless a turn
 * actually ended.
 */
export function warmProjectMirrorAfterTurn(input: { projectId: string; terminal: boolean }): void {
  if (!input.terminal) return;
  void (async () => {
    const [{ db }, { projects }, { eq }, mirror] = await Promise.all([
      import('../../shared/db'),
      import('@kortix/db'),
      import('drizzle-orm'),
      import('./mirror'),
    ]);
    const [project] = await db
      .select({
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        manifestPath: projects.manifestPath,
      })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    // STAMP BEFORE FETCHING, never after. The fetch then completes strictly
    // after the turn-end mark, which is exactly the ordering the prompt path
    // reads to decide it may reuse this refresh forever. Stamping afterwards
    // would leave the two equal (or inverted) and every prompt would fetch.
    mirror.noteTurnEnded(input.projectId);
    const plan = planTurnEndMirrorWarmup({
      terminal: input.terminal,
      coalesceWindowMs: mirror.forcedRefreshCoalesceMs(),
      gitBacked: !!project?.repoUrl,
    });
    if (plan !== 'warm') return;
    const t0 = Date.now();
    await mirror.refreshMirror(
      {
        projectId: input.projectId,
        repoUrl: project!.repoUrl,
        defaultBranch: project!.defaultBranch,
        manifestPath: project!.manifestPath,
      },
      true,
    );
    console.info('[git-mirror] warmed after turn end', {
      projectId: input.projectId,
      ms: Date.now() - t0,
    });
  })().catch((err) =>
    console.warn(
      `[git-mirror] turn-end warm-up failed for ${input.projectId}:`,
      err instanceof Error ? err.message : err,
    ),
  );
}
