// The leader's daily audit archive tick (see archive.ts). Off unless AUDIT_ARCHIVE_ENABLED is set,
// the bucket is configured, and the bucket has Object Lock. Every step of a pass is idempotent, so
// a leader change mid-pass is safe. The timer is in workers/audit-archive.ts.
import { createDb } from '@kortix/db';
import { config } from '../../../lib/config';
import type { ObjectLockMode } from '../../../lib/object-store/s3';
import { db as mainDb } from '../../../lib/db';
import { type TickResult, runArchivePass } from './archive';
import { auditArchiveStore } from './store';

const BUDGET_MS = 3 * 3_600_000;

const store = auditArchiveStore();

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
  /** Prod: the archive is the only copy once a week is dropped, so a bypassable GOVERNANCE lock is not enough. */
  requireCompliance?: boolean;
  lockMode: () => Promise<ObjectLockMode | null>;
  run: (mode: ObjectLockMode, budgetMs: number) => Promise<TickResult>;
}

export type TickOutcome = ({ ran: true } & TickResult) | { ran: false; reason: string };

export async function runArchiveTick(gate: TickGate): Promise<TickOutcome> {
  if (!gate.enabled) return { ran: false, reason: 'disabled' };
  if (!gate.configured) return { ran: false, reason: 'no bucket configured' };
  const mode = await gate.lockMode();
  if (!mode) return { ran: false, reason: 'bucket has no Object Lock configuration' };
  if (gate.requireCompliance && mode !== 'COMPLIANCE') {
    return { ran: false, reason: `bucket uses ${mode} Object Lock; this environment requires COMPLIANCE` };
  }
  return { ran: true, ...(await gate.run(mode, BUDGET_MS)) };
}

/** One scheduled pass: the archive with this environment's gate, bucket and pool. */
export function runAuditArchiveOnce(): Promise<TickOutcome> {
  return runArchiveTick({
    enabled: config.AUDIT_ARCHIVE_ENABLED,
    configured: store.configured,
    requireCompliance: config.INTERNAL_KORTIX_ENV === 'prod',
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
  });
}
