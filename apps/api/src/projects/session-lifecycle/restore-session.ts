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
 *    (`isRetiredEphemeralRow`), so the next open (a `/start` or a prompt)
 *    claims it and boots a fresh box from the session branch. The row is the
 *    only record of the old box's removal, so it gives up that box only once
 *    the provider confirmed it removed;
 *  - an ephemeral session's state volume, which the delete queued for
 *    deletion, leaves the queue.
 *
 * Public links and connector tokens the delete revoked stay revoked.
 */
import { platinumVolumeDeletions, projectSessions, sessionContentPurges, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';

import { EPHEMERAL_RETIRED_KEY, ownSessionStateVolume } from '../../platform/services/ephemeral-sandbox';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { PROVIDER_REMOVAL_PENDING_KEY, attemptArchivedBoxRemoval } from '../reaping/archived-box-removal';
import { SESSION_DELETE_ROWS_DAYS, sessionRestoreUntil } from '../session-log-purge';
import { transitionSandbox, transitionSession } from './status-transitions';

export type RestoreSessionResult =
  | { ok: true }
  | { status: 404 | 409 | 410; error: string; code?: string };

const TOMBSTONE_KEYS = ['deletedAt', 'deletedBy'] as const;
const REMOVAL_KEYS = [
  PROVIDER_REMOVAL_PENDING_KEY,
  'providerRemovalAttempts',
  'providerRemovalRetryAfterAt',
  'providerRemovalError',
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
class RestoreLost extends Error {}

const noPurgeMarker = sql`not exists (select 1 from ${sessionContentPurges} where ${sessionContentPurges.sessionId} = ${qualifiedColumn(projectSessions.sessionId)})`;
const removalPending = (metadata: unknown) =>
  (metadata as Record<string, unknown> | null)?.[PROVIDER_REMOVAL_PENDING_KEY] != null;

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
  if (sandbox?.status === 'archived' && sandbox.externalId && removalPending(sandbox.metadata)) {
    // The delete's own attempt usually confirmed the removal already. One
    // more try here; the maintenance lane keeps retrying a refusal.
    const removal = await attemptArchivedBoxRemoval({
      sandboxId: sandbox.sandboxId,
      externalId: sandbox.externalId,
      provider: sandbox.provider,
      metadata: sandbox.metadata,
    });
    if (removal !== 'removed') return REMOVAL_PENDING;
  }

  try {
    await db.transaction(async (tx) => {
      const restored = await transitionSession(
        'restore',
        sessionId,
        {
          at: now,
          stripMetadata: TOMBSTONE_KEYS,
          guard: and(
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.accountId, accountId),
            noPurgeMarker,
          ),
        },
        tx,
      );
      if (!restored) throw new RestoreLost();

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
              merge: { [EPHEMERAL_RETIRED_KEY]: sandbox.externalId ?? '', sessionRestoredAt: now.toISOString() },
            },
            guard: sql`not (coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) ? ${PROVIDER_REMOVAL_PENDING_KEY})`,
          },
          tx,
        );
        if (!retired) throw new RestoreLost();
      }

      const volume = ownSessionStateVolume(sessionId, session.metadata);
      if (volume) await tx.delete(platinumVolumeDeletions).where(eq(platinumVolumeDeletions.volumeName, volume));
    });
  } catch (error) {
    // Both writes lock the session row first, so the race a restore can lose
    // is a concurrent restore that already lifted the tombstone.
    if (error instanceof RestoreLost) return NOT_DELETED;
    throw error;
  }
  return { ok: true };
}
