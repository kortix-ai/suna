import { promptAttachments, promptAttachmentReferences, sessionLifecycleCommands } from '@kortix/db';
import { PROMPT_ATTACHMENT_TTL_MS } from '@kortix/shared';
import { and, asc, eq, gt, inArray, lt, ne, or, sql, type SQLWrapper } from 'drizzle-orm';
import { db } from '../lib/db';
import type { PromptPartWire } from './session-lifecycle/store';
import { PromptAttachmentError, type PromptAttachmentScope, type Row, type Transaction, storage, chunkedMode, chunkBytes, filePath, chunkPath, assertOwner, noReferences, FINALIZE_LEASE_MS } from './prompt-attachment-storage';

/** Rows claimed per cleanup batch. In direct mode one batch is one Storage call. */
const CLEANUP_BATCH_SIZE = 100;
/** Storage API rejects a DELETE that names more than 1000 objects. */
const STORAGE_REMOVE_MAX_NAMES = 1000;
/** Cleanup starts no Storage call after this. Every API process runs it each
 * 5-minute maintenance tick, with no leader lock, beside the other maintenance
 * tasks. A call started inside the budget can still run to its 20 s Storage
 * timeout, so a tick ends within about 50 s. A failed removal ends it at once. */
const CLEANUP_BUDGET_MS = 30_000;
/** Direct mode stores one object. Chunked mode also stores derivable chunk objects. */
function objectNames(row: Row): string[] {
  const chunkCount = chunkedMode() ? Math.ceil(row.sizeBytes / chunkBytes()) : 0;
  return [filePath(row), ...Array.from({ length: chunkCount }, (_, i) => chunkPath(row, i))];
}
/** Called only after the rows' objects are removed. */
async function dropRemovedMetadata(attachmentIds: string[], now: Date) {
  await db
    .delete(promptAttachments)
    .where(
      and(
        inArray(promptAttachments.attachmentId, attachmentIds),
        eq(promptAttachments.status, 'deleting'),
        lt(promptAttachments.expiresAt, now),
        noReferences(),
      ),
    );
}
async function removeObjects(row: Row, now = new Date()) {
  const { data, error } = await storage().remove(objectNames(row));
  if (error)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment removal failed. Retry shortly.',
      503,
    );
  // Missing objects are a successful deletion. Supabase returns only existing
  // keys, so an absent item in its response is not evidence of failure.
  void data;
  await dropRemovedMetadata([row.attachmentId], now);
}

export async function deletePromptAttachment(scope: PromptAttachmentScope, attachmentId: string) {
  const row = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(promptAttachments)
      .where(eq(promptAttachments.attachmentId, attachmentId))
      .for('update');
    if (!row) return null;
    assertOwner(row, scope);
    const [ref] = await tx
      .select()
      .from(promptAttachmentReferences)
      .where(eq(promptAttachmentReferences.attachmentId, attachmentId))
      .limit(1);
    if (ref)
      throw new PromptAttachmentError(
        'attachment_in_use',
        'Attachment belongs to a submitted prompt.',
        409,
      );
    if (row.status === 'finalizing' && row.updatedAt.getTime() > Date.now() - FINALIZE_LEASE_MS)
      throw new PromptAttachmentError(
        'attachment_processing',
        'Attachment is being processed. Retry removal shortly.',
        409,
      );
    if (row.status !== 'deleting') {
      // A timed-out upstream write can finish after this first removal. Keep
      // its object names durable for a settlement TTL and remove them again
      // before dropping metadata. Repeated DELETE must not extend the TTL.
      await tx
        .update(promptAttachments)
        .set({
          status: 'deleting',
          expiresAt: new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS),
          updatedAt: new Date(),
        })
        .where(eq(promptAttachments.attachmentId, attachmentId));
    }
    return row;
  });
  if (row) await removeObjects(row);
}

/** A delivered prompt keeps its files this long after its command closed. A
 * redelivery can re-queue a closed prompt whose turn never ran; the grace keeps
 * its files for that window. Forwarded prompts are not closed, so they wait. */
const PROMPT_ATTACHMENT_RELEASE_GRACE_MS = 60 * 60_000;
const RELEASE_BATCH_SIZE = 200;

/** Drop the references of the selected commands. An attachment left with no
 * reference expires now, so the cleanup sweep removes its object, then its
 * metadata (KEEP 4). One transaction: a failure keeps every reference, and the
 * retried delete or the next delivery sweep releases them again. */
async function releaseCommandReferences(
  commands: SQLWrapper,
  expireAt: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    const released = await tx
      .delete(promptAttachmentReferences)
      .where(inArray(promptAttachmentReferences.commandId, commands))
      .returning({ attachmentId: promptAttachmentReferences.attachmentId });
    const ids = [...new Set(released.map((reference) => reference.attachmentId))].sort();
    if (ids.length > 0) {
      // bindPromptAttachments locks these rows in attachment_id order. An
      // unordered UPDATE could lock them in another order and deadlock a
      // release racing a bind of the same files. The UPDATE then takes a fresh
      // READ COMMITTED snapshot, so it sees references that bind committed.
      await tx
        .select({ attachmentId: promptAttachments.attachmentId })
        .from(promptAttachments)
        .where(inArray(promptAttachments.attachmentId, ids))
        .orderBy(asc(promptAttachments.attachmentId))
        .for('update');
      await tx
        .update(promptAttachments)
        .set({ expiresAt: expireAt })
        .where(
          and(
            inArray(promptAttachments.attachmentId, ids),
            gt(promptAttachments.expiresAt, expireAt),
            noReferences(),
          ),
        );
    }
    return released.length;
  });
}

/** Terminal successful delivery plus the grace period releases a command's
 * references. Queued, running, forwarded (on the wire, not yet consumed), failed
 * and dead-lettered commands keep theirs. Bounded per call; scanned from the
 * references table, which holds only unreleased references. */
async function releaseDeliveredPromptAttachments(now = new Date()): Promise<number> {
  const delivered = db
    .select({ commandId: promptAttachmentReferences.commandId })
    .from(promptAttachmentReferences)
    .innerJoin(
      sessionLifecycleCommands,
      eq(sessionLifecycleCommands.commandId, promptAttachmentReferences.commandId),
    )
    .where(
      and(
        eq(sessionLifecycleCommands.status, 'succeeded'),
        sql`${sessionLifecycleCommands.result}->>'status' IS DISTINCT FROM 'forwarded'`,
        lt(
          sessionLifecycleCommands.updatedAt,
          new Date(now.getTime() - PROMPT_ATTACHMENT_RELEASE_GRACE_MS),
        ),
      ),
    )
    .limit(RELEASE_BATCH_SIZE);
  return releaseCommandReferences(delivered, new Date(now.getTime() - 1));
}

/** A deleted session releases the references of every command it holds. */
export async function releasePromptAttachmentsForSession(input: {
  sessionId: string;
  projectId: string;
  accountId: string;
}): Promise<number> {
  return releaseCommandReferences(
    db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, input.sessionId),
          eq(sessionLifecycleCommands.projectId, input.projectId),
          eq(sessionLifecycleCommands.accountId, input.accountId),
        ),
      ),
    new Date(Date.now() - 1),
  );
}

/** An archived project releases the references of every command it holds. */
export async function releasePromptAttachmentsForProject(projectId: string): Promise<number> {
  return releaseCommandReferences(
    db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, projectId)),
    new Date(Date.now() - 1),
  );
}

/** Claims one batch: its expired, unreferenced rows become `deleting`. */
async function claimExpiredPromptAttachments(
  now: Date,
): Promise<{ claimed: number; rows: Row[] }> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(promptAttachments)
      .where(
        and(
          lt(promptAttachments.expiresAt, now),
          noReferences(),
          or(
            ne(promptAttachments.status, 'finalizing'),
            lt(promptAttachments.updatedAt, new Date(now.getTime() - FINALIZE_LEASE_MS)),
          ),
        ),
      )
      // Walks idx_prompt_attachments_expiry from the oldest expired row. Released
      // references leave only unsent, in-flight and dead-lettered rows behind.
      .orderBy(asc(promptAttachments.expiresAt))
      .limit(CLEANUP_BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (!candidates.length) return { claimed: 0, rows: [] };
    // READ COMMITTED gives this statement a fresh reference snapshot. The
    // candidate SELECT can predate a binder's commit even after tuple locking.
    const rows = await tx
      .update(promptAttachments)
      .set({ status: 'deleting' })
      .where(
        and(
          inArray(
            promptAttachments.attachmentId,
            candidates.map((row) => row.attachmentId),
          ),
          noReferences(),
        ),
      )
      .returning();
    return { claimed: candidates.length, rows };
  });
}

/** Removes a claimed batch with as few Storage calls as the name cap allows,
 * then drops the metadata of each call's rows. `stopped` ends the sweep: a
 * failed call or the spent budget leaves the remaining rows `deleting` and
 * expired, so the next tick claims them again. */
async function removeClaimedPromptAttachments(
  rows: Row[],
  now: Date,
  deadline: number,
): Promise<{ deleted: number; errors: number; stopped: boolean }> {
  let deleted = 0,
    calls = 0,
    next = 0;
  while (next < rows.length) {
    // Whole rows share a call; a row with more names than one call holds takes several.
    const group: Row[] = [];
    const names: string[] = [];
    while (next < rows.length) {
      const rowNames = objectNames(rows[next]!);
      if (group.length && names.length + rowNames.length > STORAGE_REMOVE_MAX_NAMES) break;
      group.push(rows[next++]!);
      names.push(...rowNames);
    }
    try {
      for (let offset = 0; offset < names.length; offset += STORAGE_REMOVE_MAX_NAMES) {
        // The sweep checks the budget before each claim, so a batch's first call always runs.
        if (calls++ > 0 && performance.now() >= deadline)
          return { deleted, errors: 0, stopped: true };
        // Missing objects are a successful deletion (see removeObjects).
        const { error } = await storage().remove(
          names.slice(offset, offset + STORAGE_REMOVE_MAX_NAMES),
        );
        if (error) throw error;
      }
      await dropRemovedMetadata(group.map((row) => row.attachmentId), now);
      deleted += group.length;
    } catch {
      return { deleted, errors: rows.length - deleted, stopped: true };
    }
  }
  return { deleted, errors: 0, stopped: false };
}

export async function cleanupExpiredPromptAttachments(
  now = new Date(),
): Promise<{ deleted: number; errors: number }> {
  const deadline = performance.now() + CLEANUP_BUDGET_MS;
  let deleted = 0,
    errors = 0;
  // Delivered prompts release first, so their files expire in this same sweep.
  await releaseDeliveredPromptAttachments(now).catch((error) => {
    errors = 1;
    console.warn(
      '[prompt-attachments] reference release failed:',
      error instanceof Error ? error.message : error,
    );
  });
  // Batches repeat until one is short (the backlog is drained), a removal fails
  // (retrying the same rows at once would fail again), or the budget is spent.
  for (;;) {
    const { claimed, rows } = await claimExpiredPromptAttachments(now);
    const removal = await removeClaimedPromptAttachments(rows, now, deadline);
    deleted += removal.deleted;
    errors += removal.errors;
    if (removal.stopped || claimed < CLEANUP_BATCH_SIZE || performance.now() >= deadline) break;
  }
  return { deleted, errors };
}

/** The command deletion and expiry renewal share one transaction. A queue
 * Undo re-posts the original handles; it must not lose an already-expired file
 * between dropping the final reference and its five-second Undo action. */
export async function retainPromptAttachmentsForUndo(
  tx: Transaction,
  command: {
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    payload: Record<string, unknown>;
  },
) {
  const ids =
    (command.payload.parts as PromptPartWire[] | undefined)?.flatMap((part) =>
      part.attachment_id ? [part.attachment_id] : [],
    ) ?? [];
  if (!ids.length || !command.actorUserId) return;
  const rows = await tx
    .select()
    .from(promptAttachments)
    .where(
      and(
        inArray(promptAttachments.attachmentId, ids),
        eq(promptAttachments.accountId, command.accountId),
        eq(promptAttachments.projectId, command.projectId),
        eq(promptAttachments.userId, command.actorUserId),
        eq(promptAttachments.status, 'ready'),
      ),
    )
    .orderBy(asc(promptAttachments.attachmentId))
    .for('update');
  const grace = new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS);
  for (const row of rows) {
    if (row.expiresAt < grace)
      await tx
        .update(promptAttachments)
        .set({ expiresAt: grace, updatedAt: new Date() })
        .where(eq(promptAttachments.attachmentId, row.attachmentId));
  }
}

