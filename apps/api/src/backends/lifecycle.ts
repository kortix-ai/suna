/**
 * What happens to a backend's machine when its project or account goes away,
 * and the cleanup of machines nothing references.
 *
 * - Archive (project delete): the machine is parked. Kortix turns Platinum's
 *   auto-resume off, stops the machine and closes its compute window. The data
 *   stays. A public request does not wake it. `metadata.parked` records it.
 * - Unarchive (the project is `active` again): auto-resume goes back on and the
 *   park marker is cleared. The health probe then starts the stopped machine
 *   (./maintenance.ts), which reopens its compute window.
 * - Account deletion: every backend of the account is deleted, machine and
 *   snapshots, before the account's rows cascade away.
 * - Orphans: a machine tagged `kortix.workload=backend` that no live backend
 *   row references is deleted once it is older than ORPHAN_MACHINE_GRACE_MS.
 *   `machineDeletePending` rows (a failed delete after a failed provision) are
 *   retried every tick.
 */

import { projectBackends, projects } from '@kortix/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { PlatinumHttpError, platinumJson, platinumRegionControlPlane } from '../shared/platinum';
import { platinumUsRegion } from '../shared/platinum-region';
import { sandboxOwnershipMarker } from '../platform/sandbox-ownership';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { backendOperation, readMachine } from './operations';
import { type BackendRow, PROVISION_STALE_MS, deleteBackend, deleteBackendMachine } from './provision';

function mergeMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

// ── Archive and unarchive ────────────────────────────────────────────────────

async function setAutoResume(externalId: string, on: boolean): Promise<void> {
  await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'PATCH', body: JSON.stringify({ auto_resume: on }) });
}

/** Auto-resume off, machine stopped, compute window closed, row marked `parked`. */
export async function parkBackend(row: BackendRow): Promise<void> {
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
  await pauseComputeSession(row.backendId);
  await db
    .update(projectBackends)
    .set({ metadata: mergeMetadata({ parked: new Date().toISOString() }), updatedAt: new Date() })
    .where(and(eq(projectBackends.backendId, row.backendId), isNull(projectBackends.deletedAt)));
}

/** Auto-resume on, park marker cleared. The next probe starts the machine. */
export async function unparkBackend(row: BackendRow): Promise<void> {
  const externalId = row.externalId!;
  const machine = await readMachine(externalId);
  if (machine && machine.state !== 'deleted' && machine.autoResume === false) await setAutoResume(externalId, true);
  await db
    .update(projectBackends)
    .set({ metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) - 'parked'`, updatedAt: new Date() })
    .where(eq(projectBackends.backendId, row.backendId));
}

/**
 * Parks the running backends of archived projects and unparks the backends of
 * projects that are active again. `projectId` limits the pass to one project
 * (the project delete route). A backend with an operation in flight waits for
 * the next pass; an operation ends with the machine running and drops the
 * marker (`releaseOperation`), so an archived backend is parked again after it.
 */
export async function parkAndUnparkBackends(projectId?: string): Promise<{ parked: number; unparked: number; errors: number }> {
  const parked = sql`${projectBackends.metadata} ? 'parked'`;
  const rows = await db
    .select({ backend: projectBackends, projectStatus: projects.status })
    .from(projectBackends)
    .innerJoin(projects, eq(projects.projectId, projectBackends.projectId))
    .where(
      and(
        isNull(projectBackends.deletedAt),
        isNotNull(projectBackends.externalId),
        eq(projectBackends.status, 'running'),
        projectId ? eq(projectBackends.projectId, projectId) : undefined,
        sql`((${projects.status} = 'archived' and not ${parked}) or (${projects.status} = 'active' and ${parked}))`,
      ),
    );
  const result = { parked: 0, unparked: 0, errors: 0 };
  for (const { backend, projectStatus } of rows) {
    if (backendOperation(backend)) continue;
    const park = projectStatus === 'archived';
    try {
      await (park ? parkBackend(backend) : unparkBackend(backend));
      result[park ? 'parked' : 'unparked'] += 1;
      logger.info(park ? '[backends] parked: the project is archived' : '[backends] unparked: the project is active', {
        backendId: backend.backendId,
        projectId: backend.projectId,
      });
    } catch (error) {
      result.errors += 1;
      logger.warn('[backends] park/unpark failed; the next tick retries', { backendId: backend.backendId, park, error: String(error) });
    }
  }
  return result;
}

// ── Account deletion ─────────────────────────────────────────────────────────

/**
 * Deletes every backend of the account: snapshots, machine, compute window,
 * row. Throws on the first failure, so account deletion stops before the
 * cascade removes the rows that name the remaining machines, and retries.
 * Only this account: a team account the requester also owns keeps its data.
 */
export async function deleteAccountBackends(accountId: string): Promise<number> {
  const rows = await db
    .select()
    .from(projectBackends)
    .where(and(eq(projectBackends.accountId, accountId), isNull(projectBackends.deletedAt)));
  for (const row of rows) await deleteBackend(row);
  if (rows.length > 0) logger.info('[backends] deleted the backends of a deleted account', { accountId, backends: rows.length });
  return rows.length;
}

// ── Orphaned machines ────────────────────────────────────────────────────────

/** Retries the delete of machines a failed provision left behind. */
export async function retryPendingMachineDeletes(): Promise<{ deleted: number; errors: number }> {
  const rows = await db
    .select()
    .from(projectBackends)
    .where(and(isNotNull(projectBackends.externalId), sql`${projectBackends.metadata} ? 'machineDeletePending'`));
  const result = { deleted: 0, errors: 0 };
  for (const row of rows) {
    try {
      await deleteBackendMachine(row.externalId!);
      await db
        .update(projectBackends)
        .set({ metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) - 'machineDeletePending'` })
        .where(eq(projectBackends.backendId, row.backendId));
      result.deleted += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn('[backends] machine delete retry failed', { backendId: row.backendId, error: String(error) });
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
type MachineOwner = Pick<BackendRow, 'backendId' | 'status' | 'externalId' | 'deletedAt'>;

/**
 * Whether a listed backend machine is an orphan. A `provisioning` row owns its
 * machine whatever its externalId says (maintenance resumes it). Otherwise the
 * machine is kept only when a live row names exactly it.
 */
export function isOrphanMachine(machine: ListedMachine, row: MachineOwner | undefined, now = Date.now()): boolean {
  if (!machine.createdAt || now - machine.createdAt.getTime() < ORPHAN_MACHINE_GRACE_MS) return false;
  if (!row || row.deletedAt) return true;
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
      logger.warn('[backends] orphan listing failed for a region', { origin: origin ?? 'home', error: String(error) });
    }
  }
  result.listed = machines.length;
  if (machines.length === 0) return result;
  const ids = [...new Set(machines.map((m) => m.backendId))].filter(isUuid);
  const rows = ids.length
    ? await db
        .select({
          backendId: projectBackends.backendId,
          status: projectBackends.status,
          externalId: projectBackends.externalId,
          deletedAt: projectBackends.deletedAt,
        })
        .from(projectBackends)
        .where(inArray(projectBackends.backendId, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.backendId, r]));
  for (const machine of machines) {
    if (result.deleted >= MAX_ORPHAN_DELETES_PER_PASS) break;
    if (!isOrphanMachine(machine, byId.get(machine.backendId), now)) continue;
    try {
      await deleteBackendMachine(machine.id);
      result.deleted += 1;
      logger.warn('[backends] deleted an orphaned backend machine', { externalId: machine.id, backendId: machine.backendId });
    } catch (error) {
      result.errors += 1;
      logger.warn('[backends] orphan delete failed', { externalId: machine.id, error: String(error) });
    }
  }
  return result;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Test-only. */
export function __resetOrphanSweepClockForTests(): void {
  lastOrphanSweepAt = 0;
}
