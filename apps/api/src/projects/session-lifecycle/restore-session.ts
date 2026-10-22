/**
 * `restoreSession`: take a deleted session out of the trash (KRTX-1734).
 *
 * A delete keeps the session row, its branch, its transcript and its stored
 * files, and removes its box. Until the retention purge takes its rows
 * (`SESSION_DELETE_ROWS_DAYS` after the delete, session-log-purge.ts), a
 * restore brings the session back:
 *
 *  - the tombstone (`deletedAt`, `deletedBy`) goes, so every list and read
 *    serves the session again and the purge skips it;
 *  - the archived sandbox row becomes a retired row with no external id
 *    (`isRetiredSandboxRow`), so the next open (a `/start` or a prompt)
 *    claims it and boots a fresh box from the session branch. The row is the
 *    only record of the old box, so it gives up that box only once the
 *    provider confirmed it removed (`providerRemovedAt`), and it is held while
 *    the first provisioning the delete interrupted can still land a box on it;
 *  - the fresh box gets the conversation back: `restoredAt` on the session
 *    turns the session-log restore at boot on for its boxes
 *    (`session-sandbox-env-build.ts`, as `lostRecoveredAt` does for a lost
 *    session), and a v1 mirror is converted to the session log first
 *    (`writeSessionLogFromMirror`). Without both, the box booted an empty
 *    conversation and the session showed none of its history.
 *
 * Public links and connector tokens the delete revoked stay revoked.
 */
import { projectSessions, sessionContentPurges, sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { RETIRED_EXTERNAL_ID_KEY } from '../../platform/services/retired-sandbox-row';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import {
  PROVIDER_REMOVAL_PENDING_KEY,
  PROVIDER_REMOVED_KEY,
  attemptArchivedBoxRemoval,
} from '../reaping/archived-box-removal';
import { writeSessionLogFromMirror } from '../session-log-capture';
import { SESSION_DELETE_ROWS_DAYS, sessionRestoreUntil } from '../session-log-purge';
import { STALE_PENDING_PROVISIONING_MS } from '../session-open/stopped-wake-result';
import { type SessionSandboxRow, transitionSandbox, transitionSession } from './status-transitions';

/**
 * `deleteSession` stamps it on a row it archives during the first
 * provisioning: provider.create may still return a box onto that row.
 */
export const DELETED_DURING_CREATE_KEY = 'deletedDuringCreateAt';

/** On the session: its boxes restore the conversation from the session log at boot. */
export const RESTORED_AT_KEY = 'restoredAt';

export type RestoreSessionResult =
  | { ok: true }
  | { status: 404 | 409 | 410; error: string; code?: string };

const TOMBSTONE_KEYS = ['deletedAt', 'deletedBy'] as const;
const REMOVAL_KEYS = [
  PROVIDER_REMOVAL_PENDING_KEY,
  'providerRemovalAttempts',
  'providerRemovalRetryAfterAt',
  'providerRemovalError',
  DELETED_DURING_CREATE_KEY,
] as const;

const NOT_DELETED = {
  status: 409,
  error: 'This session is not deleted',
  code: 'session_not_deleted',
} as const;

const PURGED = {
  status: 410,
  error: `This session was deleted more than ${SESSION_DELETE_ROWS_DAYS} days ago. Its messages and files are gone.`,
  code: 'session_purged',
} as const;

const REMOVAL_PENDING = {
  status: 409,
  error: "The deleted session's sandbox is still being removed. Try again in a minute.",
  code: 'session_sandbox_removal_pending',
} as const;

/** The restore lost a race to a write that moved one of its rows. */
class RestoreLost extends Error {
  constructor(readonly refusal: Exclude<RestoreSessionResult, { ok: true }>) {
    super(refusal.error);
  }
}

const noPurgeMarker = sql`not exists (select 1 from ${sessionContentPurges} where ${sessionContentPurges.sessionId} = ${qualifiedColumn(projectSessions.sessionId)})`;

/** True while the archived row still names, or may still get, a box the provider has not removed. */
async function archivedBoxRemains(sandbox: SessionSandboxRow, now: Date): Promise<boolean> {
  const metadata = (sandbox.metadata ?? {}) as Record<string, unknown>;
  if (!sandbox.externalId) {
    const interruptedAt = Date.parse(String(metadata[DELETED_DURING_CREATE_KEY] ?? ''));
    return Number.isFinite(interruptedAt) && now.getTime() - interruptedAt < STALE_PENDING_PROVISIONING_MS;
  }
  if (metadata[PROVIDER_REMOVED_KEY] != null) return false;
  // The delete's own attempt usually confirmed the removal already. A row with
  // no stamp (a delete during provider.create, or from before the removal
  // lane) gets its first attempt here.
  const removal = await attemptArchivedBoxRemoval({
    sandboxId: sandbox.sandboxId,
    externalId: sandbox.externalId,
    provider: sandbox.provider,
    metadata: sandbox.metadata,
  });
  return removal !== 'removed';
}

export async function restoreSession(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  now?: Date;
}): Promise<RestoreSessionResult> {
  const { projectId, sessionId, accountId } = input;
  const now = input.now ?? new Date();
  const [session] = await db
    .select({ metadata: projectSessions.metadata, purgedAt: sessionContentPurges.rowsPurgedAt })
    .from(projectSessions)
    .leftJoin(sessionContentPurges, eq(sessionContentPurges.sessionId, projectSessions.sessionId))
    .where(
      and(
        eq(projectSessions.sessionId, sessionId),
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.accountId, accountId),
      ),
    )
    .limit(1);
  if (!session) return { status: 404, error: 'Not found' };

  const deletedAt = (session.metadata as Record<string, unknown> | null)?.deletedAt;
  if (typeof deletedAt !== 'string') return NOT_DELETED;
  // The window ends when the rows purge is due, not when it runs: a restore
  // must never race the purge that is about to empty the session.
  const restoreUntil = sessionRestoreUntil(deletedAt);
  if (session.purgedAt || (restoreUntil && now >= restoreUntil)) return PURGED;

  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (sandbox?.status === 'archived' && (await archivedBoxRemains(sandbox, now))) return REMOVAL_PENDING;

  // The log the fresh box restores from: the journal's, or the v1 mirror
  // converted now (a no-op when a journal or the backfill already wrote the
  // log). One that does not convert here (over the cap, or a failure) stays in
  // the backfill's selection, restorable deleted sessions included, so the
  // backfill is not drained and its next pass converts it.
  await writeSessionLogFromMirror(sessionId);

  try {
    await db.transaction(async (tx) => {
      const restored = await transitionSession(
        'restore',
        sessionId,
        {
          at: now,
          stripMetadata: TOMBSTONE_KEYS,
          metadata: { [RESTORED_AT_KEY]: now.toISOString() },
          guard: and(
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.accountId, accountId),
            noPurgeMarker,
          ),
        },
        tx,
      );
      if (!restored) throw new RestoreLost(NOT_DELETED);

      if (sandbox?.status === 'archived') {
        const retired = await transitionSandbox(
          'restore',
          sandbox.sandboxId,
          {
            at: now,
            // The identity guard admits a null external id only with this
            // marker naming the old one (migration 20261010040239500).
            columns: { externalId: null },
            metadata: {
              strip: REMOVAL_KEYS,
              merge: { [RETIRED_EXTERNAL_ID_KEY]: sandbox.externalId ?? '', sessionRestoredAt: now.toISOString() },
            },
            // The row still names the box the checks above saw, and that box
            // is confirmed removed.
            guard: sandbox.externalId
              ? and(
                  eq(sessionSandboxes.externalId, sandbox.externalId),
                  sql`${sessionSandboxes.metadata} ? ${PROVIDER_REMOVED_KEY}`,
                )
              : isNull(sessionSandboxes.externalId),
          },
          tx,
        );
        if (!retired) throw new RestoreLost(REMOVAL_PENDING);
      }
    });
  } catch (error) {
    // The session write loses only to a concurrent restore that already lifted
    // the tombstone. The sandbox write loses to a box that landed on the row,
    // or a removal record that changed, since the checks above.
    if (error instanceof RestoreLost) return error.refusal;
    throw error;
  }
  return { ok: true };
}
