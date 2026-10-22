/**
 * Durable store for provider-migration transitions: the transition row CRUD,
 * the atomic generation reservation, and the lease-fenced drive-time writes.
 * The activation CAS + pin writes live in provider-transition-activate.ts and
 * the routing read-model in provider-transition-routing.ts (the platform
 * session-sandbox service imports the routing module directly). Every
 * function takes an injected `Database` so it runs against the app db, a
 * transaction, or a throwaway test Postgres identically.
 *
 * Invariants enforced here (red-team #1/#3/#5):
 *  - the generation is reserved ON THE PROJECT ROW (projects.sandbox_provider_generation)
 *    under a FOR UPDATE lock at switch-REQUEST time — the atomic allocator;
 *  - a transition row is IMMUTABLE in {commit_sha, base_runtime_identity,
 *    target_provider} — a drift creates a NEW row (never mutates a building sha);
 *  - the live-identity unique index dedups repeated switch calls; failed/
 *    superseded/cancelled rows never block a fresh switch.
 */
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { providerTransitions, projects, type Database } from '@kortix/db';
import { auditProviderTransition } from './provider-transition-audit';
import {
  LIVE_TRANSITION_STATUSES,
  type PrepIdentity,
  type ProviderTransitionStatus,
} from './provider-transition-core';

export type ProviderTransitionRow = typeof providerTransitions.$inferSelect;

/** Accepts the app db OR a transaction handle — the query-builder surface both
 *  expose — so helpers can be called inside a `db.transaction(tx => …)` block. */
export type Queryable = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

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
        inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES),
      ),
    )
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
          inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES),
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

// ─── Drive-time writes (fenced by the lease epoch) ───────────────────────────

/**
 * WHERE predicate for a drive-time write. When `expectedEpoch` is supplied the
 * write is FENCED: it targets the row only while its `lease_epoch` still equals
 * the epoch this drive acquired (COALESCE-guarded so a pre-migration/backfilled
 * 0 is handled), so a zombie whose lease was re-taken (epoch bumped) matches 0
 * rows and writes nothing. Omitting the epoch (test setup, reconciler-adjacent
 * supersession) keeps the unfenced by-id behavior.
 */
function fencedWhere(transitionId: string, expectedEpoch?: number) {
  const byId = eq(providerTransitions.transitionId, transitionId);
  if (expectedEpoch === undefined) return byId;
  return and(byId, eq(sql`COALESCE(${providerTransitions.leaseEpoch}, 0)`, expectedEpoch));
}

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

/**
 * Patch a transition row. Returns `true` if a row was written, `false` if the
 * fence rejected it (this drive no longer owns the lease). Callers that pass
 * `expectedEpoch` MUST check the result and cease on `false`.
 */
export async function updateTransition(
  db: Database,
  transitionId: string,
  patch: TransitionPatch,
  expectedEpoch?: number,
): Promise<boolean> {
  const rows = await db
    .update(providerTransitions)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(fencedWhere(transitionId, expectedEpoch))
    .returning({ transitionId: providerTransitions.transitionId });
  return rows.length > 0;
}

/**
 * Lease CAS — mirrors suna-migration acquireLease. Grabs the row only when it's
 * still live, its backoff gate has passed (next_retry_at null/≤now), AND its
 * heartbeat is null or older than the lease TTL, stamping a fresh heartbeat so a
 * second worker's identical UPDATE matches nothing. Returns the leased row or
 * null (someone else owns it / it's gated / it's terminal).
 *
 * On a successful take it BUMPS the fencing token (`lease_epoch` = COALESCE(...,0)+1)
 * and returns the row carrying the new epoch. The drive threads that epoch through
 * every state write + the activation CAS: a zombie drive holding a STALE epoch
 * (its lease expired mid-build and a new owner re-acquired, bumping the token) then
 * matches 0 rows on every fenced write and ceases instead of clobbering state.
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
    .set({
      heartbeatAt: now,
      updatedAt: now,
      leaseEpoch: sql`COALESCE(${providerTransitions.leaseEpoch}, 0) + 1`,
    })
    .where(
      and(
        eq(providerTransitions.transitionId, transitionId),
        inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES),
        or(isNull(providerTransitions.nextRetryAt), lt(providerTransitions.nextRetryAt, now)),
        or(isNull(providerTransitions.heartbeatAt), lt(providerTransitions.heartbeatAt, staleBefore)),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Renew the lease heartbeat DURING a long build wait so the 10-min TTL never
 * lapses mid-build (a 30-40 min Platinum build otherwise outlives the TTL and the
 * resume worker double-drives). Fenced on `expectedEpoch`: returns `true` while
 * this drive still owns the lease, `false` once a newer owner re-acquired (bumped
 * the epoch) — the caller stops renewing/waiting. A transient DB error is the
 * caller's to swallow (keep building); a clean 0-row result is a real revocation.
 */
export async function heartbeat(
  db: Database,
  transitionId: string,
  expectedEpoch?: number,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(providerTransitions)
    .set({ heartbeatAt: now, updatedAt: now })
    .where(fencedWhere(transitionId, expectedEpoch))
    .returning({ transitionId: providerTransitions.transitionId });
  return rows.length > 0;
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
  expectedEpoch?: number,
): Promise<boolean> {
  const rows = await db
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
    .where(fencedWhere(transitionId, expectedEpoch))
    .returning({ transitionId: providerTransitions.transitionId });
  return rows.length > 0;
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
  expectedEpoch?: number,
): Promise<boolean> {
  const rows = await db
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
    .where(fencedWhere(transitionId, expectedEpoch))
    .returning({ transitionId: providerTransitions.transitionId });
  return rows.length > 0;
}

/** The transition columns an outcome audit row needs. */
export const TRANSITION_AUDIT_COLUMNS = {
  transitionId: providerTransitions.transitionId,
  accountId: providerTransitions.accountId,
  projectId: providerTransitions.projectId,
  sourceProvider: providerTransitions.sourceProvider,
  targetProvider: providerTransitions.targetProvider,
  mode: providerTransitions.mode,
  generation: providerTransitions.generation,
};

export async function failTransition(
  db: Database,
  transitionId: string,
  patch: { attempts: number; lastError: string; errorClass: string },
  expectedEpoch?: number,
): Promise<boolean> {
  const rows = await db
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
    .where(fencedWhere(transitionId, expectedEpoch))
    .returning(TRANSITION_AUDIT_COLUMNS);
  const [row] = rows;
  if (row) await auditProviderTransition(row, { outcome: 'failed', errorClass: patch.errorClass, attempts: patch.attempts });
  return rows.length > 0;
}

/** Highest live SWITCH generation for a project (0 if none) — supersession check. */
export async function maxLiveSwitchGeneration(db: Database, projectId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${providerTransitions.generation})` })
    .from(providerTransitions)
    .where(
      and(eq(providerTransitions.projectId, projectId), inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES)),
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
        inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES),
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
    .where(inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES));
  return Number(row?.n ?? 0);
}
