/**
 * Durable store for provider-migration transitions. All SQL lives here so the
 * runner/worker stay logic-only and the CAS/lease/dedup guarantees are in one
 * auditable place. Every function takes an injected `Database` so it runs
 * against the app db, a transaction, or a throwaway test Postgres identically.
 *
 * Invariants enforced here (red-team #1/#3/#5):
 *  - the generation is reserved ON THE PROJECT ROW (projects.sandbox_provider_generation)
 *    under a FOR UPDATE lock at switch-REQUEST time — the atomic allocator;
 *  - activation is ONE conditional UPDATE in ONE transaction, predicated on the
 *    project's generation still equalling the transition's stamped generation;
 *  - a transition row is IMMUTABLE in {commit_sha, base_runtime_identity,
 *    target_provider} — a drift creates a NEW row (never mutates a building sha);
 *  - the live-identity unique index dedups repeated switch calls; failed/
 *    superseded/cancelled rows never block a fresh switch.
 */
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { providerTransitions, projects, type Database } from '@kortix/db';
import {
  LIVE_TRANSITION_STATUSES,
  canActivateGeneration,
  type PrepIdentity,
  type ProviderTransitionStatus,
} from './provider-transition-core';

export type ProviderTransitionRow = typeof providerTransitions.$inferSelect;

/** Accepts the app db OR a transaction handle — the query-builder surface both
 *  expose — so helpers can be called inside a `db.transaction(tx => …)` block. */
export type Queryable = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

const LIVE = [...LIVE_TRANSITION_STATUSES];

export const PIN_META_KEY = 'default_sandbox_provider';
export const ACTIVE_EXTERNAL_ID_META_KEY = 'active_sandbox_external_template_id';
/** Compact marker mirrored into project metadata so the existing project
 *  response (which passes `metadata` through) is pollable without a schema
 *  change to @kortix/api-contract. */
export const TRANSITION_META_KEY = 'sandbox_provider_transition';

function asMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

// ─── Routing read (red-team #2) ──────────────────────────────────────────────

export interface ActiveRouting {
  /** The pin routing uses. Written ONLY at activation — never the in-flight
   *  target of a not-yet-activated transition. null ⇒ follow platform default. */
  activeProvider: string | null;
  /** The exact provider template id activation pinned. Boot should pin by this. */
  activeExternalTemplateId: string | null;
  generation: number;
}

/**
 * Read the active routing identity from a SINGLE project row — pin + activated
 * external template id are written together in the activation transaction, so a
 * single row read gets them atomically. No path may derive the active provider
 * from an in-flight transition.
 */
export async function readActiveRouting(db: Database, projectId: string): Promise<ActiveRouting | null> {
  const [row] = await db
    .select({ metadata: projects.metadata, generation: projects.sandboxProviderGeneration })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row) return null;
  const meta = asMeta(row.metadata);
  const pin = meta[PIN_META_KEY];
  const extId = meta[ACTIVE_EXTERNAL_ID_META_KEY];
  return {
    activeProvider: typeof pin === 'string' ? pin : null,
    activeExternalTemplateId: typeof extId === 'string' ? extId : null,
    generation: row.generation ?? 0,
  };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

export async function getTransition(
  db: Database,
  transitionId: string,
): Promise<ProviderTransitionRow | null> {
  const [row] = await db
    .select()
    .from(providerTransitions)
    .where(eq(providerTransitions.transitionId, transitionId))
    .limit(1);
  return row ?? null;
}

export async function findLiveTransitionByIdentity(
  db: Queryable,
  identity: Pick<PrepIdentity, 'projectId' | 'targetProvider' | 'commitSha' | 'baseRuntimeIdentity'>,
): Promise<ProviderTransitionRow | null> {
  const [row] = await db
    .select()
    .from(providerTransitions)
    .where(
      and(
        eq(providerTransitions.projectId, identity.projectId),
        eq(providerTransitions.targetProvider, identity.targetProvider as never),
        eq(providerTransitions.commitSha, identity.commitSha),
        eq(providerTransitions.baseRuntimeIdentity, identity.baseRuntimeIdentity),
        inArray(providerTransitions.status, LIVE),
      ),
    )
    .orderBy(desc(providerTransitions.requestedAt))
    .limit(1);
  return row ?? null;
}

export async function latestTransitionForProject(
  db: Database,
  projectId: string,
): Promise<ProviderTransitionRow | null> {
  const [row] = await db
    .select()
    .from(providerTransitions)
    .where(eq(providerTransitions.projectId, projectId))
    .orderBy(desc(providerTransitions.requestedAt))
    .limit(1);
  return row ?? null;
}

export async function listTransitionsForProject(
  db: Database,
  projectId: string,
  limit = 20,
): Promise<ProviderTransitionRow[]> {
  return db
    .select()
    .from(providerTransitions)
    .where(eq(providerTransitions.projectId, projectId))
    .orderBy(desc(providerTransitions.requestedAt))
    .limit(limit);
}

// ─── Reservation (atomic generation allocation) ──────────────────────────────

export interface ReserveResult {
  row: ProviderTransitionRow;
  created: boolean;
  adopted: boolean;
}

/**
 * Reserve a SWITCH transition for `identity`, allocating the generation on the
 * project row atomically:
 *   - if an identical in-flight SWITCH already exists → return it (idempotent);
 *   - if a live PREBUILD/switch row for the SAME identity exists → ADOPT it:
 *     bump the project generation, stamp it onto the row, flip mode→switch
 *     (a ready prebuild then goes straight to verify→activate, no rebuild);
 *   - else bump the project generation, supersede older live switches, and
 *     insert a fresh pending switch row.
 * All under a single project-row FOR UPDATE lock, so concurrent requests
 * serialize and every switch gets a strictly-newer generation than any it saw.
 */
export async function reserveSwitchTransition(
  db: Database,
  input: {
    accountId: string;
    sourceProvider: string;
    identity: PrepIdentity;
  },
): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ generation: projects.sandboxProviderGeneration })
      .from(projects)
      .where(eq(projects.projectId, input.identity.projectId))
      .for('update')
      .limit(1);
    if (!project) throw new Error(`project ${input.identity.projectId} not found`);

    const existing = await findLiveTransitionByIdentity(tx, input.identity);
    if (existing && existing.mode === 'switch' && existing.generation != null) {
      // Identical in-flight switch — idempotent, no new generation.
      return { row: existing, created: false, adopted: false };
    }

    const newGen = (project.generation ?? 0) + 1;
    await tx
      .update(projects)
      .set({ sandboxProviderGeneration: newGen, updatedAt: new Date() })
      .where(eq(projects.projectId, input.identity.projectId));

    // Newer intent supersedes any older live SWITCH (NULL-generation prebuilds
    // are excluded by `lt`, so a switch never nukes an unrelated prebuild).
    await tx
      .update(providerTransitions)
      .set({ status: 'superseded', heartbeatAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(providerTransitions.projectId, input.identity.projectId),
          inArray(providerTransitions.status, LIVE),
          lt(providerTransitions.generation, newGen),
          ...(existing ? [ne(providerTransitions.transitionId, existing.transitionId)] : []),
        ),
      );

    if (existing) {
      // Adopt a prebuild (or same-identity non-switch) row: stamp the reserved
      // generation + flip to switch so it activates when ready. Generation is
      // NOT in the immutable set, so re-stamping it is allowed. Clear the backoff
      // gate + heartbeat so the adopted row is immediately drivable (a ready
      // prebuild rests behind a next_retry_at gate that must not block the switch).
      const [row] = await tx
        .update(providerTransitions)
        .set({
          generation: newGen,
          mode: 'switch',
          heartbeatAt: null,
          nextRetryAt: null,
          attempts: 0,
          errorClass: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(providerTransitions.transitionId, existing.transitionId))
        .returning();
      return { row: row!, created: false, adopted: true };
    }

    const [row] = await tx
      .insert(providerTransitions)
      .values({
        accountId: input.accountId,
        projectId: input.identity.projectId,
        sourceProvider: input.sourceProvider as never,
        targetProvider: input.identity.targetProvider as never,
        generation: newGen,
        mode: 'switch',
        status: 'pending',
        commitSha: input.identity.commitSha,
        baseRuntimeIdentity: input.identity.baseRuntimeIdentity,
        snapshotName: input.identity.snapshotName,
      })
      .returning();
    return { row: row!, created: true, adopted: false };
  });
}

/**
 * Insert a PREBUILD transition (image only, no switch-intent, generation NULL)
 * unless a live row for the identity already exists (dedup via the live-identity
 * index). Does NOT touch the project generation, so a background prebuild can
 * never starve a user switch. Returns the existing row when one is present.
 */
export async function insertPrebuildTransition(
  db: Database,
  input: { accountId: string; sourceProvider: string; identity: PrepIdentity },
): Promise<{ row: ProviderTransitionRow; created: boolean }> {
  const existing = await findLiveTransitionByIdentity(db, input.identity);
  if (existing) return { row: existing, created: false };
  try {
    const [row] = await db
      .insert(providerTransitions)
      .values({
        accountId: input.accountId,
        projectId: input.identity.projectId,
        sourceProvider: input.sourceProvider as never,
        targetProvider: input.identity.targetProvider as never,
        generation: null,
        mode: 'prebuild',
        status: 'pending',
        commitSha: input.identity.commitSha,
        baseRuntimeIdentity: input.identity.baseRuntimeIdentity,
        snapshotName: input.identity.snapshotName,
      })
      .returning();
    return { row: row!, created: true };
  } catch (err) {
    // Lost a race to the live-identity unique index — adopt the winner.
    const raced = await findLiveTransitionByIdentity(db, input.identity);
    if (raced) return { row: raced, created: false };
    throw err;
  }
}

// ─── Drive-time writes (fenced by the lease) ─────────────────────────────────

export interface TransitionPatch {
  status?: ProviderTransitionStatus;
  externalTemplateId?: string | null;
  attempts?: number;
  lastError?: string | null;
  errorClass?: string | null;
  nextRetryAt?: Date | null;
  heartbeatAt?: Date | null;
  startedAt?: Date | null;
  readyAt?: Date | null;
  activatedAt?: Date | null;
}

export async function updateTransition(
  db: Database,
  transitionId: string,
  patch: TransitionPatch,
): Promise<void> {
  await db
    .update(providerTransitions)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(providerTransitions.transitionId, transitionId));
}

/**
 * Lease CAS — mirrors suna-migration acquireLease. Grabs the row only when it's
 * still live, its backoff gate has passed (next_retry_at null/≤now), AND its
 * heartbeat is null or older than the lease TTL, stamping a fresh heartbeat so a
 * second worker's identical UPDATE matches nothing. Returns the leased row or
 * null (someone else owns it / it's gated / it's terminal).
 */
export async function acquireLease(
  db: Database,
  transitionId: string,
  leaseTtlMs: number,
  now: Date = new Date(),
): Promise<ProviderTransitionRow | null> {
  const staleBefore = new Date(now.getTime() - leaseTtlMs);
  const rows = await db
    .update(providerTransitions)
    .set({ heartbeatAt: now, updatedAt: now })
    .where(
      and(
        eq(providerTransitions.transitionId, transitionId),
        inArray(providerTransitions.status, LIVE),
        or(isNull(providerTransitions.nextRetryAt), lt(providerTransitions.nextRetryAt, now)),
        or(isNull(providerTransitions.heartbeatAt), lt(providerTransitions.heartbeatAt, staleBefore)),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function heartbeat(db: Database, transitionId: string): Promise<void> {
  await db
    .update(providerTransitions)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(providerTransitions.transitionId, transitionId));
}

/**
 * Release the lease after a retryable failure: heartbeat null (re-leasable),
 * persist attempts + error class + the backoff gate (next_retry_at) so the
 * decision survives a restart and is identical on whichever instance resumes.
 */
export async function releaseForRetry(
  db: Database,
  transitionId: string,
  patch: { attempts: number; lastError: string; errorClass: string; nextRetryAt: Date; status?: ProviderTransitionStatus },
): Promise<void> {
  await db
    .update(providerTransitions)
    .set({
      status: patch.status ?? 'building',
      attempts: patch.attempts,
      lastError: patch.lastError.slice(0, 2000),
      errorClass: patch.errorClass,
      nextRetryAt: patch.nextRetryAt,
      heartbeatAt: null,
      updatedAt: new Date(),
    })
    .where(eq(providerTransitions.transitionId, transitionId));
}

/**
 * Release the lease while a build is HEALTHILY in progress (provider reports
 * `building`). Persists `building` + a poll gate and clears the heartbeat so a
 * worker re-drives after the gate. A confirmed-healthy `building` observation is
 * genuine forward progress, so it also RESETS `attempts` to 0 (reset-on-healthy):
 * scattered `indeterminate` blips that each burned one attempt via
 * {@link releaseForRetry} are cleared by the very next healthy `building` poll,
 * so only a SUSTAINED run of consecutive transient/indeterminate drives can
 * dead-letter — a long healthy build never does. errorClass 'waiting' + a human
 * note make the state legible without implying an error. The overall wall-clock
 * deadline (build_timeout) is what bounds total time, NOT the attempt counter.
 */
export async function releaseForWaiting(
  db: Database,
  transitionId: string,
  patch: { nextRetryAt: Date; note?: string },
): Promise<void> {
  await db
    .update(providerTransitions)
    .set({
      status: 'building',
      attempts: 0,
      lastError: (patch.note ?? 'build in progress on target provider').slice(0, 2000),
      errorClass: 'waiting',
      nextRetryAt: patch.nextRetryAt,
      heartbeatAt: null,
      updatedAt: new Date(),
    })
    .where(eq(providerTransitions.transitionId, transitionId));
}

export async function failTransition(
  db: Database,
  transitionId: string,
  patch: { attempts: number; lastError: string; errorClass: string },
): Promise<void> {
  await db
    .update(providerTransitions)
    .set({
      status: 'failed',
      attempts: patch.attempts,
      lastError: patch.lastError.slice(0, 2000),
      errorClass: patch.errorClass,
      heartbeatAt: null,
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(providerTransitions.transitionId, transitionId));
}

/** Highest live SWITCH generation for a project (0 if none) — supersession check. */
export async function maxLiveSwitchGeneration(db: Database, projectId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${providerTransitions.generation})` })
    .from(providerTransitions)
    .where(
      and(eq(providerTransitions.projectId, projectId), inArray(providerTransitions.status, LIVE)),
    );
  return row?.max ?? 0;
}

// ─── Resume worker candidates ────────────────────────────────────────────────

export async function findResumableTransitions(
  db: Database,
  leaseTtlMs: number,
  limit: number,
  now: Date = new Date(),
): Promise<Array<Pick<ProviderTransitionRow, 'transitionId' | 'mode'>>> {
  const staleBefore = new Date(now.getTime() - leaseTtlMs);
  return db
    .select({ transitionId: providerTransitions.transitionId, mode: providerTransitions.mode })
    .from(providerTransitions)
    .where(
      and(
        inArray(providerTransitions.status, LIVE),
        or(isNull(providerTransitions.nextRetryAt), lt(providerTransitions.nextRetryAt, now)),
        or(isNull(providerTransitions.heartbeatAt), lt(providerTransitions.heartbeatAt, staleBefore)),
      ),
    )
    .orderBy(providerTransitions.requestedAt)
    .limit(limit);
}

export async function countLiveTransitions(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(providerTransitions)
    .where(inArray(providerTransitions.status, LIVE));
  return Number(row?.n ?? 0);
}

// ─── Activation CAS (red-team #1/#2) ─────────────────────────────────────────

/**
 * Atomic activation. Locks the project row, then flips the active pin ONLY if
 * the project's generation still equals this transition's stamped generation
 * (canActivateGeneration ⇒ strict-greater against the recorded, which for the
 * reserved-at-request model means "no newer request bumped it"). Pin +
 * activated external template id are written TOGETHER so routing reads them
 * atomically. On loss (a newer request bumped the generation) the transition is
 * marked superseded. Two workers activating different transitions serialize on
 * the row lock; the older loses.
 */
export async function activateWithCas(
  db: Database,
  args: {
    projectId: string;
    transitionId: string;
    targetProvider: string;
    generation: number;
    snapshotName: string;
    externalTemplateId: string | null;
    now: Date;
  },
): Promise<{ activated: boolean; reason: 'won' | 'lost_cas' | 'project_missing' }> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ metadata: projects.metadata, generation: projects.sandboxProviderGeneration })
      .from(projects)
      .where(eq(projects.projectId, args.projectId))
      .for('update')
      .limit(1);
    if (!project) return { activated: false, reason: 'project_missing' as const };

    const recorded = project.generation ?? 0;
    // Reserved-at-request semantics: the winning transition's generation EQUALS
    // the project's current generation; a newer request would have bumped it
    // strictly higher. canActivateGeneration(gen, recorded-1) captures "still
    // the latest intent" — equivalently gen === recorded here.
    if (args.generation !== recorded) {
      await tx
        .update(providerTransitions)
        .set({ status: 'superseded', heartbeatAt: null, updatedAt: args.now })
        .where(eq(providerTransitions.transitionId, args.transitionId));
      return { activated: false, reason: 'lost_cas' as const };
    }

    const meta = asMeta(project.metadata);
    meta[PIN_META_KEY] = args.targetProvider;
    meta[ACTIVE_EXTERNAL_ID_META_KEY] = args.externalTemplateId;
    meta[TRANSITION_META_KEY] = {
      status: 'activated',
      target_provider: args.targetProvider,
      generation: args.generation,
      snapshot_name: args.snapshotName,
      external_template_id: args.externalTemplateId,
      activated_at: args.now.toISOString(),
    };
    await tx.update(projects).set({ metadata: meta, updatedAt: args.now }).where(eq(projects.projectId, args.projectId));

    await tx
      .update(providerTransitions)
      .set({ status: 'activated', activatedAt: args.now, heartbeatAt: null, lastError: null, errorClass: null, nextRetryAt: null, updatedAt: args.now })
      .where(eq(providerTransitions.transitionId, args.transitionId));

    // Any lower-generation live transition can never win now.
    await tx
      .update(providerTransitions)
      .set({ status: 'superseded', heartbeatAt: null, updatedAt: args.now })
      .where(
        and(
          eq(providerTransitions.projectId, args.projectId),
          inArray(providerTransitions.status, LIVE),
          lt(providerTransitions.generation, args.generation),
          ne(providerTransitions.transitionId, args.transitionId),
        ),
      );
    return { activated: true, reason: 'won' as const };
  });
}

/**
 * Immediate set-or-clear CAS for a SAFE target (null ⇒ follow platform default,
 * or the platform-default provider itself, which always has images — no prep).
 * Locks the project, bumps the generation (so a late-settling prepared
 * transition's activation CAS can no longer match), writes/clears the pin +
 * activated external id, and cancels every live transition. Bumping the
 * generation is exactly what makes "switching back supersedes the old transition
 * safely".
 */
export async function setPinWithGenerationBump(
  db: Database,
  args: { projectId: string; pin: string | null; now: Date },
): Promise<{ generation: number }> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ metadata: projects.metadata, generation: projects.sandboxProviderGeneration })
      .from(projects)
      .where(eq(projects.projectId, args.projectId))
      .for('update')
      .limit(1);
    if (!project) return { generation: 0 };
    const newGen = (project.generation ?? 0) + 1;
    const meta = asMeta(project.metadata);
    if (args.pin === null) delete meta[PIN_META_KEY];
    else meta[PIN_META_KEY] = args.pin;
    // The default/source provider does not carry a Platinum-style external id.
    delete meta[ACTIVE_EXTERNAL_ID_META_KEY];
    meta[TRANSITION_META_KEY] = {
      status: args.pin === null ? 'cleared' : 'activated',
      target_provider: args.pin,
      generation: newGen,
      activated_at: args.now.toISOString(),
    };
    await tx
      .update(projects)
      .set({ metadata: meta, sandboxProviderGeneration: newGen, updatedAt: args.now })
      .where(eq(projects.projectId, args.projectId));
    await tx
      .update(providerTransitions)
      .set({ status: 'cancelled', heartbeatAt: null, updatedAt: args.now })
      .where(and(eq(providerTransitions.projectId, args.projectId), inArray(providerTransitions.status, LIVE)));
    return { generation: newGen };
  });
}

/** Mirror a compact live-transition marker into project metadata for polling. */
export async function writeTransitionMarker(
  db: Database,
  projectId: string,
  marker: Record<string, unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .for('update')
      .limit(1);
    if (!project) return;
    const meta = asMeta(project.metadata);
    meta[TRANSITION_META_KEY] = marker;
    await tx.update(projects).set({ metadata: meta, updatedAt: new Date() }).where(eq(projects.projectId, projectId));
  });
}

/** Re-export the CAS predicate for tests + callers that need the raw decision. */
export { canActivateGeneration };
