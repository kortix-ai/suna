// The leader's daily audit archive tick (see archive.ts). Off unless AUDIT_ARCHIVE_ENABLED is set,
// the bucket is configured, and the bucket has Object Lock. Recursive setTimeout keeps ticks serial
// per process; every step of a pass is idempotent, so a leader change mid-pass is safe.
import { createDb } from '@kortix/db';
import { config } from '../../config';
import { ObjectStore, type ObjectLockMode } from '../../object-store/s3';
import { db as mainDb } from '../db';
import { runWorkerTick } from '../audit-scope';
import { type TickResult, runArchivePass } from './archive';

const TICK_MS = 24 * 3_600_000;
const FIRST_TICK_MS = 10 * 60_000;
const BUDGET_MS = 3 * 3_600_000;

const store = new ObjectStore(() => ({
  name: 'audit archive',
  bucket: config.AUDIT_ARCHIVE_BUCKET,
  region: config.AUDIT_ARCHIVE_REGION,
  endpoint: config.AUDIT_ARCHIVE_ENDPOINT,
  forcePathStyle: config.AUDIT_ARCHIVE_FORCE_PATH_STYLE,
  accessKeyId: config.AUDIT_ARCHIVE_ACCESS_KEY_ID,
  secretAccessKey: config.AUDIT_ARCHIVE_SECRET_ACCESS_KEY,
}));

export function auditArchiveStore(): ObjectStore {
  return store;
}

let pool: typeof mainDb | null = null;
/** The archive scans a week of rows: a pool of 2 with a 30 min statement timeout, not the API's 25 s. */
function archiveDb(): typeof mainDb {
  if (process.env.NODE_ENV === 'test') return mainDb;
  pool ??= createDb(config.DATABASE_URL, { max: 2, connection: { statement_timeout: 30 * 60_000, lock_timeout: 5_000 } });
  return pool;
}

export interface TickGate {
  enabled: boolean;
  configured: boolean;
  lockMode: () => Promise<ObjectLockMode | null>;
  run: (mode: ObjectLockMode, budgetMs: number) => Promise<TickResult>;
}

export type TickOutcome = ({ ran: true } & TickResult) | { ran: false; reason: string };

export async function runArchiveTick(gate: TickGate): Promise<TickOutcome> {
  if (!gate.enabled) return { ran: false, reason: 'disabled' };
  if (!gate.configured) return { ran: false, reason: 'no bucket configured' };
  const mode = await gate.lockMode();
  if (!mode) return { ran: false, reason: 'bucket has no Object Lock configuration' };
  return { ran: true, ...(await gate.run(mode, BUDGET_MS)) };
}

async function tickAndRearm(): Promise<void> {
  try {
    const outcome = await runWorkerTick('audit-archive', () =>
      runArchiveTick({
        enabled: config.AUDIT_ARCHIVE_ENABLED,
        configured: store.configured,
        lockMode: () => store.lockMode(),
        run: (mode, budgetMs) =>
          runArchivePass(
            {
              db: archiveDb(),
              store,
              mode,
              rowsPerSecond: config.AUDIT_ARCHIVE_ROWS_PER_SECOND,
              log: (message, detail) => console.warn(`[audit archive] ${message}`, detail ?? ''),
            },
            Date.now() + budgetMs,
          ),
      }),
    );
    if (outcome?.ran) console.info('[audit archive] pass finished', outcome);
    else if (outcome && config.AUDIT_ARCHIVE_ENABLED) console.warn('[audit archive] skipped:', outcome.reason);
  } catch (err) {
    console.error('[audit archive] pass failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, TICK_MS);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export function startAuditArchiveWorker(): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(tickAndRearm, FIRST_TICK_MS);
}

export function stopAuditArchiveWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
