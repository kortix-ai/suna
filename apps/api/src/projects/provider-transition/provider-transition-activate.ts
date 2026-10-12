/** Activation for provider-migration transitions (red-team #1/#2): generation
 *  CAS + lease fence + atomic pin writes, split out of
 *  provider-transition-store.ts (CAS contract on activateWithCas). */
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { providerTransitions, projects, type Database } from '@kortix/db';
import { metadataMerge } from '../lib/metadata-merge';
import { auditProviderTransition, type ProviderTransitionAuditRow } from './provider-transition-audit';
import { LIVE_TRANSITION_STATUSES } from './provider-transition-core';
import {
  ACTIVE_EXTERNAL_ID_META_KEY, ACTIVE_SNAPSHOT_NAME_META_KEY,
  PIN_META_KEY, TRANSITION_META_KEY,
} from './provider-transition-routing';
import { TRANSITION_AUDIT_COLUMNS, type Queryable } from './provider-transition-store';

type ActivationArgs = {
  projectId: string;
  transitionId: string;
  targetProvider: string;
  generation: number;
  snapshotName: string;
  externalTemplateId: string | null;
  now: Date;
  /** Lease epoch this drive acquired. When set, activation additionally
   *  requires the row's lease_epoch to still match (zombie fencing). */
  leaseEpoch?: number;
};

type ActivationResult = {
  activated: boolean;
  reason: 'won' | 'lost_cas' | 'lost_lease' | 'project_missing' | 'project_archived';
};

// Lease fence: a fenced-out zombie must not win activation even at a matching
// generation. Read the row's epoch under the project lock; a mismatch means a
// newer owner re-acquired — refuse WITHOUT flipping the pin (do not mark the
// row superseded either; the current owner is driving it). Returns the
// `lost_lease` result when the fence refuses the drive, null when it passes.
async function leaseFence(tx: Queryable, args: ActivationArgs): Promise<ActivationResult | null> {
  if (args.leaseEpoch !== undefined) {
    const [t] = await tx
      .select({ leaseEpoch: providerTransitions.leaseEpoch })
      .from(providerTransitions)
      .where(eq(providerTransitions.transitionId, args.transitionId))
      .limit(1);
    if (!t || (t.leaseEpoch ?? 0) !== args.leaseEpoch) {
      return { activated: false, reason: 'lost_lease' as const };
    }
  }
  return null;
}

/** FIX-J: write ONLY the pin's own keys via a SQL-side atomic merge, never the
 *  whole object — so a concurrent metadata writer can neither revert this pin
 *  nor be reverted by it. The generation CAS (above) + the lease-epoch fence
 *  are UNTOUCHED; this converts the whole-object SET to a targeted merge only. */
async function writeActivationPin(tx: Queryable, args: ActivationArgs): Promise<void> {
  const activationPatch: Record<string, unknown> = {
    [PIN_META_KEY]: args.targetProvider,
    [ACTIVE_EXTERNAL_ID_META_KEY]: args.externalTemplateId,
    // FIX-K-lite: record the active ppwarm image NAME so the GC guard can match.
    [ACTIVE_SNAPSHOT_NAME_META_KEY]: args.snapshotName,
    [TRANSITION_META_KEY]: {
      status: 'activated',
      target_provider: args.targetProvider,
      generation: args.generation,
      snapshot_name: args.snapshotName,
      external_template_id: args.externalTemplateId,
      activated_at: args.now.toISOString(),
    },
  };
  await tx
    .update(projects)
    .set({ metadata: metadataMerge(activationPatch), updatedAt: args.now })
    .where(eq(projects.projectId, args.projectId));
}

/**
 * The `db.transaction` body of {@link activateWithCas}, moved verbatim. Returns
 * the audit row on `won` for the after-commit dispatch.
 */
async function activateInTransaction(
  tx: Queryable,
  args: ActivationArgs,
): Promise<ActivationResult & { row?: ProviderTransitionAuditRow }> {
  const [project] = await tx
    .select({
      metadata: projects.metadata,
      generation: projects.sandboxProviderGeneration,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.projectId, args.projectId))
    .for('update')
    .limit(1);
  if (!project) return { activated: false, reason: 'project_missing' as const };
  if (project.status === 'archived') {
    return { activated: false, reason: 'project_archived' as const };
  }

  const fencedOut = await leaseFence(tx, args);
  if (fencedOut) return fencedOut;

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

  await writeActivationPin(tx, args);
  const [activatedRow] = await tx
    .update(providerTransitions)
    .set({ status: 'activated', activatedAt: args.now, heartbeatAt: null, lastError: null, errorClass: null, nextRetryAt: null, updatedAt: args.now })
    .where(eq(providerTransitions.transitionId, args.transitionId))
    .returning(TRANSITION_AUDIT_COLUMNS);

  // Any lower-generation live transition can never win now.
  await tx
    .update(providerTransitions)
    .set({ status: 'superseded', heartbeatAt: null, updatedAt: args.now })
    .where(
      and(
        eq(providerTransitions.projectId, args.projectId),
        inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES),
        lt(providerTransitions.generation, args.generation),
        ne(providerTransitions.transitionId, args.transitionId),
      ),
    );
  return { activated: true, reason: 'won' as const, row: activatedRow };
}

/**
 * Atomic activation. Locks the project row, then flips the active pin ONLY if
 * the project's generation still equals this transition's stamped generation
 * (canActivateGeneration ⇒ strict-greater against the recorded, which for the
 * reserved-at-request model means "no newer request bumped it"). Pin +
 * activated external template id are written TOGETHER so routing reads them
 * atomically. On loss (a newer request bumped the generation) the transition is
 * marked superseded. Two workers activating different transitions serialize on
 * the row lock; the older loses.
 *
 * ALSO fenced on the LEASE EPOCH (when `leaseEpoch` is supplied): a zombie drive
 * that lost its lease to a newer owner would still carry the SAME generation for
 * the SAME transition row, so the generation CAS alone cannot tell them apart —
 * the epoch does. Under the project lock we re-read the row's `lease_epoch`; if it
 * no longer equals the caller's, the drive was fenced out and activation is
 * refused WITHOUT touching the pin (the current owner will activate). The
 * generation CAS is kept intact underneath.
 */
export async function activateWithCas(
  db: Database,
  args: ActivationArgs,
): Promise<ActivationResult> {
  const result = await db.transaction((tx) => activateInTransaction(tx, args));
  // Audited after COMMIT: a rolled-back activation never produces a row.
  if (result.row) await auditProviderTransition(result.row, { outcome: 'activated' });
  return { activated: result.activated, reason: result.reason };
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
    // FIX-J: set/clear ONLY the pin's own keys via a SQL-side atomic merge, under
    // the FOR UPDATE lock + generation bump (both UNCHANGED) — never the whole
    // object, so a concurrent metadata writer can't be reverted.
    const patch: Record<string, unknown> = {
      [TRANSITION_META_KEY]: {
        status: args.pin === null ? 'cleared' : 'activated',
        target_provider: args.pin,
        generation: newGen,
        activated_at: args.now.toISOString(),
      },
    };
    // The default/source provider carries no Platinum-style external id or ppwarm
    // image, so clear both the external id and the active-snapshot-name record.
    const deleteKeys = [ACTIVE_EXTERNAL_ID_META_KEY, ACTIVE_SNAPSHOT_NAME_META_KEY];
    if (args.pin === null) deleteKeys.push(PIN_META_KEY);
    else patch[PIN_META_KEY] = args.pin;
    await tx
      .update(projects)
      .set({ metadata: metadataMerge(patch, deleteKeys), sandboxProviderGeneration: newGen, updatedAt: args.now })
      .where(eq(projects.projectId, args.projectId));
    await tx
      .update(providerTransitions)
      .set({ status: 'cancelled', heartbeatAt: null, updatedAt: args.now })
      .where(and(eq(providerTransitions.projectId, args.projectId), inArray(providerTransitions.status, LIVE_TRANSITION_STATUSES)));
    return { generation: newGen };
  });
}

/** Mirror a compact live-transition marker into project metadata for polling. */
export async function writeTransitionMarker(
  db: Database,
  projectId: string,
  marker: Record<string, unknown>,
): Promise<void> {
  // FIX-J: one atomic SQL merge of ONLY the marker key — no read-modify-write, so
  // no FOR UPDATE round-trip and no chance of reverting a concurrent pin write.
  await db
    .update(projects)
    .set({ metadata: metadataMerge({ [TRANSITION_META_KEY]: marker }), updatedAt: new Date() })
    .where(eq(projects.projectId, projectId));
}

