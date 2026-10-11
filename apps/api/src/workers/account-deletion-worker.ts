import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';

// Executes due scheduled account deletions. The only processor of
// `kortix.account_deletion_requests`: the Supabase pg_cron job that used to
// own this read the pre-baseline legacy `public` copy of the table (migration
// 20260924205551453 kept its function alive for that job), so nothing has
// executed since the schema moved to `kortix`. bootstrap.ts starts this with
// the other singleton workers, on the elected leader only. The first tick
// runs immediately so a new leader drains the backlog it inherited; afterwards
// one pass every 15 minutes. The auth-user-delete trigger schedules orphan
// accounts as due-now requests, so a daily pass would leave them unreachable
// (403) for up to a day. Idle ticks cost one indexed read. Runs with billing
// off too: self-hosted deployments request deletions through the same routes,
// and the auth-user-delete trigger schedules orphan accounts on every
// deployment.
const TICK_MS = 15 * 60 * 1000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let active: Promise<void> | null = null;

async function tick(): Promise<void> {
  const { processScheduledDeletions } = await import('../billing/services/account-deletion');
  await processScheduledDeletions();
}

function schedule(delayMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    active = runWorkerTick('account-deletion', tick)
      .catch((err) =>
        logger.error('[AccountDeletion] scheduled deletion tick failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .then(() => {
        if (!stopped) schedule(TICK_MS);
      });
  }, delayMs);
}

export function startAccountDeletionSchedule(): void {
  if (!stopped) return;
  stopped = false;
  schedule(0);
}

export async function stopAccountDeletionSchedule(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  await active;
}
