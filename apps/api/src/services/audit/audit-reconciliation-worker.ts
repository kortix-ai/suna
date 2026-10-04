import { sql } from 'drizzle-orm';
import { recordAuditEvent } from './audit';
import {
  type AuditReconciliationResult,
  FULL_RESCAN_DAYS,
  reconcileAuditEvents,
} from './audit-reconciliation';
import { db } from '../../lib/db';
import { runWorkerTick } from './audit-scope';

const PAGE_SIZE = 1_000;
// An account is revisited at most this often. The visit is cheap (it reads
// only rows newer than the account's high-water mark), but 45k accounts at a
// 60s idle loop was ~750 visits/s across the fleet for no new data.
const RECHECK_HOURS = 6;
const ACTIVE_DELAY_MS = 100;
const IDLE_DELAY_MS = 60_000;
// Escalating retry delay for a page that keeps failing: 5s, 30s, 120s, then
// capped at 300s. A flat 5s retry forever burns I/O on every replica (the
// query is the same expensive scan every time) without ever making progress.
const ERROR_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
// After this many consecutive failures on the SAME account, stop retrying it
// and advance the cursor past it. One permanently broken account must not
// stall reconciliation for every account after it forever.
const MAX_CONSECUTIVE_ACCOUNT_FAILURES = 3;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let active: Promise<void> | null = null;
let lastScannedAccountId: string | null = null;
let failureState: AuditReconciliationFailureState = { consecutiveFailures: 0, failingAccountId: null };

/** Raised by {@link runAuditReconciliationPage} so the caller knows which
 * account was being reconciled when the page failed, without changing the
 * function's success-path return shape. */
export class AuditReconciliationPageError extends Error {
  readonly accountId: string;

  constructor(accountId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AuditReconciliationPageError';
    this.accountId = accountId;
    this.cause = cause;
  }
}

interface PendingAccount extends Record<string, unknown> {
  accountId: string;
  /** No mark yet, or the weekly full rescan is due: this pass reads all history. */
  fullDue: boolean;
}

export interface AuditReconciliationPage {
  accountId: string | null;
  result: AuditReconciliationResult | null;
}

export function nextAuditReconciliationCursor(
  previousAccountId: string | null,
  page: AuditReconciliationPage,
): string | null {
  if (!page.accountId) return null;
  return page.result?.complete ? page.accountId : previousAccountId;
}

export interface AuditReconciliationFailureState {
  consecutiveFailures: number;
  failingAccountId: string | null;
}

export interface AuditReconciliationFailureDecision {
  state: AuditReconciliationFailureState;
  delayMs: number;
  /** Set when the same account has failed `MAX_CONSECUTIVE_ACCOUNT_FAILURES`
   * times in a row: the caller should advance its cursor to this account id
   * so the next tick scans past it instead of retrying it again. */
  skipToAccountId: string | null;
}

/**
 * Decide the retry delay for a failed page, and whether to give up on the
 * account that failed and move on.
 *
 * Pure so the escalation/skip policy is testable without a database or fake
 * timers, same as {@link nextAuditReconciliationCursor}.
 */
export function nextAuditReconciliationFailureDecision(
  previousState: AuditReconciliationFailureState,
  failedAccountId: string | null,
): AuditReconciliationFailureDecision {
  const sameAccount =
    failedAccountId !== null && failedAccountId === previousState.failingAccountId;
  const consecutiveFailures = sameAccount ? previousState.consecutiveFailures + 1 : 1;
  const skip = failedAccountId !== null && consecutiveFailures >= MAX_CONSECUTIVE_ACCOUNT_FAILURES;
  const delayMs =
    ERROR_DELAYS_MS[Math.min(consecutiveFailures - 1, ERROR_DELAYS_MS.length - 1)];
  return {
    state: skip
      ? { consecutiveFailures: 0, failingAccountId: null }
      : { consecutiveFailures, failingAccountId: failedAccountId },
    delayMs,
    skipToAccountId: skip ? failedAccountId : null,
  };
}

/**
 * Reconcile the next DUE account in UUID order.
 *
 * `afterAccountId` is an in-memory scan cursor. Durable progress is the
 * per-account high-water mark in `kortix.audit_reconciliation_state`
 * (see `reconcileAuditEvents`): an account is due when it has no mark or its
 * mark is older than `RECHECK_HOURS`. Late source-ledger drift is caught by
 * the incremental window; old history is re-verified every `FULL_RESCAN_DAYS`.
 */
export async function runAuditReconciliationPage(
  afterAccountId: string | null = null,
): Promise<AuditReconciliationPage> {
  const rows = await db.execute<PendingAccount>(sql`
    SELECT account.account_id AS "accountId",
           (state.account_id IS NULL
            OR state.full_scan_at < now() - ${sql.raw(`interval '${FULL_RESCAN_DAYS} days'`)}) AS "fullDue"
      FROM kortix.accounts account
      LEFT JOIN kortix.audit_reconciliation_state state ON state.account_id = account.account_id
     WHERE (${afterAccountId}::uuid IS NULL OR account.account_id > ${afterAccountId}::uuid)
       AND (state.checked_at IS NULL
            OR state.checked_at < now() - ${sql.raw(`interval '${RECHECK_HOURS} hours'`)})
     ORDER BY account.account_id
     LIMIT 1
  `);
  const next = Array.from(rows as unknown as PendingAccount[])[0];
  if (!next) return { accountId: null, result: null };
  const { accountId, fullDue } = next;

  let result: AuditReconciliationResult;
  try {
    result = await reconcileAuditEvents(accountId, PAGE_SIZE);
  } catch (error) {
    throw new AuditReconciliationPageError(accountId, error);
  }
  // The completion marker is one row per account (v2): record it after a full
  // pass only. An incremental pass would re-attempt the same insert every visit.
  if (result.complete && fullDue) {
    await recordAuditEvent({
      accountId,
      actorType: 'system',
      authoritativeSource: 'system',
      action: 'audit.reconciliation.completed',
      phase: 'completed',
      outcome: 'success',
      resourceType: 'audit_ledger',
      resourceId: accountId,
      sourceLedger: 'audit_reconciliation',
      sourceRecordId: accountId,
      sourceRevision: 'v2',
      outputSummary: { inserted: result.inserted, complete: true, by_source: result.by_source },
    });
  }
  return { accountId, result };
}

async function tick(): Promise<void> {
  if (stopped) return;
  try {
    const previousAccountId = lastScannedAccountId;
    const page = await runAuditReconciliationPage(previousAccountId);
    failureState = { consecutiveFailures: 0, failingAccountId: null };
    if (page.accountId) {
      // Do not advance past an account while it still has another bounded
      // source-ledger page. Advancing here limited a large backfill to one
      // page per full account scan (and one scan per idle interval).
      lastScannedAccountId = nextAuditReconciliationCursor(previousAccountId, page);
      schedule(ACTIVE_DELAY_MS);
    } else {
      lastScannedAccountId = null;
      schedule(IDLE_DELAY_MS);
    }
  } catch (error) {
    const failedAccountId = error instanceof AuditReconciliationPageError ? error.accountId : null;
    const decision = nextAuditReconciliationFailureDecision(failureState, failedAccountId);
    failureState = decision.state;
    if (decision.skipToAccountId) {
      console.warn(
        '[audit-reconciliation] skipping account after repeated failures',
        decision.skipToAccountId,
      );
      lastScannedAccountId = decision.skipToAccountId;
    }
    console.warn(
      '[audit-reconciliation] page failed',
      error instanceof Error ? error.message : String(error),
    );
    schedule(decision.delayMs);
  }
}

function schedule(delay: number): void {
  if (stopped || timer) return;
  timer = setTimeout(() => {
    timer = null;
    const run = runWorkerTick('audit-reconciliation', tick);
    active = run;
    void run.finally(() => {
      if (active === run) active = null;
    });
  }, delay);
  timer.unref?.();
}

export function startAuditReconciliationWorker(): void {
  if (!stopped) return;
  stopped = false;
  lastScannedAccountId = null;
  failureState = { consecutiveFailures: 0, failingAccountId: null };
  schedule(0);
}

export async function stopAuditReconciliationWorker(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  lastScannedAccountId = null;
  failureState = { consecutiveFailures: 0, failingAccountId: null };
  await active;
}
