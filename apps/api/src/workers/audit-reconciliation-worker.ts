import { runWorkerTick } from '../shared/audit-scope';
import {
  type AuditReconciliationFailureState,
  AuditReconciliationPageError,
  nextAuditReconciliationCursor,
  nextAuditReconciliationFailureDecision,
  runAuditReconciliationPage,
} from '../shared/audit-reconciliation-worker';

const ACTIVE_DELAY_MS = 100;
const IDLE_DELAY_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let active: Promise<void> | null = null;
let lastScannedAccountId: string | null = null;
let failureState: AuditReconciliationFailureState = { consecutiveFailures: 0, failingAccountId: null };

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
