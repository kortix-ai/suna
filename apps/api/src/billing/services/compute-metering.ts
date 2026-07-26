// Billing v2 — sandbox compute metering.
//
// Sandboxes declare their reserved spec (cpu / memory / disk / gpu) in
// kortix.yaml's `sandbox:` block. We bill against that reserved spec × wall-clock time
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

import { and, eq, isNull } from 'drizzle-orm';
import { creditAccounts, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import { config } from '../../config';
import { getProvider, type ProviderName } from '../../platform/providers';
import { getProviderComputeRateCard } from '../../platform/providers/compute-rates';
import { db } from '../../shared/db';
import {
  insertComputeSession,
  getOpenComputeSession,
  getLatestComputeSession,
  updateComputeSession,
  findStaleActiveSessions,
  type SandboxSpec,
} from '../repositories/compute-sessions';
import { getCreditAccount } from '../repositories/credit-accounts';
import { deductCredits } from './credits';
import { isPerSeatAccount } from './tiers';

const PARTIAL_BILL_INTERVAL_MS = 60 * 60 * 1000; // 1h
// Bounded like every other periodic sweep in this codebase (REAP_BATCH_SIZE in
// sandbox-reaper.ts, findStaleActiveSessions' default) so one pass can never
// stampede a large backlog of reconcile candidates into a burst of provider/DB
// writes — a full backlog just drains over several ticks instead.
const RECONCILE_MISSING_BATCH_SIZE = 100;

export interface StartComputeOpts {
  sandboxId: string;
  accountId: string;
  sessionId?: string | null;
  actorUserId?: string | null;
  provider?: ProviderName;
  spec: SandboxSpec;
  metadata?: Record<string, unknown>;
}

/**
 * Compute the cost (in USD, pre-balance-deduction) for a window.
 * Hosted providers use one public customer rate. local-docker uses zero rates
 * because it runs on operator-owned hardware.
 */
export function calculateComputeCost(
  spec: SandboxSpec,
  durationSeconds: number,
  provider: ProviderName = 'daytona',
): number {
  if (durationSeconds <= 0) return 0;
  const rate = getProviderComputeRateCard(provider);
  const cpuCost = spec.cpuCores * rate.cpuPerCoreSecond * durationSeconds;
  const memCost = spec.memoryGb * rate.memoryPerGbSecond * durationSeconds;
  const diskCost = spec.diskGb * rate.diskPerGbSecond * durationSeconds;
  return cpuCost + memCost + diskCost;
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
    provider: opts.provider ?? 'daytona',
    cpuCores: opts.spec.cpuCores,
    memoryGb: opts.spec.memoryGb,
    diskGb: opts.spec.diskGb,
    gpuCount: opts.spec.gpuCount ?? 0,
    state: 'active',
    metadata: (opts.metadata ?? {}) as Record<string, unknown>,
  }).catch(async (err) => {
    if ((err as { code?: string })?.code !== '23505') throw err;
    return getOpenComputeSession(opts.sandboxId);
  });
  return row?.id ?? null;
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
  const windowCost = calculateComputeCost(spec, durationSeconds, row.provider as ProviderName);
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
 * The next runtime start will open a fresh row via startComputeSession.
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
 * Reopen metering for a hibernated sandbox being resumed in place (the
 * stopped→active wake path). Reuses the spec from the sandbox's most recent
 * window so the resumed compute bills exactly like the original run, without
 * re-resolving the project manifest on the hot reopen path. No-op when billing
 * is disabled / the account isn't per-seat / a row is already open
 * (startComputeSession is idempotent on an open row).
 */
export async function reopenComputeForSandbox(
  sandboxId: string,
  accountId: string,
  sessionId?: string | null,
  actorUserId?: string | null,
  provider?: ProviderName,
): Promise<string | null> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return null;
  const last = await getLatestComputeSession(sandboxId);
  const spec: SandboxSpec = last
    ? { cpuCores: last.cpuCores, memoryGb: last.memoryGb, diskGb: last.diskGb, gpuCount: last.gpuCount }
    : { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };
  return startComputeSession({
    sandboxId,
    accountId,
    sessionId,
    actorUserId,
    provider: (last?.provider as ProviderName | undefined) ?? provider ?? 'daytona',
    spec,
  });
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

export interface ReconcileMissingComputeResult {
  checked: number;
  reconciled: number;
  errors: number;
}

/**
 * Reconciliation safety net for a close-without-reopen defect: a sandbox row
 * can end up `status='active'` with no open `sandbox_compute_sessions` row
 * behind it when a reopen hook (resume-in-place, provisioning finishing,
 * in-place runtime recovery — see `resumeStoppedSandbox` /
 * `openComputeSessionForSandbox` / `markInPlaceRuntimeRecoveryAccepted`) fires
 * its `reopenComputeForSandbox`/`startComputeSession` call fire-and-forget
 * (`void … .catch(warn)`): the sandbox row transition already committed by the
 * time that call runs, so if it fails nothing ever retries the metering open
 * and the box bills nothing for the rest of its life.
 *
 * This sweeps every `active` sandbox with no currently-open compute row and
 * reopens one via `reopenComputeForSandbox`, which already applies the
 * `isPerSeatAccount` gate (no-op for `legacy` accounts — never reimplemented
 * here) and reuses the sandbox's last known spec so a reconciled window bills
 * at the same rate the sandbox always has. Idempotent: `startComputeSession`
 * underneath is a no-op if a row already raced open between the SELECT below
 * and this call. Bounded per pass. Deliberately does NOT back-bill — the
 * reopened window starts accruing from `now`, exactly like every other reopen
 * path in this file; any already-elapsed unmetered time is a business
 * decision, not something this sweep silently charges for.
 */
/**
 * Candidate query, exported so its predicate can be asserted directly rather
 * than through a mock that reimplements the filtering.
 *
 * The `per_seat` inner join is load-bearing, not defence-in-depth: a `legacy`
 * account can NEVER be metered (`startComputeSession` returns early), so every
 * active legacy box matches "no open window" permanently. Without this filter an
 * unordered `LIMIT` fills with legacy rows on every pass and the per-seat rows
 * this sweep exists for are never reached — a no-op that costs a round-trip per
 * row. The inner join also drops accounts with no `credit_accounts` row at all,
 * which is the same fail-closed outcome as the `isPerSeatAccount` gate below.
 */
export function selectMissingComputeCandidates(limit = RECONCILE_MISSING_BATCH_SIZE) {
  return db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
    })
    .from(sessionSandboxes)
    .innerJoin(
      creditAccounts,
      and(
        eq(creditAccounts.accountId, sessionSandboxes.accountId),
        eq(creditAccounts.billingModel, 'per_seat'),
      ),
    )
    .leftJoin(
      sandboxComputeSessions,
      and(
        eq(sandboxComputeSessions.sandboxId, sessionSandboxes.sandboxId),
        isNull(sandboxComputeSessions.endedAt),
      ),
    )
    .where(and(eq(sessionSandboxes.status, 'active'), isNull(sandboxComputeSessions.id)))
    .limit(limit);
}

export async function reconcileMissingComputeSessions(
  limit = RECONCILE_MISSING_BATCH_SIZE,
): Promise<ReconcileMissingComputeResult> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return { checked: 0, reconciled: 0, errors: 0 };

  const rows = await selectMissingComputeCandidates(limit);

  let reconciled = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      // Liveness gate. Every stop path in this codebase closes billing FIRST and
      // flips `session_sandboxes.status` second (session-lifecycle/stop.ts,
      // sandbox-reaper.ts), so "active row, no open window" is ALSO exactly what a
      // half-completed stop looks like. Opening a window on DB state alone would
      // bill a box that is really stopped, and would fight
      // `reconcileOrphanComputeSessions` — which settles such rows back down and
      // pages via the BILLING INVARIANT VIOLATED monitor. Only reopen for a box the
      // provider still reports as running.
      if (!row.externalId) continue;
      const status = await getProvider(row.provider as ProviderName).getStatus(row.externalId);
      if (status !== 'running') continue;

      const opened = await reopenComputeForSandbox(
        row.sandboxId,
        row.accountId,
        row.sessionId,
        null,
        row.provider as ProviderName,
      );
      if (opened) reconciled += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `[compute-metering] reconcile-missing failed for sandbox ${row.sandboxId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (rows.length > 0) {
    console.log('[compute-metering] reconciled missing compute windows', {
      checked: rows.length,
      reconciled,
      errors,
    });
  }

  return { checked: rows.length, reconciled, errors };
}

/**
 * Cron entry point. Every 15 minutes: find sessions that have been billing for
 * over an hour without a hook firing, settle a partial window. Prevents a
 * missed close from accumulating uncharged compute indefinitely. Also runs the
 * missing-compute-session reconciler (see `reconcileMissingComputeSessions`)
 * in the same pass — the natural periodic hook for both safety nets.
 */
export async function tickRunningComputeCharges(): Promise<{ settled: number; reconciled: number }> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return { settled: 0, reconciled: 0 };
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

  const { reconciled } = await reconcileMissingComputeSessions().catch((err) => {
    console.error('[compute-metering] reconcile-missing pass failed:', err);
    return { checked: 0, reconciled: 0, errors: 0 };
  });

  return { settled, reconciled };
}
