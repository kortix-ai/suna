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
  DEFAULT_MAX_BUILDING_MS,
  MAX_TRANSITION_ATTEMPTS,
  classifyTransitionFailure,
  decideActivation,
  interpretImageReadiness,
  isBuildDeadlineExceeded,
  isHealthyBuildingReadiness,
  isPermanentTransitionError,
  isSupersededByGeneration,
  prepIdentityUnchanged,
  transitionBackoffMs,
  type ImageReadiness,
  type PrepIdentity,
} from './provider-transition-core';
import {
  acquireLease,
  activateWithCas,
  failTransition,
  findLiveTransitionByIdentity,
  getTransition,
  heartbeat,
  insertPrebuildTransition,
  maxLiveSwitchGeneration,
  releaseForRetry,
  releaseForWaiting,
  reserveSwitchTransition,
  updateTransition,
  writeTransitionMarker,
  type ProviderTransitionRow,
} from './provider-transition-store';
import { emitProviderTransitionEvent } from './provider-transition-metrics';

/**
 * Thrown when a drive-time fenced write matches 0 rows — this drive no longer
 * owns the lease (a newer owner re-acquired and bumped the epoch). The drive
 * ceases SILENTLY (no error log, no failTransition): the current owner is
 * driving the row. Named so lower layers (the build wait loop) can duck-type it
 * without importing across the provider boundary.
 */
export class LeaseLostError extends Error {
  constructor() {
    super('provider-transition drive lost its lease (fenced out by a newer owner)');
    this.name = 'LeaseLostError';
  }
}

/** Throw {@link LeaseLostError} when a fenced store write reports 0 rows. */
async function mustOwn(written: Promise<boolean>): Promise<void> {
  if (!(await written)) throw new LeaseLostError();
}

export const LEASE_TTL_MS = 10 * 60 * 1000;
/** How long a prebuild `ready` row rests before the worker re-verifies its tip
 *  + image (cheap idempotent re-check; also catches a moved tip → rebuild). */
export const PREBUILD_RECHECK_MS = 10 * 60 * 1000;
/** Poll interval while a HEALTHY build is in progress on the target provider.
 *  Long: a Platinum build runs minutes to ~45 min; re-driving too eagerly just
 *  hammers the provider's template GET. This is a WAIT, never a failed attempt. */
export const BUILDING_POLL_MS = (() => {
  const raw = Number.parseInt(process.env.KORTIX_TRANSITION_BUILDING_POLL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();
/** Overall wall-clock deadline for a `building` transition. A healthy build
 *  never consumes a failure attempt (BUILDING ≠ FAILURE), so this bound is what
 *  stops a provider that reports `building` forever from polling forever and
 *  starving the resumable batch: once elapsed since `startedAt` crosses this, the
 *  transition fails terminally with errorClass 'build_timeout'. */
export const MAX_BUILDING_MS = (() => {
  const raw = Number.parseInt(process.env.KORTIX_TRANSITION_MAX_BUILDING_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BUILDING_MS;
})();

export type ResolvedPrepIdentity = Pick<PrepIdentity, 'commitSha' | 'baseRuntimeIdentity' | 'snapshotName'>;

export interface TransitionDeps {
  db: Database;
  now: () => Date;
  getProvider: (id: string) => Pick<
    SandboxProviderAdapter,
    'getSnapshotState' | 'getSnapshotExternalId' | 'getSnapshotStateByExternalId' | 'deleteSnapshot'
  >;
  /** Reuse the existing ppwarm builder — build (or reuse) the target's image.
   *  `opts.heartbeat` renews the lease during the (up to ~12-min) provider build
   *  wait; it RESOLVES while still owned and THROWS {@link LeaseLostError} once a
   *  newer owner re-acquired, so a lease outrun by a long build never lapses into
   *  a double-drive. Threaded down into the provider's waitForActive poll loop. */
  ensureWarmImage: (
    project: GitBackedProject,
    opts: { provider: string; accountId?: string; heartbeat?: () => Promise<void> },
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
  epoch: number,
): Promise<DriveOutcome> {
  const attempts = (row.attempts ?? 0) + 1;
  const permanent = isPermanentTransitionError(err);
  const { action } = classifyTransitionFailure({ err, attempts });
  const errorClass = permanent ? 'auth_terminal' : attempts >= MAX_TRANSITION_ATTEMPTS ? 'exhausted' : 'transient';
  if (action === 'fail') {
    // Fenced: if we lost the lease, do NOT dead-letter a succeeded switch — cease.
    if (!(await failTransition(deps.db, row.transitionId, { attempts, lastError: errMsg(err), errorClass }, epoch))) {
      return 'not_leased';
    }
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
  if (
    !(await releaseForRetry(
      deps.db,
      row.transitionId,
      {
        attempts,
        lastError: errMsg(err),
        errorClass,
        nextRetryAt,
        status: row.status === 'pending' ? 'pending' : 'building',
      },
      epoch,
    ))
  ) {
    return 'not_leased';
  }
  return 'building';
}

/**
 * Persist a HEALTHY build-in-progress wait: the target provider reports
 * `building`, so we mark the row `building`, mirror the marker, and schedule a
 * poll of the EXACT image — WITHOUT incrementing attempts (BUILDING ≠ FAILURE).
 * A long, healthy Platinum build therefore never dead-letters by exhausting the
 * failure budget; only real operation/build faults consume attempts (via
 * {@link recordFailure}). Emits a `build_waiting` heartbeat, not a failure.
 */
async function recordWaiting(
  deps: TransitionDeps,
  row: ProviderTransitionRow,
  snapshotName: string,
  note: string,
  epoch: number,
): Promise<DriveOutcome> {
  await writeMarker(deps, row, 'building', snapshotName);
  const nextRetryAt = new Date(deps.now().getTime() + BUILDING_POLL_MS);
  if (!(await releaseForWaiting(deps.db, row.transitionId, { nextRetryAt, note }, epoch))) {
    return 'not_leased';
  }
  emitProviderTransitionEvent('build_waiting', {
    target: row.targetProvider,
    source: row.sourceProvider,
    projectId: row.projectId,
    transitionId: row.transitionId,
    snapshotName,
    attempts: row.attempts ?? 0,
  });
  return 'waiting';
}

/**
 * Wall-clock-bounded {@link recordWaiting}. BUILDING ≠ FAILURE (never consumes an
 * attempt) but BUILDING ≠ FOREVER: stamp `startedAt` on the first building
 * observation, and once elapsed since it crosses {@link MAX_BUILDING_MS}, FAIL
 * terminally with errorClass 'build_timeout' (not retried — a build the provider
 * reports `building` past the deadline is stuck, and polling it forever starves
 * the 5-row resumable batch). Otherwise persist `building` + `startedAt` and wait
 * WITHOUT consuming an attempt. The caller passes a row whose `startedAt` is the
 * effective start (`leased.startedAt ?? now`).
 */
async function recordBuildingOrTimeout(
  deps: TransitionDeps,
  row: ProviderTransitionRow,
  snapshotName: string,
  note: string,
  epoch: number,
): Promise<DriveOutcome> {
  const startedAt = row.startedAt ?? deps.now();
  if (isBuildDeadlineExceeded({ startedAt, now: deps.now(), maxBuildingMs: MAX_BUILDING_MS })) {
    if (
      !(await failTransition(deps.db, row.transitionId, {
        attempts: row.attempts ?? 0,
        lastError: `image ${snapshotName} still building past the ${MAX_BUILDING_MS}ms wall-clock deadline`,
        errorClass: 'build_timeout',
      }, epoch))
    ) {
      return 'not_leased';
    }
    emitProviderTransitionEvent('preparation_failed', {
      target: row.targetProvider,
      source: row.sourceProvider,
      projectId: row.projectId,
      transitionId: row.transitionId,
      attempts: row.attempts ?? 0,
      error: 'build_timeout',
    });
    return 'failed';
  }
  // Persist `startedAt` so the wall-clock is anchored from the FIRST building
  // observation even on the verify path (which didn't set it) — idempotent once
  // set, since later drives lease the persisted non-null value.
  if (!(await updateTransition(deps.db, row.transitionId, { status: 'building', startedAt }, epoch))) {
    return 'not_leased';
  }
  return await recordWaiting(deps, { ...row, startedAt }, snapshotName, note, epoch);
}

/** Create a fresh transition for the CURRENT identity + supersede the stale one. */
async function forkNewIdentity(
  deps: TransitionDeps,
  row: ProviderTransitionRow,
  current: ResolvedPrepIdentity,
  epoch: number,
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
    if (!(await updateTransition(deps.db, row.transitionId, { status: 'superseded', heartbeatAt: null }, epoch))) {
      return 'not_leased';
    }
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
  // The fencing token this drive OWNS. Every drive-time state write + the
  // activation CAS is predicated on it; a newer owner re-acquiring bumps it, so
  // this drive's writes then match 0 rows and it ceases silently (LeaseLostError).
  const myEpoch = leased.leaseEpoch ?? 0;
  // Renew the lease during the long provider build wait so the 10-min TTL never
  // lapses mid-build (a 30-40 min build otherwise expires the lease and the resume
  // worker double-drives). Resolves while owned; throws LeaseLostError on a clean
  // revocation; swallows a transient DB error (do NOT abort a 30-min build).
  const heartbeatCb = async (): Promise<void> => {
    let owned: boolean;
    try {
      owned = await heartbeat(deps.db, transitionId, myEpoch);
    } catch {
      return;
    }
    if (!owned) throw new LeaseLostError();
  };

  try {
    const project = await deps.loadProject(leased.projectId);
    if (!project) {
      await mustOwn(
        failTransition(deps.db, transitionId, {
          attempts: leased.attempts ?? 0,
          lastError: 'project no longer exists',
          errorClass: 'gone',
        }, myEpoch),
      );
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
      return await forkNewIdentity(deps, leased, current, myEpoch);
    }

    // Supersession: a newer switch reserved a higher generation.
    if (leased.mode === 'switch' && leased.generation != null) {
      const maxLive = await maxLiveSwitchGeneration(deps.db, leased.projectId);
      if (isSupersededByGeneration(leased.generation, maxLive)) {
        await mustOwn(updateTransition(deps.db, transitionId, { status: 'superseded', heartbeatAt: null }, myEpoch));
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
      return await recordFailure(deps, leased, new Error('provider state indeterminate (unknown)'), myEpoch);
    }

    // BUILDING ≠ FAILURE: the image is ALREADY building on the target (a prior
    // drive, another replica, or an on-push ppwarm bake kicked the same
    // content-addressed name). Do NOT call ensureWarmImage again (that would
    // duplicate the build) and do NOT increment attempts — persist `building`
    // and poll THIS exact image later.
    if (isHealthyBuildingReadiness(readiness)) {
      return await recordBuildingOrTimeout(
        deps,
        { ...leased, startedAt: leased.startedAt ?? deps.now() },
        snapshotName,
        'image already building on target',
        myEpoch,
      );
    }

    const buildStartedAt = leased.startedAt ?? deps.now();
    if (readiness !== 'ready') {
      // Persist intent BEFORE the external build call; the content-addressed
      // snapshot_name is the idempotency key the builder re-checks internally.
      await mustOwn(updateTransition(deps.db, transitionId, {
        status: 'building',
        startedAt: buildStartedAt,
      }, myEpoch));
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
        await deps.ensureWarmImage(project, {
          provider: leased.targetProvider,
          accountId: leased.accountId,
          heartbeat: heartbeatCb,
        });
      } catch (err) {
        // A heartbeat inside the build wait detected a lost lease → cease silently.
        if (err instanceof LeaseLostError) throw err;
        return await recordFailure(deps, leased, err, myEpoch);
      }
      const buildSeconds = (deps.now().getTime() - buildStart) / 1000;
      // Confirm the provider actually has it now (never trust the builder's word
      // alone — GET the truth).
      readiness = interpretImageReadiness(await provider.getSnapshotState(snapshotName));
      // A provider still reporting `building` after ensureWarmImage returned is a
      // HEALTHY async build in flight (Platinum registers a build then completes
      // it out of band, well past this drive's deadline). Persist `building` and
      // poll the exact image WITHOUT consuming an attempt — the whole point of
      // BUILDING ≠ FAILURE. Only absent/failed/indeterminate count as failures.
      if (isHealthyBuildingReadiness(readiness)) {
        return await recordBuildingOrTimeout(
          deps,
          { ...leased, startedAt: buildStartedAt },
          snapshotName,
          `build in progress (state=${readiness})`,
          myEpoch,
        );
      }
      if (readiness !== 'ready') {
        return await recordFailure(
          deps,
          leased,
          new Error(`image ${snapshotName} not ready after build (state=${readiness})`),
          myEpoch,
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
    await mustOwn(updateTransition(deps.db, transitionId, {
      status: 'ready',
      readyAt: leased.readyAt ?? deps.now(),
      externalTemplateId,
      // Reset-on-healthy: reaching `ready` is confirmed forward progress, so any
      // transient attempts burned on the way here are cleared (a later verify
      // hiccup then gets the full bounded-retry budget, never a stale count).
      attempts: 0,
    }, myEpoch));
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
      await mustOwn(releaseForRetry(deps.db, transitionId, {
        attempts: 0,
        lastError: 'prebuilt; awaiting adoption',
        errorClass: 'none',
        nextRetryAt: new Date(deps.now().getTime() + PREBUILD_RECHECK_MS),
        status: 'ready',
      }, myEpoch));
      return 'prebuilt';
    }

    // ── Verify (re-read the world) + activate ────────────────────────────────
    const fresh = await getTransition(deps.db, transitionId);
    if (!fresh || fresh.status !== 'ready' && fresh.status !== 'activating') return 'superseded';
    const current2 = await deps.resolvePrepIdentity(project, leased.targetProvider);
    const maxLive2 = await maxLiveSwitchGeneration(deps.db, leased.projectId);
    // Red-team #5: verify the EXACT external template id we captured, immediately
    // before activation. Reading the exact provider row BY ID can't be fooled by
    // the truncated name-list pagination getSnapshotState relies on, so a GC'd
    // image or a wrong/idempotently-reused name surfaces as 'absent' ⇒ rebuild,
    // never a stale-name activation. Fall back to the name-based state only for
    // providers (or fakes) without the by-id method, or when we hold no id yet.
    const verifyReadiness: ImageReadiness =
      externalTemplateId && provider.getSnapshotStateByExternalId
        ? interpretImageReadiness(
            await provider.getSnapshotStateByExternalId(externalTemplateId).catch(() => 'unknown'),
          )
        : interpretImageReadiness(await provider.getSnapshotState(snapshotName));
    const decision = decideActivation({
      cancelled: false,
      supersededByNewer:
        leased.generation != null && isSupersededByGeneration(leased.generation, maxLive2),
      tipMatches: current2.commitSha === leased.commitSha,
      runtimeMatches: current2.baseRuntimeIdentity === leased.baseRuntimeIdentity,
      imageReadiness: verifyReadiness,
    });

    if (decision === 'rebuild') return await forkNewIdentity(deps, leased, current2, myEpoch);
    if (decision === 'supersede') {
      await mustOwn(updateTransition(deps.db, transitionId, { status: 'superseded', heartbeatAt: null }, myEpoch));
      emitProviderTransitionEvent('stale_build_superseded', {
        target: leased.targetProvider,
        projectId: leased.projectId,
        transitionId,
      });
      return 'superseded';
    }
    if (decision === 'wait' || decision === 'cancelled') {
      // A `building` image at verify is a HEALTHY async build still completing —
      // re-poll it (bounded by the wall-clock), NEVER consume an attempt. Only an
      // indeterminate / cancelled verify falls back to a bounded retry.
      if (verifyReadiness === 'building') {
        return await recordBuildingOrTimeout(
          deps,
          { ...leased, startedAt: leased.startedAt ?? deps.now() },
          snapshotName,
          'image still building at verify',
          myEpoch,
        );
      }
      return await recordFailure(deps, leased, new Error('image not confirmed ready at verify'), myEpoch);
    }

    // decision === 'activate' — pin the EXACT id we just verified, NOT a
    // name-re-resolved one (which could resolve to a different/newer row).
    await mustOwn(updateTransition(deps.db, transitionId, { status: 'activating' }, myEpoch));
    const result = await activateWithCas(deps.db, {
      projectId: leased.projectId,
      transitionId,
      targetProvider: leased.targetProvider,
      generation: leased.generation!,
      snapshotName,
      externalTemplateId,
      now: deps.now(),
      leaseEpoch: myEpoch,
    });
    if (result.activated) {
      emitProviderTransitionEvent('activation_completed', {
        target: leased.targetProvider,
        source: leased.sourceProvider,
        projectId: leased.projectId,
        transitionId,
        generation: leased.generation!,
        snapshotName,
        externalTemplateId,
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
    // Fenced out at activation (a newer owner re-acquired at the SAME generation) —
    // the pin was NOT touched. Cease silently; the current owner activates.
    if (result.reason === 'lost_lease') return 'not_leased';
    await mustOwn(failTransition(deps.db, transitionId, {
      attempts: (leased.attempts ?? 0) + 1,
      lastError: 'project missing at activation',
      errorClass: 'gone',
    }, myEpoch));
    return 'gone';
  } catch (err) {
    // Lost the lease mid-drive (a fenced write matched 0 rows, or a build-wait
    // heartbeat detected revocation) → cease SILENTLY: no error, no failTransition.
    if (err instanceof LeaseLostError) return 'not_leased';
    // Any other unexpected throw → bounded retry, itself fenced by our epoch so a
    // drive that lost the lease can't dead-letter the row (recordFailure returns
    // 'not_leased' when its write matches nothing).
    const fresh = (await getTransition(deps.db, transitionId).catch(() => null)) ?? leased;
    return await recordFailure(deps, fresh, err, myEpoch);
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
