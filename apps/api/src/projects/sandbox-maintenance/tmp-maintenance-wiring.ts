/**
 * Production wiring for /tmp maintenance: DB row → provider exec → metadata +
 * audit. The policy lives in tmp-maintenance.ts and is tested without this.
 */
import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { getProvider, type ProviderName } from '../../platform/providers';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { fetchSandboxOpencodeStatus } from '../lib/legacy-runtime-bootstrap-wiring';
import { mergeMetadata } from '../reaping/sandbox-state-sync';
import {
  parseTmpMaintenanceMode,
  runTmpMaintenance,
  type TmpMaintenanceDeps,
  type TmpMaintenanceMode,
  type TmpMaintenanceResult,
} from './tmp-maintenance';

export interface TmpMaintenanceRow {
  sandboxId: string;
  sessionId: string | null;
  accountId: string | null;
  projectId?: string | null;
  provider: ProviderName | string;
  externalId: string;
  metadata: Record<string, unknown> | null;
}

/** Read per call, so an env change takes effect without a rebuild. */
export function tmpMaintenanceMode(): TmpMaintenanceMode {
  return parseTmpMaintenanceMode(process.env.SANDBOX_TMP_MAINTENANCE);
}

/** Concurrent runs per API replica. A run is one exec of a few seconds. */
const MAX_IN_FLIGHT = Number(process.env.SANDBOX_TMP_MAINTENANCE_CONCURRENCY ?? '4') || 4;
const inFlight = new Set<string>();

export function buildTmpMaintenanceDeps(row: TmpMaintenanceRow): TmpMaintenanceDeps {
  const provider = getProvider(row.provider as ProviderName);
  return {
    now: () => Date.now(),
    exec: async (command, timeoutMs) => {
      if (!provider.exec) throw new Error(`provider ${row.provider} has no exec channel`);
      return provider.exec(row.externalId, command, { timeoutMs });
    },
    fetchOpencodeStatus: () => fetchSandboxOpencodeStatus(row),
    patchMetadata: async (patch) => {
      await db
        .update(sessionSandboxes)
        .set({ metadata: mergeMetadata(patch) })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    },
    audit: async (event) => {
      await recordAuditEvent({
        accountId: row.accountId ?? null,
        projectId: row.projectId ?? null,
        sessionId: row.sessionId ?? null,
        actorType: 'system',
        source: 'sandbox-tmp-maintenance',
        action: 'sandbox.tmp.maintenance',
        phase: event.phase,
        resourceType: 'sandbox',
        resourceId: row.sandboxId,
        outcome: event.outcome,
        outputSummary: { externalId: row.externalId, provider: row.provider, ...event.summary },
        errorMessage: event.error ?? null,
      }).catch((err) =>
        console.warn('[tmp-maintenance] audit write failed:', err instanceof Error ? err.message : err),
      );
    },
    log: (message, context) => console.log(`[tmp-maintenance] ${message}`, context ?? ''),
  };
}

export async function runTmpMaintenanceForRow(
  row: TmpMaintenanceRow,
  reason: string,
  opts: { force?: boolean; mode?: TmpMaintenanceMode } = {},
): Promise<TmpMaintenanceResult> {
  return runTmpMaintenance(
    {
      sandboxId: row.sandboxId,
      externalId: row.externalId,
      provider: row.provider,
      metadata: row.metadata,
      mode: opts.mode ?? tmpMaintenanceMode(),
      reason,
      force: opts.force,
    },
    buildTmpMaintenanceDeps(row),
  );
}

/**
 * Reaper entry point: fire-and-forget with a per-replica concurrency cap. The
 * policy's own gates (hourly interval, failure cooldown, in-progress stamp)
 * make this one metadata read per box per pass on a box that is not due.
 */
export function scheduleTmpMaintenance(
  row: TmpMaintenanceRow,
  reason = 'reaper',
  opts: { force?: boolean } = {},
): boolean {
  if (tmpMaintenanceMode() === 'off') return false;
  if (!row.externalId) return false;
  if (inFlight.has(row.sandboxId) || inFlight.size >= MAX_IN_FLIGHT) return false;
  inFlight.add(row.sandboxId);
  void runTmpMaintenanceForRow(row, reason, opts)
    .catch((err) =>
      console.warn(`[tmp-maintenance] ${row.sandboxId} failed:`, err instanceof Error ? err.message : err),
    )
    .finally(() => inFlight.delete(row.sandboxId));
  return true;
}

/**
 * The memory guard just stopped a turn in this session: clean its /tmp now
 * instead of at the next hourly pass, so the next turn has room.
 */
export async function scheduleTmpMaintenanceForSession(sessionId: string, reason: string): Promise<boolean> {
  if (tmpMaintenanceMode() === 'off') return false;
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      projectId: sessionSandboxes.projectId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(
      and(eq(sessionSandboxes.sessionId, sessionId), inArray(sessionSandboxes.status, ['active', 'provisioning'])),
    )
    .limit(1);
  if (!row?.externalId) return false;
  return scheduleTmpMaintenance(
    { ...row, externalId: row.externalId, metadata: (row.metadata ?? null) as Record<string, unknown> | null },
    reason,
    { force: true },
  );
}

/** Test seam. */
export function tmpMaintenanceInFlightCount(): number {
  return inFlight.size;
}
