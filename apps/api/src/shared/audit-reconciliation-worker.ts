import { sql } from 'drizzle-orm';
import { recordAuditEvent } from './audit';
import { type AuditReconciliationResult, reconcileAuditEvents } from './audit-reconciliation';
import { db } from './db';

const PAGE_SIZE = 1_000;
const ACTIVE_DELAY_MS = 100;
const IDLE_DELAY_MS = 60_000;
const ERROR_DELAY_MS = 5_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let active: Promise<void> | null = null;
let lastScannedAccountId: string | null = null;

interface PendingAccount extends Record<string, unknown> {
  accountId: string;
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

/**
 * Reconcile the next account in UUID order.
 *
 * `afterAccountId` is an in-memory scan cursor, not a durable completion flag.
 * Every replica therefore revisits every account once per cycle. This detects
 * source-ledger drift that occurs after the initial v2 backfill marker.
 */
export async function runAuditReconciliationPage(
  afterAccountId: string | null = null,
): Promise<AuditReconciliationPage> {
  const rows = await db.execute<PendingAccount>(sql`
    SELECT account_id AS "accountId"
      FROM kortix.accounts account
     WHERE (${afterAccountId}::uuid IS NULL OR account.account_id > ${afterAccountId}::uuid)
     ORDER BY account.account_id
     LIMIT 1
  `);
  const accountId = Array.from(rows as unknown as PendingAccount[])[0]?.accountId ?? null;
  if (!accountId) return { accountId: null, result: null };

  const result = await reconcileAuditEvents(accountId, PAGE_SIZE);
  if (result.complete) {
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
    console.warn(
      '[audit-reconciliation] page failed',
      error instanceof Error ? error.message : String(error),
    );
    schedule(ERROR_DELAY_MS);
  }
}

function schedule(delay: number): void {
  if (stopped || timer) return;
  timer = setTimeout(() => {
    timer = null;
    const run = tick();
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
  schedule(0);
}

export async function stopAuditReconciliationWorker(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  lastScannedAccountId = null;
  await active;
}
