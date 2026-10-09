/**
 * What happens to a `convex` App's machine when its project or account goes
 * away or the App is deleted, and the cleanup of machines nothing references.
 *
 * - Archive (project delete): the machine is parked. Kortix turns Platinum's
 *   auto-resume off, stops the machine and closes its compute window. The data
 *   stays. A public request does not wake it. `metadata.parked` records it.
 * - Unarchive (the project is `active` again): auto-resume goes back on and the
 *   park marker is cleared. The health probe then starts the stopped machine
 *   (./maintenance.ts), which reopens its compute window.
 * - App delete (./operations.ts retireConvexApp): the machine is stopped and
 *   kept with its `final` snapshot until `metadata.purgeAfter` (7 days);
 *   `purgeRetiredConvexApps` then deletes machine, snapshots and row.
 * - Account deletion: every `convex` App of the account is deleted at once,
 *   machine and snapshots, retained ones included, before the account's rows
 *   cascade away.
 * - Orphans: a machine tagged `kortix.workload=backend` that no live backend
 *   row references is deleted once it is older than ORPHAN_MACHINE_GRACE_MS.
 *   `machineDeletePending` rows (a failed delete after a failed provision) are
 *   retried every tick.
 */

import { appConvexInstances, apps, projects } from '@kortix/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../../../lib/logger';
import { db } from '../../../shared/db';
import { isUuid } from '../../../shared/validate';
import { PlatinumHttpError, platinumJson, platinumRegionControlPlane } from '../../../shared/platinum';
import { platinumUsRegion } from '../../../shared/platinum-region';
import { sandboxOwnershipMarker } from '../../../platform/sandbox-ownership';
import { pauseComputeSession } from '../../../billing/services/compute-metering';
import { backendOperation, deleteBackendExclusive, readMachine } from './operations';
import {
  CONVEX_ROW,
  type ConvexRow,
  PROVISION_STALE_MS,
  deleteBackend,
  deleteBackendMachine,
  liveConvexApp,
  liveInstance,
  selectConvexRows,
} from './provision';

function mergeMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

// ── Archive and unarchive ────────────────────────────────────────────────────

async function setAutoResume(externalId: string, on: boolean): Promise<void> {
  await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'PATCH', body: JSON.stringify({ auto_resume: on }) });
}

/** Auto-resume off, machine stopped, compute window closed, row marked `parked`. */
export async function parkBackend(row: ConvexRow): Promise<void> {
  const externalId = row.externalId!;
  const machine = await readMachine(externalId);
  if (machine && machine.state !== 'deleted') {
    if (machine.autoResume !== false) await setAutoResume(externalId, false);
    if (machine.state === 'running') {
      await platinumJson(`/v1/sandboxes/${externalId}/stop`, { method: 'POST', body: '{}' }).catch((error) => {
        // 409: Platinum is already stopping it, or it stopped meanwhile.
        if (!(error instanceof PlatinumHttpError && error.status === 409)) throw error;
      });
    }
  }
  await pauseComputeSession(row.appId);
  await db
    .update(appConvexInstances)
    .set({ metadata: mergeMetadata({ parked: new Date().toISOString() }), updatedAt: new Date() })
    .where(and(eq(appConvexInstances.appId, row.appId), liveInstance()));
}

/** Auto-resume on, park marker cleared. The next probe starts the machine. */
export async function unparkBackend(row: ConvexRow): Promise<void> {
  const externalId = row.externalId!;
  const machine = await readMachine(externalId);
  if (machine && machine.state !== 'deleted' && machine.autoResume === false) await setAutoResume(externalId, true);
  await db
    .update(appConvexInstances)
    .set({ metadata: sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) - 'parked'`, updatedAt: new Date() })
    .where(eq(appConvexInstances.appId, row.appId));
}

/**
 * Parks the running backends of archived projects and unparks the backends of
 * projects that are active again. `projectId` limits the pass to one project
 * (the project delete route). A backend with an operation in flight waits for
 * the next pass; an operation ends with the machine running and drops the
 * marker (`releaseOperation`), so an archived backend is parked again after it.
 */
export async function parkAndUnparkBackends(projectId?: string): Promise<{ parked: number; unparked: number; errors: number }> {
  const parked = sql`${appConvexInstances.metadata} ? 'parked'`;
  const rows = await db
    .select({ ...CONVEX_ROW, projectStatus: projects.status })
    .from(appConvexInstances)
    .innerJoin(apps, eq(apps.appId, appConvexInstances.appId))
    .innerJoin(projects, eq(projects.projectId, apps.projectId))
    .where(
      and(
        liveConvexApp(),
        isNotNull(appConvexInstances.externalId),
        eq(appConvexInstances.status, 'running'),
        projectId ? eq(apps.projectId, projectId) : undefined,
        sql`((${projects.status} = 'archived' and not ${parked}) or (${projects.status} = 'active' and ${parked}))`,
      ),
    );
  const result = { parked: 0, unparked: 0, errors: 0 };
  for (const { projectStatus, ...backend } of rows) {
    if (backendOperation(backend)) continue;
    const park = projectStatus === 'archived';
    try {
      await (park ? parkBackend(backend) : unparkBackend(backend));
      result[park ? 'parked' : 'unparked'] += 1;
      logger.info(park ? '[apps:convex] parked: the project is archived' : '[apps:convex] unparked: the project is active', {
        appId: backend.appId,
        projectId: backend.projectId,
      });
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps:convex] park/unpark failed; the next tick retries', { appId: backend.appId, park, error: String(error) });
    }
  }
  return result;
}

// ── Account deletion ─────────────────────────────────────────────────────────

/**
 * Deletes every `convex` App of the account at once: snapshots, machine,
 * compute window, machine row. Retained (deleted) Apps go too: an erased
 * account keeps no data. Throws on the first failure, so account deletion
 * stops before the cascade removes the rows that name the remaining machines,
 * and retries. Only this account: a team account the requester also owns
 * keeps its data.
 */
export async function deleteAccountBackends(accountId: string): Promise<number> {
  // Two plain reads, no join: the account-deletion unit suites mock `db` with select/from/where only.
  const owned = await db.select({ appId: apps.appId }).from(apps).where(and(eq(apps.accountId, accountId), eq(apps.kind, 'convex')));
  if (owned.length === 0) return 0;
  const rows = await selectConvexRows().where(inArray(appConvexInstances.appId, owned.map((app) => app.appId)));
  // `force`: the account goes whatever runs; the mark stops new operations.
  for (const row of rows) {
    if (row.status === 'deleted') await deleteBackend(row);
    else await deleteBackendExclusive(row, { force: true });
  }
  if (rows.length > 0) logger.info('[apps:convex] deleted the convex Apps of a deleted account', { accountId, apps: rows.length });
  return rows.length;
}

/**
 * Purges deleted Apps whose retention ran out (`metadata.purgeAfter`): the
 * stopped machine, its snapshots (the `final` one too) and the machine row.
 * A failure is retried next tick.
 */
export async function purgeRetiredConvexApps(now = new Date()): Promise<{ purged: number; errors: number }> {
  const rows = await selectConvexRows().where(
    and(
      eq(appConvexInstances.status, 'deleted'),
      sql`coalesce((${appConvexInstances.metadata}->>'purgeAfter')::timestamptz, ${appConvexInstances.updatedAt}) <= ${now.toISOString()}::timestamptz`,
    ),
  );
  const result = { purged: 0, errors: 0 };
  for (const row of rows) {
    try {
      await deleteBackend(row);
      result.purged += 1;
      logger.info('[apps:convex] purged a deleted App after its retention', { appId: row.appId });
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps:convex] purge failed; the next tick retries', { appId: row.appId, error: String(error) });
    }
  }
  return result;
}

// ── Orphaned machines ────────────────────────────────────────────────────────

/** Retries the delete of machines a failed provision left behind. */
export async function retryPendingMachineDeletes(): Promise<{ deleted: number; errors: number }> {
  const rows = await db
    .select()
    .from(appConvexInstances)
    .where(and(isNotNull(appConvexInstances.externalId), sql`${appConvexInstances.metadata} ? 'machineDeletePending'`));
  const result = { deleted: 0, errors: 0 };
  for (const row of rows) {
    try {
      await deleteBackendMachine(row.externalId!);
      await db
        .update(appConvexInstances)
        .set({ metadata: sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) - 'machineDeletePending'` })
        .where(eq(appConvexInstances.appId, row.appId));
      result.deleted += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps:convex] machine delete retry failed', { appId: row.appId, error: String(error) });
    }
  }
  return result;
}

/** A machine must be this old before the reaper may delete it: longer than any provision. */
export const ORPHAN_MACHINE_GRACE_MS = 4 * PROVISION_STALE_MS;
/** The orphan pass lists every machine of the organization, so it runs at most this often. */
export const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60_000;
const MAX_ORPHAN_DELETES_PER_PASS = 20;
const LIST_PAGE = 200;
/** A guard against a paginator that never ends, far above the organization's size (~10,200 in 2026-10). */
const MAX_LIST_PAGES = 1_000;

export type ListedMachine = { id: string; backendId: string; createdAt: Date | null };
type MachineOwner = Pick<ConvexRow, 'status' | 'externalId'>;

/**
 * Whether a listed `convex` App machine is an orphan. A `provisioning` row owns
 * its machine whatever its externalId says (maintenance resumes it). Otherwise
 * the machine is kept only when a machine row names exactly it, a deleted
 * App's row in retention included (purge deletes that machine).
 */
export function isOrphanMachine(machine: ListedMachine, row: MachineOwner | undefined, now = Date.now()): boolean {
  if (!machine.createdAt || now - machine.createdAt.getTime() < ORPHAN_MACHINE_GRACE_MS) return false;
  if (!row) return true;
  if (row.status === 'provisioning') return false;
  return row.externalId !== machine.id;
}

type PlatinumListedSandbox = {
  id?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  createdAt?: string | null;
};

/**
 * Every backend machine this control plane created, in any state, in one
 * region. `regions=local` keeps Platinum's single-region listing, which has no
 * row cap; the merged multi-region listing refuses offsets past 10,000.
 */
async function listBackendMachines(origin?: string): Promise<ListedMachine[]> {
  const owner = await sandboxOwnershipMarker();
  const out: ListedMachine[] = [];
  for (let page = 0, offset = 0; page < MAX_LIST_PAGES; page += 1) {
    const body = await platinumJson<{ rows?: PlatinumListedSandbox[]; has_more?: boolean }>(
      `/v1/sandboxes?paginated=true&regions=local&limit=${LIST_PAGE}&offset=${offset}`,
      { signal: AbortSignal.timeout(30_000) },
      origin,
    );
    const rows = body.rows ?? [];
    offset += rows.length;
    for (const sandbox of rows) {
      const meta = sandbox.metadata ?? {};
      if (!sandbox.id || meta['kortix.workload'] !== 'backend' || meta['kortix.managed'] !== owner) continue;
      if (typeof meta['kortix.backend_id'] !== 'string') continue;
      const created = new Date(sandbox.created_at ?? sandbox.createdAt ?? '');
      out.push({
        id: sandbox.id,
        backendId: meta['kortix.backend_id'],
        createdAt: Number.isNaN(created.getTime()) ? null : created,
      });
    }
    if (!body.has_more || rows.length === 0) return out;
  }
  throw new Error(`the sandbox listing did not end within ${MAX_LIST_PAGES} pages`);
}

let lastOrphanSweepAt = 0;

/**
 * Lists backend machines in the home region and, when configured, the US
 * region, and deletes the orphans. A region whose listing fails is skipped:
 * nothing is deleted on a partial view of that region. Runs at most once per
 * ORPHAN_SWEEP_INTERVAL_MS per process (`force` for tests).
 */
export async function reapOrphanBackendMachines(
  options: { force?: boolean; now?: number } = {},
): Promise<{ listed: number; deleted: number; errors: number }> {
  const now = options.now ?? Date.now();
  const result = { listed: 0, deleted: 0, errors: 0 };
  if (!options.force && now - lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return result;
  lastOrphanSweepAt = now;
  const usRegion = platinumUsRegion();
  const origins: Array<string | undefined> = [undefined];
  if (usRegion) {
    const origin = platinumRegionControlPlane(usRegion);
    if (origin) origins.push(origin);
  }
  const machines: ListedMachine[] = [];
  for (const origin of origins) {
    try {
      machines.push(...(await listBackendMachines(origin)));
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps:convex] orphan listing failed for a region', { origin: origin ?? 'home', error: String(error) });
    }
  }
  result.listed = machines.length;
  if (machines.length === 0) return result;
  const ids = [...new Set(machines.map((m) => m.backendId))].filter(isUuid);
  const rows = ids.length
    ? await db
        .select({
          appId: appConvexInstances.appId,
          status: appConvexInstances.status,
          externalId: appConvexInstances.externalId,
        })
        .from(appConvexInstances)
        .where(inArray(appConvexInstances.appId, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.appId, r]));
  for (const machine of machines) {
    if (result.deleted >= MAX_ORPHAN_DELETES_PER_PASS) break;
    if (!isOrphanMachine(machine, byId.get(machine.backendId), now)) continue;
    try {
      await deleteBackendMachine(machine.id);
      result.deleted += 1;
      logger.warn('[apps:convex] deleted an orphaned backend machine', { externalId: machine.id, backendId: machine.backendId });
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps:convex] orphan delete failed', { externalId: machine.id, error: String(error) });
    }
  }
  return result;
}

/** Test-only. */
export function __resetOrphanSweepClockForTests(): void {
  lastOrphanSweepAt = 0;
}
