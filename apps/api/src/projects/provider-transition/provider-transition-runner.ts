/**
 * Drives ONE provider-migration transition through prepare → build → verify →
 * activate. Every side-effecting collaborator (db, provider, builder, git) is
 * injected via `TransitionDeps`, so the whole flow is testable with fakes and
 * against a throwaway Postgres, and re-entrant: a crash at any phase leaves a
 * durable row the reconciler re-drives idempotently.
 *
 * Red-team invariants honored here:
 *  #1 transition rows are immutable in {commit,base,target}; a drift creates a
 *     NEW row + supersedes this one (never mutates a building sha). Activation is
 *     the store's generation-predicated conditional UPDATE.
 *  #3 the persisted row (status=building set BEFORE the provider call) + the
 *     content-addressed snapshot_name ARE the idempotency key; the builder GETs
 *     provider state by that key before building, so a restart never dup-builds.
 *     Every write is fenced behind the lease.
 *  #4 resumes every non-terminal status idempotently; attempts/error-class/
 *     next_retry_at are persisted; errors are classified, never "assume missing".
 *  #5 the exact external_template_id is GET-verified immediately before activation
 *     (a GC'd image ⇒ rebuild, not a stale activation).
 */
import type { GitBackedProject } from '../git';
import type { SandboxProviderAdapter } from '../../snapshots/providers';
import type { Database } from '@kortix/db';
import {
  MAX_TRANSITION_ATTEMPTS,
  classifyTransitionFailure,
  decideActivation,
  interpretImageReadiness,
  isPermanentTransitionError,
  isSupersededByGeneration,
  prepIdentityUnchanged,
  transitionBackoffMs,
  type PrepIdentity,
} from './provider-transition-core';
import {
  acquireLease,
  activateWithCas,
  failTransition,
  findLiveTransitionByIdentity,
  getTransition,
  insertPrebuildTransition,
  maxLiveSwitchGeneration,
  releaseForRetry,
  reserveSwitchTransition,
  updateTransition,
  writeTransitionMarker,
  type ProviderTransitionRow,
} from './provider-transition-store';
import { emitProviderTransitionEvent } from './provider-transition-metrics';

export const LEASE_TTL_MS = 10 * 60 * 1000;
/** How long a prebuild `ready` row rests before the worker re-verifies its tip
 *  + image (cheap idempotent re-check; also catches a moved tip → rebuild). */
export const PREBUILD_RECHECK_MS = 10 * 60 * 1000;

export type ResolvedPrepIdentity = Pick<PrepIdentity, 'commitSha' | 'baseRuntimeIdentity' | 'snapshotName'>;

export interface TransitionDeps {
  db: Database;
  now: () => Date;
  getProvider: (id: string) => Pick<
    SandboxProviderAdapter,
    'getSnapshotState' | 'getSnapshotExternalId' | 'deleteSnapshot'
  >;
  /** Reuse the existing ppwarm builder — build (or reuse) the target's image. */
  ensureWarmImage: (
    project: GitBackedProject,
    opts: { provider: string; accountId?: string },
  ) => Promise<{ snapshotName: string; built: boolean }>;
  /** Resolve the CURRENT prep identity (tip + base runtime + ppwarm name). */
  resolvePrepIdentity: (project: GitBackedProject, targetProvider: string) => Promise<ResolvedPrepIdentity>;
  /** Load a project as GitBackedProject + accountId (null ⇒ gone). */
  loadProject: (projectId: string) => Promise<(GitBackedProject & { accountId: string }) | null>;
  leaseTtlMs?: number;
  /** Fire-and-forget re-drive of a freshly created (drift) transition. */
  kick?: (transitionId: string) => void;
}

export type DriveOutcome =
  | 'not_leased'
  | 'activated'
  | 'lost_cas'
  | 'building'
  | 'waiting'
  | 'rebuilt'
  | 'prebuilt'
  | 'superseded'
  | 'failed'
  | 'gone';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify + persist a failure, keeping the SOURCE provider active in every
 * case. Permanent (auth/authorization/invalid-build) fails immediately + alerts;
 * a transient failure with attempts left is released for a backed-off retry.
 */
async function recordFailure(
  deps: TransitionDeps,
  row: ProviderTransitionRow,
  err: unknown,
): Promise<DriveOutcome> {
  const attempts = (row.attempts ?? 0) + 1;
  const permanent = isPermanentTransitionError(err);
  const { action } = classifyTransitionFailure({ err, attempts });
  const errorClass = permanent ? 'auth_terminal' : attempts >= MAX_TRANSITION_ATTEMPTS ? 'exhausted' : 'transient';
  if (action === 'fail') {
    await failTransition(deps.db, row.transitionId, { attempts, lastError: errMsg(err), errorClass });
    emitProviderTransitionEvent('preparation_failed', {
      target: row.targetProvider,
      source: row.sourceProvider,
      projectId: row.projectId,
      transitionId: row.transitionId,
      attempts,
      error: errMsg(err),
    });
    return 'failed';
  }
  const nextRetryAt = new Date(deps.now().getTime() + transitionBackoffMs(attempts));
  await releaseForRetry(deps.db, row.transitionId, {
    attempts,
    lastError: errMsg(err),
    errorClass,
    nextRetryAt,
    status: row.status === 'pending' ? 'pending' : 'building',
  });
  return 'building';
}

/** Create a fresh transition for the CURRENT identity + supersede the stale one. */
async function forkNewIdentity(
  deps: TransitionDeps,
  row: ProviderTransitionRow,
  current: ResolvedPrepIdentity,
): Promise<DriveOutcome> {
  const identity: PrepIdentity = {
    projectId: row.projectId,
    targetProvider: row.targetProvider,
    commitSha: current.commitSha,
    baseRuntimeIdentity: current.baseRuntimeIdentity,
    snapshotName: current.snapshotName,
  };
  let newId: string | null = null;
  if (row.mode === 'switch') {
    // reserveSwitchTransition bumps the generation and supersedes older live
    // switches (this row included, since it has a lower generation).
    const res = await reserveSwitchTransition(deps.db, {
      accountId: row.accountId,
      sourceProvider: row.sourceProvider,
      identity,
    });
    newId = res.row.transitionId;
  } else {
    const res = await insertPrebuildTransition(deps.db, {
      accountId: row.accountId,
      sourceProvider: row.sourceProvider,
      identity,
    });
    newId = res.row.transitionId;
    await updateTransition(deps.db, row.transitionId, { status: 'superseded', heartbeatAt: null });
  }
  emitProviderTransitionEvent('rebuild_new_identity', {
    target: row.targetProvider,
    source: row.sourceProvider,
    projectId: row.projectId,
    transitionId: row.transitionId,
    snapshotName: current.snapshotName,
  });
  if (newId && newId !== row.transitionId) deps.kick?.(newId);
  return 'rebuilt';
}

export async function driveProviderTransition(
  deps: TransitionDeps,
  transitionId: string,
): Promise<DriveOutcome> {
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS;
  const leased = await acquireLease(deps.db, transitionId, ttl, deps.now());
  if (!leased) return 'not_leased';

  try {
    const project = await deps.loadProject(leased.projectId);
    if (!project) {
      await failTransition(deps.db, transitionId, {
        attempts: leased.attempts ?? 0,
        lastError: 'project no longer exists',
        errorClass: 'gone',
      });
      return 'gone';
    }

    // ── Re-resolve the CURRENT identity (tip may have moved) ─────────────────
    const current = await deps.resolvePrepIdentity(project, leased.targetProvider);

    // Drift ⇒ this row's prepared image is for a stale identity. Fork a new row
    // (immutability: never mutate this row's sha) and supersede this one.
    if (
      leased.commitSha != null &&
      leased.baseRuntimeIdentity != null &&
      !prepIdentityUnchanged(
        { commitSha: leased.commitSha, baseRuntimeIdentity: leased.baseRuntimeIdentity },
        current,
      )
    ) {
      return await forkNewIdentity(deps, leased, current);
    }

    // Supersession: a newer switch reserved a higher generation.
    if (leased.mode === 'switch' && leased.generation != null) {
      const maxLive = await maxLiveSwitchGeneration(deps.db, leased.projectId);
      if (isSupersededByGeneration(leased.generation, maxLive)) {
        await updateTransition(deps.db, transitionId, { status: 'superseded', heartbeatAt: null });
        emitProviderTransitionEvent('stale_build_superseded', {
          target: leased.targetProvider,
          projectId: leased.projectId,
          transitionId,
          generation: leased.generation,
        });
        return 'superseded';
      }
    }

    const provider = deps.getProvider(leased.targetProvider);
    const snapshotName = current.snapshotName;

    // ── Build / adopt phase ──────────────────────────────────────────────────
    let readiness = interpretImageReadiness(await provider.getSnapshotState(snapshotName));

    if (readiness === 'indeterminate') {
      // Provider couldn't confirm — NEVER read as "missing". Bounded retry.
      return await recordFailure(deps, leased, new Error('provider state indeterminate (unknown)'));
    }

    if (readiness !== 'ready') {
      // Persist intent BEFORE the external build call; the content-addressed
      // snapshot_name is the idempotency key the builder re-checks internally.
      await updateTransition(deps.db, transitionId, {
        status: 'building',
        startedAt: leased.startedAt ?? deps.now(),
      });
      await writeMarker(deps, leased, 'building', snapshotName);
      const queueSeconds = (deps.now().getTime() - leased.requestedAt.getTime()) / 1000;
      emitProviderTransitionEvent('build_started', {
        target: leased.targetProvider,
        projectId: leased.projectId,
        transitionId,
        snapshotName,
        queueSeconds,
      });
      const buildStart = deps.now().getTime();
      try {
        await deps.ensureWarmImage(project, { provider: leased.targetProvider, accountId: leased.accountId });
      } catch (err) {
        return await recordFailure(deps, leased, err);
      }
      const buildSeconds = (deps.now().getTime() - buildStart) / 1000;
      // Confirm the provider actually has it now (never trust the builder's word
      // alone — GET the truth).
      readiness = interpretImageReadiness(await provider.getSnapshotState(snapshotName));
      if (readiness !== 'ready') {
        return await recordFailure(
          deps,
          leased,
          new Error(`image ${snapshotName} not ready after build (state=${readiness})`),
        );
      }
      emitProviderTransitionEvent('build_succeeded', {
        target: leased.targetProvider,
        projectId: leased.projectId,
        transitionId,
        snapshotName,
        buildSeconds,
      });
    } else {
      // Image already active on the provider → no rebuild (scenario 2).
      emitProviderTransitionEvent('existing_image_reused', {
        target: leased.targetProvider,
        projectId: leased.projectId,
        transitionId,
        snapshotName,
      });
    }

    // Record the exact external template id + mark ready.
    const externalTemplateId = provider.getSnapshotExternalId
      ? await provider.getSnapshotExternalId(snapshotName).catch(() => null)
      : null;
    await updateTransition(deps.db, transitionId, {
      status: 'ready',
      readyAt: leased.readyAt ?? deps.now(),
      externalTemplateId,
    });
    const timeToReadySeconds = (deps.now().getTime() - leased.requestedAt.getTime()) / 1000;
    emitProviderTransitionEvent('build_succeeded', {
      target: leased.targetProvider,
      projectId: leased.projectId,
      transitionId,
      snapshotName,
      externalTemplateId,
      timeToReadySeconds,
    });

    // ── Prebuild rests at ready (invisible to routing until adopted) ─────────
    if (leased.mode === 'prebuild') {
      await releaseForRetry(deps.db, transitionId, {
        attempts: 0,
        lastError: 'prebuilt; awaiting adoption',
        errorClass: 'none',
        nextRetryAt: new Date(deps.now().getTime() + PREBUILD_RECHECK_MS),
        status: 'ready',
      });
      return 'prebuilt';
    }

    // ── Verify (re-read the world) + activate ────────────────────────────────
    const fresh = await getTransition(deps.db, transitionId);
    if (!fresh || fresh.status !== 'ready' && fresh.status !== 'activating') return 'superseded';
    const current2 = await deps.resolvePrepIdentity(project, leased.targetProvider);
    const maxLive2 = await maxLiveSwitchGeneration(deps.db, leased.projectId);
    // GET the exact id immediately before activation (a GC'd image ⇒ absent).
    const stateBefore = await provider.getSnapshotState(snapshotName);
    const decision = decideActivation({
      cancelled: false,
      supersededByNewer:
        leased.generation != null && isSupersededByGeneration(leased.generation, maxLive2),
      tipMatches: current2.commitSha === leased.commitSha,
      runtimeMatches: current2.baseRuntimeIdentity === leased.baseRuntimeIdentity,
      imageReadiness: interpretImageReadiness(stateBefore),
    });

    if (decision === 'rebuild') return await forkNewIdentity(deps, leased, current2);
    if (decision === 'supersede') {
      await updateTransition(deps.db, transitionId, { status: 'superseded', heartbeatAt: null });
      emitProviderTransitionEvent('stale_build_superseded', {
        target: leased.targetProvider,
        projectId: leased.projectId,
        transitionId,
      });
      return 'superseded';
    }
    if (decision === 'wait' || decision === 'cancelled') {
      return await recordFailure(deps, leased, new Error('image not confirmed ready at verify'));
    }

    // decision === 'activate'
    await updateTransition(deps.db, transitionId, { status: 'activating' });
    const freshExternalId = provider.getSnapshotExternalId
      ? await provider.getSnapshotExternalId(snapshotName).catch(() => externalTemplateId)
      : externalTemplateId;
    const result = await activateWithCas(deps.db, {
      projectId: leased.projectId,
      transitionId,
      targetProvider: leased.targetProvider,
      generation: leased.generation!,
      snapshotName,
      externalTemplateId: freshExternalId,
      now: deps.now(),
    });
    if (result.activated) {
      emitProviderTransitionEvent('activation_completed', {
        target: leased.targetProvider,
        source: leased.sourceProvider,
        projectId: leased.projectId,
        transitionId,
        generation: leased.generation!,
        snapshotName,
        externalTemplateId: freshExternalId,
        timeToReadySeconds,
      });
      return 'activated';
    }
    if (result.reason === 'lost_cas') {
      emitProviderTransitionEvent('activation_lost_cas', {
        target: leased.targetProvider,
        projectId: leased.projectId,
        transitionId,
        generation: leased.generation!,
      });
      return 'lost_cas';
    }
    await failTransition(deps.db, transitionId, {
      attempts: (leased.attempts ?? 0) + 1,
      lastError: 'project missing at activation',
      errorClass: 'gone',
    });
    return 'gone';
  } catch (err) {
    // Any unexpected throw during the drive → bounded retry (fenced by the lease
    // we still hold; the row stays live so the worker re-drives it).
    const fresh = (await getTransition(deps.db, transitionId).catch(() => null)) ?? leased;
    return await recordFailure(deps, fresh, err);
  }
}

async function writeMarker(
  deps: TransitionDeps,
  row: ProviderTransitionRow,
  status: string,
  snapshotName: string,
): Promise<void> {
  await writeTransitionMarker(deps.db, row.projectId, {
    status,
    target_provider: row.targetProvider,
    source_provider: row.sourceProvider,
    generation: row.generation,
    snapshot_name: snapshotName,
    transition_id: row.transitionId,
    updated_at: deps.now().toISOString(),
  }).catch(() => {});
}
