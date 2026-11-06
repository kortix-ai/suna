/**
 * Write one recovered log into the API's session log, and record the outcome.
 *
 * The write goes through `writeCapturedSessionLog`, the path the old mirror
 * capture used (generation 0, revs 1..n): a restore later claims generation 1,
 * so the next wake of the box restores this log into pi.
 *
 * It writes only when, inside the same transaction, the session is still what
 * the recovery read: no session log exists (a journal, or pi's first boot
 * write, wins and this one is skipped), the session is not deleted, and the
 * sandbox row is still parked. So a person who opens the session meanwhile is
 * never left with two roots.
 */
import { createHash } from 'node:crypto';
import { sessionSandboxes } from '@kortix/db';
import { SessionLogSchema, type SessionLog, type SessionLogJournalRequest } from '@kortix/api-contract/session-log';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { storeSessionLogBlob } from '../../projects/session-log-blobs';
import { writeCapturedSessionLog, type SessionLogScope } from '../../projects/session-log-ingest';
import { attachmentsOf } from './convert';

export const RECOVERY_KEY = 'opencodeHistoryRecovery';

export type WriteOutcome = 'written' | 'skipped' | 'invalid' | 'refused';

/** True while the session has no log, is not deleted, and its sandbox row is parked. */
export async function stillRecoverable(sessionId: string, executor: Pick<typeof db, 'execute'> = db): Promise<boolean> {
  const rows = await executor.execute<{ ok: boolean }>(sql`
    SELECT (
      NOT EXISTS (SELECT 1 FROM kortix.session_logs l WHERE l.session_id = ${sessionId})
      AND EXISTS (
        SELECT 1 FROM kortix.project_sessions ps
        JOIN kortix.session_sandboxes ss ON ss.session_id = ps.session_id
        WHERE ps.session_id = ${sessionId}
          AND NOT ps.metadata ? 'deletedAt'
          AND ss.status IN ('stopped', 'error')
          AND NOT ss.metadata ?| array['runtimeWakeId', 'runtimeRestartId', 'runtimeRecoveryLeaseId']
      )
    ) AS ok`);
  return rows[0]?.ok === true;
}

/** True while Kortix holds the sandbox row as parked: the box is the recovery's to stop. */
export async function rowParked(sessionId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM kortix.session_sandboxes ss
      WHERE ss.session_id = ${sessionId}
        AND ss.status IN ('stopped', 'error')
        AND NOT ss.metadata ?| array['runtimeWakeId', 'runtimeRestartId', 'runtimeRecoveryLeaseId']
    ) AS ok`);
  return rows[0]?.ok === true;
}

/** Uploads every attachment's bytes and swaps its `blob:` ref for the stored object's ref. */
async function storeAttachments(scope: SessionLogScope, log: SessionLog, blobs: Map<string, { mime: string; data: Buffer }>): Promise<void> {
  const refs = new Map<string, string>();
  for (const [sha, blob] of blobs) {
    if (createHash('sha256').update(blob.data).digest('hex') !== sha) continue;
    refs.set(sha, await storeSessionLogBlob(scope, sha, blob.mime, blob.data));
  }
  for (const m of log.threads.flatMap((t) => t.messages)) {
    for (const a of attachmentsOf(m)) {
      if (!a.ref?.startsWith('blob:')) continue;
      const stored = refs.get(a.ref.slice(5));
      if (stored) a.ref = stored;
      else delete a.ref; // bytes we could not store: an unresolved attachment, as the old backfill left it
    }
  }
}

export async function writeRecoveredLog(
  scope: SessionLogScope,
  log: SessionLog,
  blobs: Map<string, { mime: string; data: Buffer }>,
): Promise<{ outcome: WriteOutcome; detail?: string }> {
  const valid = SessionLogSchema.safeParse(log);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    return { outcome: 'invalid', detail: `${issue?.path.join('.')}: ${issue?.code}` };
  }
  if (!(await stillRecoverable(scope.sessionId))) return { outcome: 'skipped', detail: 'session changed before the write' };
  await storeAttachments(scope, log, blobs);
  const { threads, ...session } = log;
  const batch: SessionLogJournalRequest = {
    generation: 0,
    session,
    threads: threads.map(({ messages: _m, ...t }) => t),
    puts: threads.flatMap((t) => t.messages).map((message, i) => ({ rev: i + 1, message })),
    tombstones: [],
  };
  const out = await writeCapturedSessionLog(scope, batch, (tx) => stillRecoverable(scope.sessionId, tx));
  if (out === 'skipped') return { outcome: 'skipped', detail: 'session changed during the write' };
  if (out.status !== 200) return { outcome: 'refused', detail: `${out.status} ${JSON.stringify(out.body).slice(0, 200)}` };
  return { outcome: 'written' };
}

export interface RecoveryStamp {
  at: string;
  outcome: string;
  attempts: number;
  detail?: string;
  messages?: number;
  threads?: number;
  /** The store's size: a run with a higher `--max-store-mb` retakes a `too_large` under it. */
  bytes?: number;
}

/**
 * Records the outcome on the sandbox row's metadata, so a later run skips a
 * finished session. A metadata-only change: `updated_at` and the session row
 * are not touched, and the row-change notification does not fire.
 */
export async function stamp(sandboxId: string, value: RecoveryStamp): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({ metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ [RECOVERY_KEY]: value })}::jsonb` })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}
