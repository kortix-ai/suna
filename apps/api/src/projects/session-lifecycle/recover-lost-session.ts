/**
 * Continue a lost session on a new computer (KRTX-2419).
 *
 * A session is lost when the provider removed its box and no in-place recovery
 * answered (`preserveEstablishedRuntime`: `runtimeIdentityState: 'unavailable'`).
 * Nothing continues it on its own: the identity stays preserved until a person
 * asks. This is that ask, and it reuses two existing paths:
 *
 * - The retired row of restore-after-delete (`restore-session.ts`): the row
 *   gives up its external id, names it in `ephemeralRetiredExternalId`, and the
 *   next open claims it for a fresh box from the session branch
 *   (`claimRetiredSandboxRow`). As there, the row gives up the id only once the
 *   provider confirmed the old box removed, so no box is left without a record.
 * - The session-log restore at boot (kortixd `harness/shared/session-log-boot.ts`):
 *   `lostRecoveredAt` on the session turns it on for this session's boxes
 *   (`session-sandbox-env-build.ts`), whatever the project flag. The new box
 *   writes the saved conversation back under the same root, so the agent and
 *   the transcript keep the history.
 *
 * The saved conversation is checked first: a session with neither a session log
 * nor a v1 mirror to convert (`writeSessionLogFromMirror`) is refused and keeps
 * its lost row. Nothing here deletes a transcript.
 */
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { RETIRED_EXTERNAL_ID_KEY } from '../../platform/services/retired-sandbox-row';
import { db } from '../../shared/db';
import { attemptArchivedBoxRemoval, PROVIDER_REMOVED_KEY } from '../reaping/archived-box-removal';
import { writeSessionLogFromMirror } from '../session-log-capture';
import { readSessionLogManifest } from '../session-log-ingest';
import { transitionSandbox } from './status-transitions';

/** On the session: its boxes restore from the session log at boot. */
export const LOST_RECOVERED_AT_KEY = 'lostRecoveredAt';

const LOST_IDENTITY_KEYS = ['runtimeIdentityState', 'runtimeUnavailableReason', 'runtimeUnavailableAt', 'preservedExternalId'];

export type RecoverLostSessionResult =
  | { ok: true }
  | { status: 404 | 409 | 503; error: string; code?: string };

const NOT_LOST = {
  status: 409,
  error: "This session's computer is not lost. Open the session to resume it.",
  code: 'session_not_lost',
} as const;

const NO_TRANSCRIPT = {
  status: 409,
  error: 'This session has no saved conversation, so it cannot continue on a new computer. Nothing was changed.',
  code: 'session_transcript_missing',
} as const;

const REMOVAL_PENDING = {
  status: 409,
  error: 'The lost computer is still being removed. Try again in a minute.',
  code: 'session_sandbox_removal_pending',
} as const;

const RESTORE_OFF = {
  status: 503,
  error: 'Continuing a lost session is off on this deployment.',
  code: 'session_log_restore_off',
} as const;

export async function recoverLostSession(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  now?: Date;
}): Promise<RecoverLostSessionResult> {
  const { projectId, sessionId, accountId } = input;
  const now = input.now ?? new Date();
  if (!config.SESSION_LOG_INGEST_ENABLED || !config.SESSION_LOG_RESTORE_ENABLED) return RESTORE_OFF;

  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.projectId, projectId)))
    .limit(1);
  const metadata = (sandbox?.metadata ?? {}) as Record<string, unknown>;
  if (!sandbox?.externalId || sandbox.status !== 'stopped' || metadata.runtimeIdentityState !== 'unavailable') {
    return NOT_LOST;
  }
  const externalId = sandbox.externalId;

  // The saved conversation: the log a journal wrote, or the v1 mirror
  // converted now (a no-op when a journal owns the log).
  await writeSessionLogFromMirror(sessionId);
  const manifest = await readSessionLogManifest({ sessionId, projectId, accountId });
  if (!manifest?.messages.some((message) => !message.deleted)) return NO_TRANSCRIPT;

  if (metadata[PROVIDER_REMOVED_KEY] == null) {
    const removal = await attemptArchivedBoxRemoval({
      sandboxId: sandbox.sandboxId,
      externalId,
      provider: sandbox.provider,
      metadata: sandbox.metadata,
    });
    if (removal !== 'removed') return REMOVAL_PENDING;
  }

  const retired = await db.transaction(async (tx) => {
    const row = await transitionSandbox(
      'retireLost',
      sandbox.sandboxId,
      {
        at: now,
        // The identity guard admits a null external id only with this marker
        // naming the old one (migration 20261010040239500).
        columns: { externalId: null },
        metadata: {
          strip: LOST_IDENTITY_KEYS,
          merge: { [RETIRED_EXTERNAL_ID_KEY]: externalId, [PROVIDER_REMOVED_KEY]: now.toISOString() },
        },
        // Still the lost box the checks above saw.
        guard: and(
          eq(sessionSandboxes.externalId, externalId),
          sql`${sessionSandboxes.metadata} ->> 'runtimeIdentityState' = 'unavailable'`,
        ),
      },
      tx,
    );
    if (!row) return false;
    await tx
      .update(projectSessions)
      .set({
        metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object(${LOST_RECOVERED_AT_KEY}::text, ${now.toISOString()}::text)`,
      })
      .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)));
    return true;
  });
  if (!retired) return NOT_LOST;

  logger.info('Lost session continues on a new computer from its saved log', {
    event: 'runtime.lost_recovered',
    provider: sandbox.provider,
    externalId,
    sandboxId: sandbox.sandboxId,
    sessionId,
    messages: manifest.messages.length,
  });
  return { ok: true };
}
