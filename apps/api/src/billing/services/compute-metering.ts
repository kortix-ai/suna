// Billing v2 — sandbox compute metering.
//
// Sandboxes declare their reserved spec (cpu / memory / disk / gpu) in
// kortix.toml [sandbox]. We bill against that reserved spec × wall-clock time
// while the sandbox is `active`. Stopped / hibernated sandboxes do not accrue
// charges in v1 (archive rate placeholder lives in tiers.ts for future use).
//
// Lifecycle:
//   provisionSessionSandbox → startComputeSession (open row)
//       │
//       ├─ hibernate / user-stop / wake / restart hooks
//       │     │
//       │     ├─ pauseComputeSession (finalize cost, debit, mark stopped)
//       │     └─ resumeComputeSession (open new row when sandbox starts again)
//       │
//       └─ remove → endComputeSession (finalize, no resume)
//
// Cron tick (tickRunningComputeCharges) runs every 15 minutes and partially
// bills any session whose last_billed_at is > 1 hour ago, so a missed close
// hook can never silently accrue 24h+ of uncharged compute.

import { sandboxComputeSessions } from '@kortix/db';
import { config } from '../../config';
import {
  insertComputeSession,
  getOpenComputeSession,
  updateComputeSession,
  findStaleActiveSessions,
  type SandboxSpec,
} from '../repositories/compute-sessions';
import { getCreditAccount } from '../repositories/credit-accounts';
import { deductCredits } from './credits';
import {
  COMPUTE_CPU_PRICE_PER_CORE_SECOND,
  COMPUTE_MEMORY_PRICE_PER_GB_SECOND,
  COMPUTE_DISK_PRICE_PER_GB_SECOND,
  COMPUTE_PRICE_MARKUP,
  DAYTONA_DISCOUNT,
  isPerSeatAccount,
} from './tiers';

const PARTIAL_BILL_INTERVAL_MS = 60 * 60 * 1000; // 1h

export interface StartComputeOpts {
  sandboxId: string;
  accountId: string;
  sessionId?: string | null;
  actorUserId?: string | null;
  spec: SandboxSpec;
  metadata?: Record<string, unknown>;
}

/**
 * Compute the cost (in USD, pre-balance-deduction) for a window.
 * tiers.ts holds Daytona's LIST rates; here we apply our volume discount
 * (DAYTONA_DISCOUNT → our real cost) and then the markup (our margin).
 */
export function calculateComputeCost(spec: SandboxSpec, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const cpuCost    = spec.cpuCores  * COMPUTE_CPU_PRICE_PER_CORE_SECOND  * durationSeconds;
  const memCost    = spec.memoryGb  * COMPUTE_MEMORY_PRICE_PER_GB_SECOND * durationSeconds;
  const diskCost   = spec.diskGb    * COMPUTE_DISK_PRICE_PER_GB_SECOND   * durationSeconds;
  return (cpuCost + memCost + diskCost) * DAYTONA_DISCOUNT * COMPUTE_PRICE_MARKUP;
}

/**
 * Open a metering row when a sandbox transitions to `active`.
 * No-op for legacy accounts — they continue to be billed via the flat machine
 * tier model in COMPUTE_TIERS.
 */
export async function startComputeSession(opts: StartComputeOpts): Promise<string | null> {
  // Hard gate: self-hosted / billing-disabled deploys never meter compute, even
  // if a credit_accounts row has billing_model='per_seat' (stale data).
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return null;
  const account = await getCreditAccount(opts.accountId);
  if (!isPerSeatAccount(account?.billingModel)) return null;

  // If a row is already open (e.g. duplicate hook), reuse it.
  const existing = await getOpenComputeSession(opts.sandboxId);
  if (existing) return existing.id;

  const row = await insertComputeSession({
    accountId: opts.accountId,
    sandboxId: opts.sandboxId,
    sessionId: opts.sessionId ?? null,
    actorUserId: opts.actorUserId ?? null,
    cpuCores: opts.spec.cpuCores,
    memoryGb: opts.spec.memoryGb,
    diskGb: opts.spec.diskGb,
    gpuCount: opts.spec.gpuCount ?? 0,
    state: 'active',
    metadata: (opts.metadata ?? {}) as Record<string, unknown>,
  });
  return row.id;
}

/**
 * Bill a partial window without closing the row. Updates `cost_usd` and
 * `last_billed_at`, emits a `compute_debit` ledger entry, returns new cost.
 * Used by both `pauseComputeSession` (final) and the cron tick (partial).
 */
async function settleComputeWindow(
  row: typeof sandboxComputeSessions.$inferSelect,
  windowEnd: Date,
): Promise<number> {
  const lastBilled = new Date(row.lastBilledAt);
  const durationSeconds = Math.max(0, (windowEnd.getTime() - lastBilled.getTime()) / 1000);
  if (durationSeconds <= 0) return 0;

  const spec: SandboxSpec = {
    cpuCores: row.cpuCores,
    memoryGb: row.memoryGb,
    diskGb: row.diskGb,
    gpuCount: row.gpuCount,
  };
  const windowCost = calculateComputeCost(spec, durationSeconds);
  if (windowCost <= 0) {
    await updateComputeSession(row.id, { lastBilledAt: windowEnd.toISOString() });
    return 0;
  }

  // Debit the wallet. deductCredits already triggers auto-topup as a
  // fire-and-forget after a deduction (services/credits.ts:79).
  // If the balance is insufficient the deduct throws; we still update the
  // accrued cost on the session row so the next attempt can settle.
  let debited = false;
  try {
    await deductCredits(
      row.accountId,
      windowCost,
      `Sandbox compute · ${row.cpuCores}vCPU/${row.memoryGb}GB/${row.diskGb}GB · ${durationSeconds.toFixed(0)}s`,
      'compute_debit',
    );
    debited = true;
  } catch (err) {
    // Out of credits + no auto-topup. Record the accrual; the session will be
    // forced to stop by the limits layer (separate concern).
    console.warn(
      `[compute-metering] failed to debit ${row.accountId} for session ${row.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  await updateComputeSession(row.id, {
    costUsd: String(Number(row.costUsd) + windowCost),
    lastBilledAt: windowEnd.toISOString(),
  });

  return debited ? windowCost : 0;
}

/**
 * Sandbox transitioned to stopped/hibernated. Settle and close the row.
 * The next start/wake will open a fresh row via startComputeSession.
 */
export async function pauseComputeSession(sandboxId: string): Promise<void> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;
  const row = await getOpenComputeSession(sandboxId);
  if (!row) return;

  const now = new Date();
  await settleComputeWindow(row, now);
  await updateComputeSession(row.id, {
    state: 'stopped',
    endedAt: now.toISOString(),
  });
}

/**
 * Sandbox is being woken from a stopped state. Open a new row.
 * Caller passes the current spec — spec may have changed if the project
 * manifest was edited between the stop and the wake.
 */
export async function resumeComputeSession(opts: StartComputeOpts): Promise<string | null> {
  return startComputeSession(opts);
}

/**
 * Sandbox is being permanently removed (restart / delete). Finalize the row.
 */
export async function endComputeSession(sandboxId: string): Promise<void> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;
  const row = await getOpenComputeSession(sandboxId);
  if (!row) return;

  const now = new Date();
  await settleComputeWindow(row, now);
  await updateComputeSession(row.id, {
    state: 'finalized',
    endedAt: now.toISOString(),
  });
}

/**
 * Cron entry point. Every 15 minutes: find sessions that have been billing for
 * over an hour without a hook firing, settle a partial window. Prevents a
 * missed close from accumulating uncharged compute indefinitely.
 */
export async function tickRunningComputeCharges(): Promise<{ settled: number }> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return { settled: 0 };
  const cutoff = new Date(Date.now() - PARTIAL_BILL_INTERVAL_MS);
  const stale = await findStaleActiveSessions(cutoff);
  let settled = 0;
  const now = new Date();
  for (const row of stale) {
    try {
      await settleComputeWindow(row, now);
      settled += 1;
    } catch (err) {
      console.error(`[compute-metering] tick failed for session ${row.id}:`, err);
    }
  }
  return { settled };
}
