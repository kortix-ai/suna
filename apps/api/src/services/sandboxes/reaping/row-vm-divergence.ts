/**
 * Row↔VM divergence, direction PARKED ROW / RUNNING VM.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `session_sandboxes` row and the provider's VM must never disagree. One
 * direction was already closed: the box reaper asks the provider about every
 * `active` row and reconciles the row when the box is not running
 * (`reaping/policy.ts`, `decideReconcile`). The opposite direction had no
 * owner at all —
 *
 *   - the box reaper's candidate predicate is `status = 'active'`
 *     (`reaping/box-queries.ts`), so it never looks at a parked row;
 *   - the parked sweep reads a running box as "still there as far as we can
 *     tell" and rotates on (`reaping/parked-runtime-verification.ts`);
 *   - the orphan sweep deliberately keeps every box that HAS a row, whatever
 *     its status (`reaping/orphan-boxes.ts`).
 *
 * So a row that says `stopped` over a VM that is running was nobody's problem.
 * It is not cosmetic. A session credential is refused whenever its sandbox row
 * is not `provisioning`/`active` (`repositories/account-tokens.ts`), so a wrong
 * `stopped` row kills the live box's own credential. Measured on dev
 * 2026-09-27: a box 31.8 days old, `daemon: "ok"`, whose runtime assets had not
 * converged once in a month because every manifest fetch it made answered 401.
 * The same shape at fleet scale is already recorded in `platinum.ts`'s `stop()`
 * comment: 404,982 `401 Session token is not active` rejections in one 76h prod
 * window. Worse, the box's own dead-token breaker shuts the daemon down with
 * exit 0, which the Platinum entrypoint reads as an intentional stop and never
 * relaunches — a wrong row does not just mute a box, it ends it.
 *
 * WHY STOPPING THE VM IS THE CLOSURE, NOT ADOPTING THE ROW
 * -------------------------------------------------------
 * By the time this sweep sees the divergence the daemon is usually already
 * gone (it shuts itself down ~11 s after the row is parked), so flipping the
 * row back to `active` would produce the strictly worse state: a row that
 * accepts prompts over a VM that serves nothing (measured: `POST /prompts`
 * → 202, turn `active`, then `abandoned`). Stopping is the honest close. The
 * disk survives, and the next `/start` boots the box with a live credential
 * through the path that already works.
 *
 * NO RECENCY WINDOW, NO BATCH LIMIT. The fleet listing this consumes is the one
 * the orphan sweep already fetches each pass, so every running box this
 * database owns is considered on every pass, at any age. Work is bounded by
 * concurrency, never by dropping boxes from consideration.
 */

import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { type ProviderName, getProvider } from '../../../platform/providers';
import { db } from '../../../lib/db';
import { sandboxBelongsToThisInstance } from '../../sessions/instance-scope';
import { REAP_CONCURRENCY } from '../reaper-constants';
import { runtimeWakeInProgress } from '../../sessions/lifecycle/runtime-wake-fence';
import { mergeMetadata } from './sandbox-state-sync';

/**
 * How long a row must have been untouched before its state is treated as
 * settled truth.
 *
 * The provider listing and the row read are not one transaction: a box parked
 * a second ago can still be listed as running, and a box being started can
 * appear before its row leaves `stopped`. One maintenance interval of quiet is
 * the cheapest proof that neither is in flight, and uncertainty then fails
 * toward the live box.
 */
export const DIVERGENCE_SETTLE_GRACE_MS = 5 * 60_000;

/** Row states that mean "this box is supposed to be off". */
const PARKED_ROW_STATES = new Set(['stopped', 'archived']);

export type RowVmDivergenceAction = 'stop-vm' | 'skip';

/**
 * The whole decision for one box, pure.
 *
 * `rowStatus` is the row's own status, `providerRunning` is implied — every
 * candidate comes from a listing of RUNNING boxes.
 */
export function decideRowVmDivergence(input: {
  rowStatus: string;
  transitionInProgress: boolean;
  ownedByThisInstance: boolean;
  rowSettledForMs: number;
}): RowVmDivergenceAction {
  if (!PARKED_ROW_STATES.has(input.rowStatus)) return 'skip';
  // A live wake, restart or recovery owns this row and is allowed to hold a
  // running box over a parked row while it finishes.
  if (input.transitionInProgress) return 'skip';
  // Shared local database: instance A never stops a box instance B provisioned
  // (../instance-scope.ts). A no-op in deployed environments.
  if (!input.ownedByThisInstance) return 'skip';
  if (input.rowSettledForMs <= DIVERGENCE_SETTLE_GRACE_MS) return 'skip';
  return 'stop-vm';
}

export interface FleetBox {
  provider: string;
  externalId: string;
}

export interface SandboxRowRef {
  provider: string;
  externalId: string;
  status: string;
  sandboxId: string;
}

function boxKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

/**
 * Pair the provider's running boxes with the rows that claim them, and keep the
 * pairs where the row says the box should be off.
 *
 * A listed box with NO row is an orphan and belongs to `reapOrphanProviderBoxes`
 * — the only path allowed to stop an unreferenced box.
 */
export function selectDivergedBoxes(
  boxes: readonly FleetBox[],
  rows: readonly SandboxRowRef[],
): SandboxRowRef[] {
  if (boxes.length === 0 || rows.length === 0) return [];
  const running = new Set(boxes.map((box) => boxKey(box.provider, box.externalId)));
  return rows.filter(
    (row) => PARKED_ROW_STATES.has(row.status) && running.has(boxKey(row.provider, row.externalId)),
  );
}

/** A lifecycle owner that may legitimately hold a running box over a parked row. */
export function runtimeTransitionInProgress(
  metadata: Record<string, unknown> | null | undefined,
  now: Date,
): boolean {
  if (runtimeWakeInProgress(metadata, now)) return true;
  if (!metadata) return false;
  const restartExpiry = Date.parse(String(metadata.runtimeRestartLeaseExpiresAt ?? ''));
  if (typeof metadata.runtimeRestartId === 'string' && restartExpiry > now.getTime()) return true;
  const recoveryExpiry = Number(metadata.runtimeRecoveryLeaseExpiresAtMs);
  if (typeof metadata.runtimeRecoveryLeaseId === 'string' && recoveryExpiry > now.getTime()) {
    return true;
  }
  return false;
}

export interface DivergenceRow {
  sandboxId: string;
  sessionId: string | null;
  provider: string;
  externalId: string;
  status: string;
  metadata: Record<string, unknown> | null;
  updatedAt: Date | null;
}

export interface RowVmDivergenceDeps {
  /** Authoritative re-read immediately before acting. Null when the row is gone. */
  readRow: (sandboxId: string) => Promise<DivergenceRow | null>;
  stopBox: (provider: string, externalId: string) => Promise<void>;
  markClosed: (sandboxId: string, at: Date) => Promise<void>;
}

export interface RowVmDivergenceResult {
  /** Rows whose status disagreed with a running box in the fleet listing. */
  diverged: number;
  /** Divergences this pass closed. */
  closed: number;
  errors: number;
}

export const EMPTY_ROW_VM_DIVERGENCE: RowVmDivergenceResult = { diverged: 0, closed: 0, errors: 0 };

const defaultDeps: RowVmDivergenceDeps = {
  readRow: async (sandboxId) => {
    const [row] = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
        externalId: sessionSandboxes.externalId,
        status: sessionSandboxes.status,
        metadata: sessionSandboxes.metadata,
        updatedAt: sessionSandboxes.updatedAt,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .limit(1);
    if (!row?.externalId) return null;
    return { ...row, externalId: row.externalId } as DivergenceRow;
  },
  stopBox: async (provider, externalId) => {
    await getProvider(provider as ProviderName).stop(externalId);
  },
  markClosed: async (sandboxId, at) => {
    // Merge in SQL. Never write back a JSONB column read earlier — a
    // concurrent wake claim on the same row would be clobbered (learnings
    // 2026-09-22).
    await db
      .update(sessionSandboxes)
      .set({ metadata: mergeMetadata({ rowVmDivergenceClosedAt: at.toISOString() }) })
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .catch((err) =>
        console.warn('[row-vm] divergence stamp failed:', err instanceof Error ? err.message : err),
      );
  },
};

/**
 * Close every parked-row / running-VM divergence in one fleet listing.
 *
 * `boxes` is the provider listing the orphan sweep already fetched, and `rows`
 * the `session_sandboxes` reference scan it already ran — so this costs one
 * extra `stop()` per real divergence and nothing else.
 */
export async function closeRowVmDivergence(
  input: { boxes: readonly FleetBox[]; rows: readonly SandboxRowRef[]; now?: Date },
  deps: RowVmDivergenceDeps = defaultDeps,
): Promise<RowVmDivergenceResult> {
  if (process.env.KORTIX_ROW_VM_RECONCILE_ENABLED === 'false') return EMPTY_ROW_VM_DIVERGENCE;
  const now = input.now ?? new Date();
  const candidates = selectDivergedBoxes(input.boxes, input.rows);
  if (candidates.length === 0) return EMPTY_ROW_VM_DIVERGENCE;

  const result: RowVmDivergenceResult = { diverged: 0, closed: 0, errors: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      try {
        // Re-read, never act on the bulk scan. The scan and the listing are
        // minutes apart on a large fleet, and a `/start` in between is exactly
        // the case that must not be stopped.
        const row = await deps.readRow(candidate.sandboxId);
        if (!row || row.externalId !== candidate.externalId) continue;
        const action = decideRowVmDivergence({
          rowStatus: row.status,
          transitionInProgress: runtimeTransitionInProgress(row.metadata, now),
          ownedByThisInstance: sandboxBelongsToThisInstance(row.metadata),
          rowSettledForMs: row.updatedAt ? now.getTime() - row.updatedAt.getTime() : 0,
        });
        if (action === 'skip') continue;
        result.diverged += 1;
        // One line per divergence, with the direction. A divergence that is
        // fixed silently teaches us nothing about how often it happens.
        console.warn('[row-vm] divergence: row parked, VM running — stopping the VM', {
          direction: 'row-parked-vm-running',
          sandboxId: row.sandboxId,
          sessionId: row.sessionId,
          provider: row.provider,
          externalId: row.externalId,
          rowStatus: row.status,
          rowAgeMs: row.updatedAt ? now.getTime() - row.updatedAt.getTime() : null,
        });
        await deps.stopBox(row.provider, row.externalId);
        await deps.markClosed(row.sandboxId, now);
        result.closed += 1;
      } catch (err) {
        result.errors += 1;
        if (result.errors <= 5) {
          console.warn(
            `[row-vm] divergence close failed for ${candidate.externalId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, candidates.length) }, worker));
  return result;
}
