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

import {
  appDeployments,
  appRuntimes,
  apps,
  creditAccounts,
  sandboxComputeSessions,
  sessionSandboxes,
} from '@kortix/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../../config';
import {
  type ProviderName,
  type SandboxWorkloadType,
  getProvider,
} from '../../platform/providers';
import { getProviderComputeRateCard } from '../../platform/providers/compute-rates';
import { db } from '../../shared/db';
import {
  type SandboxSpec,
  claimComputeWindow,
  findStaleActiveSessions,
  getLatestComputeSession,
  getOpenComputeSession,
  insertComputeSession,
  releaseComputeWindow,
} from '../repositories/compute-sessions';
import { getCreditAccount } from '../repositories/credit-accounts';
import { resolveAccountBilling } from './billing-cache';
import {
  billableWindowEnd,
  computeLivenessGraceMs,
  lastAliveAtOf,
} from './compute-liveness';
import { settleCredits } from './settle-credits';
import {
  DEFAULT_COMPUTE_RATE_MULTIPLIER,
  clampComputeRateMultiplier,
} from './entitlement-overrides';
import { accountMetersCompute } from './tiers';

/** Kept in lockstep with accountMetersCompute() — see tier-facts.ts. */
const METERED_BILLING_MODELS = ['per_seat', 'credit'] as const;

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
  /**
   * `monitor` is the per-project monitor box. It has no `session_sandboxes` and
   * no `app_runtimes` row — its `sandbox_id` IS `project_monitor_boxes.box_id`,
   * which is what every monitor-aware billing join keys on. No extra column is
   * needed for it (unlike `app_runtime_id`, which exists because an App runtime
   * id and its compute row's sandbox id were allowed to diverge).
   */
  workloadType?: SandboxWorkloadType;
  appRuntimeId?: string | null;
}

/**
 * Compute the cost (in USD, pre-balance-deduction) for a window.
 * All supported providers use one public customer rate.
 *
 * `rateMultiplier` is the account's custom compute price
 * (`ResolvedBilling.compute.rateMultiplier`). It defaults to 1 — list price,
 * which is what every account bills at unless an operator set an override — and
 * is clamped into `[0, MAX_COMPUTE_RATE_MULTIPLIER]` here as well as at the
 * resolver, because this function is also called directly (pricing pages,
 * tests) with a number that never passed through the resolver. 0 is a
 * deliberate value: free compute.
 */
export function calculateComputeCost(
  spec: SandboxSpec,
  durationSeconds: number,
  provider: ProviderName = 'daytona',
  rateMultiplier: number = DEFAULT_COMPUTE_RATE_MULTIPLIER,
): number {
  if (durationSeconds <= 0) return 0;
  const rate = getProviderComputeRateCard(provider);
  const cpuCost = spec.cpuCores * rate.cpuPerCoreSecond * durationSeconds;
  const memCost = spec.memoryGb * rate.memoryPerGbSecond * durationSeconds;
  const diskCost = spec.diskGb * rate.diskPerGbSecond * durationSeconds;
  return (cpuCost + memCost + diskCost) * clampComputeRateMultiplier(rateMultiplier);
}

/**
 * The account's compute rate multiplier, resolved through the 30s billing
 * cache (one cached row read per account, not a query per settle).
 *
 * FAILS OPEN TO LIST PRICE. A resolver or database hiccup must never stop a
 * window from being billed, and 1.0 is what the account would have paid before
 * custom pricing existed — the safe direction is "bill normally", not "bill
 * nothing" and not "throw away the window".
 */
async function computeRateMultiplierFor(accountId: string): Promise<number> {
  try {
    const resolved = await resolveAccountBilling(accountId);
    return clampComputeRateMultiplier(resolved.compute.rateMultiplier);
  } catch (err) {
    console.warn(
      `[compute-metering] could not resolve the compute rate multiplier for ${accountId}; billing at list price:`,
      err instanceof Error ? err.message : String(err),
    );
    return DEFAULT_COMPUTE_RATE_MULTIPLIER;
  }
}

/**
 * Open a metering row when a sandbox transitions to `active`.
 * No-op for legacy accounts — they continue to be billed via the flat machine
 * tier model in COMPUTE_TIERS.
 */
export async function startComputeSession(opts: StartComputeOpts): Promise<string | null> {
  // Hard gate: self-hosted / billing-disabled deploys never meter compute, even
  // if a credit_accounts row has a metered billing_model (stale data).
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return null;
  const account = await getCreditAccount(opts.accountId);
  // `accountMetersCompute`, NOT `isPerSeatAccount`. Per-seat used to be the only
  // metered model, so the gate was written as an identity check; read literally
  // it grants every other model free compute. The v3 `credit` plans are metered
  // too — that omission would have been an unbilled hole through the new tiers.
  if (!accountMetersCompute(account?.billingModel)) return null;

  // If a row is already open (e.g. duplicate hook), reuse it.
  const existing = await getOpenComputeSession(opts.sandboxId);
  if (existing) return existing.id;

  // PostgreSQL defaults retain microseconds, but JavaScript Date reads only
  // milliseconds. Pin both timestamps to one JavaScript instant so the first
  // billing window cannot include a sub-millisecond interval before started_at.
  const startedAt = new Date().toISOString();
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
    startedAt,
    lastBilledAt: startedAt,
    metadata: (opts.metadata ?? {}) as Record<string, unknown>,
    workloadType: opts.workloadType ?? 'session',
    appRuntimeId: opts.appRuntimeId ?? null,
  }).catch(async (err) => {
    if ((err as { code?: string })?.code !== '23505') throw err;
    return getOpenComputeSession(opts.sandboxId);
  });
  return row?.id ?? null;
}

/**
 * Bill a partial window without closing the row. Updates `cost_usd` and
 * `last_billed_at`, emits a `compute_debit` ledger entry, and optionally closes
 * the row in the same compare-and-set as the final cursor move.
 * Used by both `pauseComputeSession` (final) and the cron tick (partial).
 */
async function settleComputeWindow(
  row: typeof sandboxComputeSessions.$inferSelect,
  windowEnd: Date,
  terminalState?: 'stopped' | 'finalized',
): Promise<'settled' | 'contended' | 'debit_failed' | 'no_window'> {
  const lastBilled = new Date(row.lastBilledAt);
  // THE CLAMP — never bill past the last control-plane observation that the box
  // was alive, plus the provider's own auto-stop ceiling. A sandbox physically
  // cannot outlive that, so anything beyond it is billing a box that no longer
  // exists (measured 2026-07-29: one row had accrued 829 hours this way, and
  // 54% of an affected customer's compute bill was time the box provably could
  // not have been running). See services/compute-liveness.ts.
  const billableEnd = billableWindowEnd({
    requestedEnd: windowEnd,
    lastAliveAt: lastAliveAtOf(row),
    graceMs: computeLivenessGraceMs(),
  });
  // A terminal row cannot end before its billing cursor. The cursor can already
  // be later than an evidenced stop after an earlier partial settle. Preserve
  // that historical debit, close at the cursor, and never move time backwards.
  const claimedEnd =
    terminalState && billableEnd.getTime() < lastBilled.getTime() ? lastBilled : billableEnd;
  const durationSeconds = Math.max(0, (claimedEnd.getTime() - lastBilled.getTime()) / 1000);
  if (durationSeconds <= 0 && !terminalState) {
    // Nothing more is billable, but advance nothing either: `last_billed_at`
    // stays put so a box that comes back alive resumes from where it stopped.
    return 'no_window';
  }

  const spec: SandboxSpec = {
    cpuCores: row.cpuCores,
    memoryGb: row.memoryGb,
    diskGb: row.diskGb,
    gpuCount: row.gpuCount,
  };
  // Resolved BEFORE the CAS claim so the amount that is claimed, debited, and
  // (on a failed debit) released is one number. Reading it after the claim
  // would let a mid-settle override change make the release arithmetic differ
  // from the claim.
  const rateMultiplier = await computeRateMultiplierFor(row.accountId);
  const windowCost = calculateComputeCost(
    spec,
    durationSeconds,
    row.provider as ProviderName,
    rateMultiplier,
  );
  // CLAIM BEFORE DEBITING. The order is the whole fix.
  //
  // This used to debit first and move the cursor afterwards, with the update
  // keyed on `id` alone. Two settlers that had loaded the same row therefore
  // both billed the same seconds — the customer paid twice for one hour, and
  // the duplicate ledger rows were byte-identical and landed in the same
  // second. Claiming first means the loser of the race bills nothing at all.
  const claimed = await claimComputeWindow({
    id: row.id,
    expectedLastBilledAt: row.lastBilledAt,
    nextLastBilledAt: claimedEnd.toISOString(),
    addCostUsd: windowCost,
    terminalState,
  });
  if (!claimed) {
    // Someone else settled this window. Not an error, and not worth a warning
    // on a path that runs every few minutes for every live box.
    return 'contended';
  }

  if (windowCost <= 0) return 'settled';

  // Settle the wallet. These seconds are already consumed — the sandbox ran —
  // so this is a SETTLEMENT, not an admission, and it records even when the
  // wallet cannot cover it (see settleCredits). Auto-topup still fires.
  //
  // The release path below is now a genuine error path rather than the steady
  // state it used to be: a drained account no longer bounces every window
  // forever, it records the overdraft once and blocks the next admission.
  try {
    await settleCredits(
      row.accountId,
      windowCost,
      // The multiplier is named in the description only when it is not list
      // price, so a custom-priced debit is self-explaining in the ledger and an
      // ordinary one reads exactly as it always has.
      `Sandbox compute · ${row.cpuCores}vCPU/${row.memoryGb}GB/${row.diskGb}GB · ${durationSeconds.toFixed(0)}s${
        rateMultiplier === DEFAULT_COMPUTE_RATE_MULTIPLIER ? '' : ` · ${rateMultiplier}× rate`
      }`,
      'compute_debit',
      // Derived from WHAT is billed — this session and this window end — so a
      // retry after a lost response produces the same key and replays instead
      // of charging again. The CAS claim above already stops two settlers from
      // both billing; this covers the single settler that never learned its own
      // debit succeeded.
      `compute:${row.id}:${claimedEnd.toISOString()}`,
    );
  } catch (err) {
    // No longer reachable for a merely-drained wallet (settlement overdrafts
    // instead of refusing). Retained for the real failures that remain — a
    // missing credit row, an RPC/transport error — where handing the window
    // back is still right: the accrual must never outrun the ledger.
    const released = await releaseComputeWindow({
      id: row.id,
      claimedLastBilledAt: claimedEnd.toISOString(),
      revertToLastBilledAt: row.lastBilledAt,
      subCostUsd: windowCost,
      terminalState,
    });
    console.warn(
      `[compute-metering] failed to debit ${row.accountId} for session ${row.id}` +
        `${released ? '' : ' (window NOT released — another settler moved the cursor; seconds forfeited)'}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 'debit_failed';
  }

  return 'settled';
}

/**
 * Sandbox transitioned to stopped/hibernated. Settle and close the row.
 * The next runtime start will open a fresh row via startComputeSession.
 *
 * `windowEnd` bills through an EARLIER, affirmatively-evidenced instant instead
 * of `now` — used by the billing-invariant sweep (projects/sandbox-reaper.ts
 * `reconcileOrphanComputeSessions`) when it finds a row that has been open long
 * after the box actually died: a box whose sandbox row we flipped to `stopped`
 * 34 days ago must be billed through that flip, not through the moment we
 * finally noticed. `settleComputeWindow` clamps a window end at or behind
 * `last_billed_at` to a zero-cost settle, so this can only ever stop future
 * accrual — it never re-charges and never silently refunds an already-debited
 * amount (refunds stay a deliberate human action: see
 * scripts/reimburse-compute-leak.ts). Omitted → `now`, the original behaviour.
 */
export async function pauseComputeSession(sandboxId: string, windowEnd?: Date): Promise<void> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;
  const row = await getOpenComputeSession(sandboxId);
  if (!row) return;

  const now = new Date();
  const billThrough =
    windowEnd && !Number.isNaN(windowEnd.getTime()) && windowEnd.getTime() < now.getTime()
      ? windowEnd
      : now;
  await closeComputeWindow(row, 'stopped', billThrough);
}

/**
 * THE ONLY service entry point that closes `sandbox_compute_sessions`.
 *
 * `ended_at` is what every downstream reader treats as "this window is closed
 * and will never accrue again" — `getOpenComputeSession` keys off `IS NULL`, the
 * usage rollup in projects/routes/gateway.ts coalesces to it, and the reimburse
 * script bounds refunds by it. The repository claim writes `last_billed_at`,
 * `cost_usd`, `state`, and `ended_at` in one compare-and-set. The two exported
 * closers differ only in the terminal state they record.
 */
async function closeComputeWindow(
  row: typeof sandboxComputeSessions.$inferSelect,
  state: 'stopped' | 'finalized',
  billThrough: Date,
): Promise<void> {
  let current = row;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await settleComputeWindow(current, billThrough, state);
    if (result !== 'contended') return;

    // A partial settler moved the cursor first. Reload and claim the remaining
    // terminal window. A competing terminal settler leaves no open row.
    const refreshed = await getOpenComputeSession(row.sandboxId);
    if (!refreshed) return;
    current = refreshed;
  }
  throw new Error(`compute close contention exceeded retry budget for ${row.id}`);
}

/**
 * Record that the CONTROL PLANE observed this box alive — the only thing that
 * lets its window keep billing (services/compute-liveness.ts). Called wherever
 * the API itself confirms a running box: a `getStatus()` that answered
 * `running`, a completed busy probe.
 *
 * Deliberately NOT called from anything the sandbox authors about itself. The
 * execution-lease heartbeat is exactly such a signal and it is what let 188 of
 * 279 prod boxes bill around the clock; letting a box extend its own bill is
 * the bug, not the feature.
 *
 * Best-effort and idempotent: a missed stamp can only ever UNDER-bill, which is
 * the correct direction to fail.
 */
export async function markComputeSessionAlive(sandboxId: string, at = new Date()): Promise<void> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;
  await db
    .update(sandboxComputeSessions)
    .set({
      metadata: sql`coalesce(${sandboxComputeSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastAliveAt: at.toISOString() })}::jsonb`,
    })
    .where(
      and(
        eq(sandboxComputeSessions.sandboxId, sandboxId),
        isNull(sandboxComputeSessions.endedAt),
      ),
    );
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

  await closeComputeWindow(row, 'finalized', new Date());
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
 * `accountMetersCompute` gate (no-op for `legacy` accounts — never reimplemented
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
 * which is the same fail-closed outcome as the `accountMetersCompute` gate below.
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
        // Mirrors accountMetersCompute() — every metered billing model, not just
        // per-seat. A model missing here silently stops being charged.
        inArray(creditAccounts.billingModel, METERED_BILLING_MODELS),
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
    // Oldest sandbox first — an unordered LIMIT lets the planner's scan order
    // crowd the same rows out of every batch forever (maintenance.ts:147 fixed
    // exactly this once already; five sweeps still carried the bug).
    .orderBy(asc(sessionSandboxes.createdAt))
    .limit(limit);
}

/**
 * App equivalent of selectMissingComputeCandidates(). An App runtime is
 * billable only while it is the active deployment, its desired state is
 * running, and the runtime row itself is running.
 */
export function selectMissingAppComputeCandidates(limit = RECONCILE_MISSING_BATCH_SIZE) {
  return db
    .select({
      sandboxId: appRuntimes.runtimeId,
      accountId: appRuntimes.accountId,
      provider: appRuntimes.provider,
      externalId: appRuntimes.externalId,
      cpuCores: apps.cpuCores,
      memoryGb: apps.memoryGb,
      diskGb: apps.diskGb,
      appId: apps.appId,
      deploymentId: appDeployments.deploymentId,
    })
    .from(appRuntimes)
    .innerJoin(appDeployments, eq(appDeployments.deploymentId, appRuntimes.deploymentId))
    .innerJoin(
      apps,
      and(
        eq(apps.appId, appDeployments.appId),
        eq(apps.activeDeploymentId, appDeployments.deploymentId),
      ),
    )
    .innerJoin(
      creditAccounts,
      and(
        eq(creditAccounts.accountId, appRuntimes.accountId),
        inArray(creditAccounts.billingModel, METERED_BILLING_MODELS),
      ),
    )
    .leftJoin(
      sandboxComputeSessions,
      and(
        eq(sandboxComputeSessions.sandboxId, appRuntimes.runtimeId),
        isNull(sandboxComputeSessions.endedAt),
      ),
    )
    .where(and(
      eq(appRuntimes.status, 'running'),
      eq(apps.desiredState, 'running'),
      isNull(apps.deletedAt),
      isNull(sandboxComputeSessions.id),
    ))
    .orderBy(asc(appRuntimes.createdAt))
    .limit(limit);
}

export async function reconcileMissingAppComputeSessions(
  limit = RECONCILE_MISSING_BATCH_SIZE,
): Promise<ReconcileMissingComputeResult> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return { checked: 0, reconciled: 0, errors: 0 };

  const rows = await selectMissingAppComputeCandidates(limit);
  let reconciled = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const status = await getProvider(row.provider as ProviderName).getStatus(row.externalId);
      if (status !== 'running') continue;
      const opened = await startComputeSession({
        sandboxId: row.sandboxId,
        accountId: row.accountId,
        provider: row.provider as ProviderName,
        spec: {
          cpuCores: row.cpuCores,
          memoryGb: row.memoryGb,
          diskGb: row.diskGb,
          gpuCount: 0,
        },
        workloadType: 'app',
        appRuntimeId: row.sandboxId,
        metadata: { appId: row.appId, deploymentId: row.deploymentId, reconciled: true },
      });
      if (opened) reconciled += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `[compute-metering] reconcile-missing App failed for runtime ${row.sandboxId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { checked: rows.length, reconciled, errors };
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

  const [sessionResult, appResult] = await Promise.all([
    reconcileMissingComputeSessions().catch((err) => {
      console.error('[compute-metering] reconcile-missing session pass failed:', err);
      return { checked: 0, reconciled: 0, errors: 0 };
    }),
    reconcileMissingAppComputeSessions().catch((err) => {
      console.error('[compute-metering] reconcile-missing App pass failed:', err);
      return { checked: 0, reconciled: 0, errors: 0 };
    }),
  ]);

  return { settled, reconciled: sessionResult.reconciled + appResult.reconciled };
}
