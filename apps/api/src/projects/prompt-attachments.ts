import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  promptAttachments,
  promptAttachmentReferences,
  sessionLifecycleCommands,
} from '@kortix/db';
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS_BYTES,
  MAX_PROMPT_ATTACHMENT_FILES,
  PROMPT_ATTACHMENT_CHUNK_BYTES,
  PROMPT_ATTACHMENT_TTL_MS,
  sanitizePromptUploadFilename,
} from '@kortix/shared';
import { and, asc, eq, inArray, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../shared/db';
import { toPublicStorageUrl } from '../shared/supabase';
import { config } from '../config';
import type { PromptPartWire } from './session-lifecycle/store';

const BUCKET = 'staged-files';
const FINALIZE_LEASE_MS = 5 * 60_000;
const STORAGE_TIMEOUT_MS = 20_000;
const CLEANUP_BATCH_SIZE = 20;
let finalizations = 0;
let storageClient: SupabaseClient | undefined;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof promptAttachments.$inferSelect;
export interface PromptAttachmentScope {
  accountId: string;
  projectId: string;
  userId: string | null;
}
type BindingRow = Pick<
  Row,
  | 'attachmentId'
  | 'accountId'
  | 'projectId'
  | 'userId'
  | 'filename'
  | 'mime'
  | 'sizeBytes'
  | 'status'
  | 'expiresAt'
  | 'sha256'
>;

export class PromptAttachmentError extends HTTPException {
  constructor(
    readonly code: string,
    message: string,
    status: 400 | 404 | 409 | 413 | 503 = 400,
  ) {
    super(status, { message, res: Response.json({ error: message, code }, { status }) });
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function storage() {
  storageClient ??= createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(STORAGE_TIMEOUT_MS),
            ]),
          }),
        { preconnect: fetch.preconnect },
      ),
    },
  });
  return storageClient.storage.from(BUCKET);
}
function filePath(row: Pick<Row, 'objectPath'>) {
  return `${row.objectPath}/file`;
}
function chunkPath(row: Pick<Row, 'objectPath'>, index: number) {
  return `${row.objectPath}/chunks/${index}`;
}
function metadata(row: Row) {
  return {
    attachment_id: row.attachmentId,
    filename: row.filename,
    mime: row.mime,
    size: row.sizeBytes,
    expires_at: row.expiresAt.toISOString(),
  };
}
function assertOwner(
  row: BindingRow | undefined,
  scope: PromptAttachmentScope,
): asserts row is BindingRow {
  if (
    !row ||
    row.accountId !== scope.accountId ||
    row.projectId !== scope.projectId ||
    row.userId !== scope.userId
  ) {
    throw new PromptAttachmentError(
      'attachment_not_found',
      'Attachment not found. Attach the file again.',
      404,
    );
  }
}
function assertUnexpired(row: BindingRow, now: Date) {
  if (row.status === 'deleting')
    throw new PromptAttachmentError(
      'attachment_not_found',
      'Attachment not found. Attach the file again.',
      404,
    );
  if (row.expiresAt <= now)
    throw new PromptAttachmentError(
      'attachment_expired',
      'Attachment expired. Attach the file again.',
    );
}

export function validatePromptAttachmentRows<T extends BindingRow>(
  rows: T[],
  ids: string[],
  scope: PromptAttachmentScope,
  now = new Date(),
): T[] {
  if (ids.length > MAX_PROMPT_ATTACHMENT_FILES)
    throw new PromptAttachmentError(
      'attachment_count_limit',
      `Attach at most ${MAX_PROMPT_ATTACHMENT_FILES} files.`,
    );
  if (new Set(ids).size !== ids.length)
    throw new PromptAttachmentError('attachment_duplicate', 'Duplicate attachment_id.');
  const byId = new Map(rows.map((row) => [row.attachmentId, row]));
  let total = 0;
  return ids.map((id) => {
    const row = byId.get(id);
    assertOwner(row, scope);
    assertUnexpired(row, now);
    if (row.status !== 'ready' || !row.sha256)
      throw new PromptAttachmentError(
        'attachment_not_ready',
        'Attachment upload is incomplete. Wait for the upload or retry it.',
        409,
      );
    if (row.sizeBytes <= 0 || row.sizeBytes > MAX_PROMPT_ATTACHMENT_BYTES)
      throw new PromptAttachmentError(
        'attachment_size_limit',
        'Each attachment must contain 1 byte to 50 MiB.',
        413,
      );
    total += row.sizeBytes;
    if (total > MAX_PROMPT_ATTACHMENTS_BYTES)
      throw new PromptAttachmentError(
        'attachment_message_limit',
        'Attachments exceed the 100 MiB message limit.',
        413,
      );
    return row;
  });
}

/** Called only inside the command's insert transaction. The attachment lock is
 * also the cleanup fence; reference rows and canonical payload commit together. */
export async function bindPromptAttachments(
  tx: Transaction,
  command: {
    commandId: string;
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    payload: Record<string, unknown>;
  },
  sourceCommandId?: string,
): Promise<void> {
  const body = command.payload.body as Record<string, unknown> | undefined;
  const pending = body?.pending_prompt as Record<string, unknown> | undefined;
  let parts = (pending?.parts ?? command.payload.parts) as PromptPartWire[] | undefined;
  if (parts) {
    const { sanitizeInboxPromptParts } = await import('./session-lifecycle/prompt-parts');
    const sanitized = sanitizeInboxPromptParts(parts);
    if ('error' in sanitized)
      throw new PromptAttachmentError('attachment_parts_invalid', sanitized.error);
    parts = sanitized.parts;
  }
  const handles =
    parts?.filter((part) => part.type === 'file' && part.attachment_id !== undefined) ?? [];
  if (!handles.length || !parts) return;
  const ids = handles.map((part) => part.attachment_id!);
  const rows = await tx
    .select()
    .from(promptAttachments)
    .where(inArray(promptAttachments.attachmentId, [...new Set(ids)].sort()))
    .orderBy(asc(promptAttachments.attachmentId))
    .for('update');
  const now = new Date();
  let retained = new Set<string>();
  if (sourceCommandId) {
    const references = await tx
      .select({ attachmentId: promptAttachmentReferences.attachmentId })
      .from(promptAttachmentReferences)
      .innerJoin(
        sessionLifecycleCommands,
        eq(sessionLifecycleCommands.commandId, promptAttachmentReferences.commandId),
      )
      .where(
        and(
          eq(promptAttachmentReferences.commandId, sourceCommandId),
          eq(sessionLifecycleCommands.commandType, 'create_session'),
          eq(sessionLifecycleCommands.projectId, command.projectId),
          eq(sessionLifecycleCommands.accountId, command.accountId),
          command.actorUserId
            ? eq(sessionLifecycleCommands.actorUserId, command.actorUserId)
            : sql`false`,
        ),
      );
    retained = new Set(references.map((ref) => ref.attachmentId));
  }
  const ordered = validatePromptAttachmentRows(
    rows.map((row) =>
      retained.has(row.attachmentId) ? { ...row, expiresAt: new Date(now.getTime() + 1) } : row,
    ),
    ids,
    { accountId: command.accountId, projectId: command.projectId, userId: command.actorUserId },
    now,
  );
  const byId = new Map(ordered.map((row) => [row.attachmentId, row]));
  let total = ordered.reduce((sum, row) => sum + row.sizeBytes, 0);
  for (const part of parts) {
    if (
      part.type === 'file' &&
      !part.attachment_id &&
      part.url?.toLowerCase().startsWith('data:')
    ) {
      const { parseStagedPromptDataUrl } =
        await import('./session-lifecycle/prompt-attachment-materializer');
      total += parseStagedPromptDataUrl({
        filename: part.filename ?? 'File',
        mime: part.mime ?? '',
        url: part.url,
      }).bytes.byteLength;
    }
  }
  if (
    parts.filter((part) => part.type === 'file').length > MAX_PROMPT_ATTACHMENT_FILES ||
    total > MAX_PROMPT_ATTACHMENTS_BYTES
  ) {
    throw new PromptAttachmentError(
      'attachment_message_limit',
      'Attach at most 20 files totaling 100 MiB.',
      413,
    );
  }
  const canonical = parts.map((part) => {
    const row = part.attachment_id ? byId.get(part.attachment_id) : undefined;
    return row
      ? {
          type: 'file' as const,
          attachment_id: row.attachmentId,
          filename: row.filename,
          mime: row.mime,
        }
      : part;
  });
  await tx
    .insert(promptAttachmentReferences)
    .values(ids.map((attachmentId) => ({ commandId: command.commandId, attachmentId })))
    .onConflictDoNothing();
  const payload = pending
    ? { ...command.payload, body: { ...body, pending_prompt: { ...pending, parts: canonical } } }
    : { ...command.payload, parts: canonical };
  await tx
    .update(sessionLifecycleCommands)
    .set({ payload })
    .where(eq(sessionLifecycleCommands.commandId, command.commandId));
  command.payload = payload;
}

export async function beginPromptAttachment(
  scope: PromptAttachmentScope,
  input: { filename: string; mime: string; size: number },
) {
  if (!scope.userId)
    throw new PromptAttachmentError(
      'attachment_owner_required',
      'Attachment upload requires a user.',
    );
  if (
    !Number.isSafeInteger(input.size) ||
    input.size <= 0 ||
    input.size > MAX_PROMPT_ATTACHMENT_BYTES
  )
    throw new PromptAttachmentError(
      'attachment_size_limit',
      'Each attachment must contain 1 byte to 50 MiB.',
      413,
    );
  const mime = input.mime.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 255)
    throw new PromptAttachmentError('attachment_mime_invalid', 'Attachment MIME type is invalid.');
  const attachmentId = crypto.randomUUID();
  const [row] = await db
    .insert(promptAttachments)
    .values({
      ...scope,
      userId: scope.userId,
      attachmentId,
      objectPath: `prompt-attachments/${scope.projectId}/${attachmentId}`,
      filename: sanitizePromptUploadFilename(input.filename),
      mime,
      sizeBytes: input.size,
      expiresAt: new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS),
    })
    .returning();
  return { ...metadata(row), chunk_size: PROMPT_ATTACHMENT_CHUNK_BYTES };
}

export async function readPromptAttachmentChunk(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new PromptAttachmentError('attachment_empty', 'Attachment chunk is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (request.signal.aborted)
        throw new PromptAttachmentError('attachment_cancelled', 'Attachment upload was cancelled.');
      const next = await reader.read();
      if (request.signal.aborted)
        throw new PromptAttachmentError('attachment_cancelled', 'Attachment upload was cancelled.');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > PROMPT_ATTACHMENT_CHUNK_BYTES) {
        await reader.cancel();
        throw new PromptAttachmentError(
          'attachment_chunk_limit',
          'Attachment chunks must not exceed 64 KiB.',
          413,
        );
      }
      chunks.push(next.value);
    }
    if (!size) throw new PromptAttachmentError('attachment_empty', 'Attachment chunk is empty.');
    return Buffer.concat(chunks, size);
  } finally {
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function uploadPromptAttachmentChunk(
  scope: PromptAttachmentScope,
  attachmentId: string,
  index: number,
  bytes: Uint8Array,
) {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !bytes.byteLength ||
    bytes.byteLength > PROMPT_ATTACHMENT_CHUNK_BYTES
  )
    throw new PromptAttachmentError('attachment_chunk_invalid', 'Invalid attachment chunk.', 400);
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(promptAttachments)
      .where(eq(promptAttachments.attachmentId, attachmentId))
      .for('update');
    assertOwner(row, scope);
    assertUnexpired(row, new Date());
    const hash = digest(bytes);
    if (row.chunkDigests[index] === hash)
      return { received_bytes: row.receivedBytes, size: row.sizeBytes };
    if (row.status !== 'uploading' || index !== row.chunkDigests.length)
      throw new PromptAttachmentError(
        'attachment_chunk_conflict',
        'Attachment chunk is out of order or differs from an earlier upload.',
        409,
      );
    if (
      bytes.byteLength !==
      Math.min(PROMPT_ATTACHMENT_CHUNK_BYTES, row.sizeBytes - row.receivedBytes)
    )
      throw new PromptAttachmentError(
        'attachment_chunk_size',
        'Attachment chunk does not match the expected size.',
      );
    // Commit the renewed expiry even if storage answers ambiguously. Cleanup
    // then leaves a full TTL for any in-flight remote write to settle.
    await tx
      .update(promptAttachments)
      .set({ expiresAt: new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS), updatedAt: new Date() })
      .where(eq(promptAttachments.attachmentId, attachmentId));
    // The row already names every possible chunk path. An ambiguous write is
    // safe to repeat with upsert and cannot become an untracked orphan.
    const { error } = await storage().upload(chunkPath(row, index), bytes, {
      upsert: true,
      contentType: 'application/octet-stream',
    });
    if (error) return { error: true as const };
    const receivedBytes = row.receivedBytes + bytes.byteLength;
    await tx
      .update(promptAttachments)
      .set({ receivedBytes, chunkDigests: [...row.chunkDigests, hash], updatedAt: new Date() })
      .where(eq(promptAttachments.attachmentId, attachmentId));
    return { received_bytes: receivedBytes, size: row.sizeBytes };
  });
  if ('error' in result)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment upload failed. Retry this file.',
      503,
    );
  return result;
}

async function download(path: string): Promise<Uint8Array> {
  const { data, error } = await storage().download(
    path,
    {},
    { signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) },
  );
  if (error || !data)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment storage is unavailable. Retry this file.',
      503,
    );
  return new Uint8Array(await data.arrayBuffer());
}

export async function completePromptAttachment(scope: PromptAttachmentScope, attachmentId: string) {
  if (finalizations >= 2)
    throw new PromptAttachmentError(
      'attachment_upload_busy',
      'Attachment processing is busy. Retry shortly.',
      503,
    );
  finalizations++;
  const token = crypto.randomUUID();
  try {
    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(promptAttachments)
        .where(eq(promptAttachments.attachmentId, attachmentId))
        .for('update');
      assertOwner(row, scope);
      assertUnexpired(row, new Date());
      if (row.status === 'ready') return row;
      if (
        row.status === 'deleting' ||
        (row.status === 'finalizing' && row.updatedAt.getTime() > Date.now() - FINALIZE_LEASE_MS)
      )
        throw new PromptAttachmentError(
          'attachment_processing',
          'Attachment is being processed. Retry shortly.',
          409,
        );
      if (row.receivedBytes !== row.sizeBytes)
        throw new PromptAttachmentError(
          'attachment_not_ready',
          'Attachment upload is incomplete.',
          409,
        );
      await tx
        .update(promptAttachments)
        .set({
          status: 'finalizing',
          finalizeToken: token,
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS),
        })
        .where(eq(promptAttachments.attachmentId, attachmentId));
      return row;
    });
    if (row.status === 'ready') return metadata(row);
    try {
      const bytes = new Uint8Array(row.sizeBytes);
      // Bounded reads avoid one request per file chunk in sequence. The lease
      // persists across replica loss and permits a later complete retry.
      let next = 0;
      // No network write may outlive the five-minute lease. Each storage
      // request has a 20s deadline, and assembly stops starting reads after2min.
      const assemblyDeadline = Date.now() + 120_000;
      const reads = await Promise.allSettled(
        Array.from({ length: Math.min(16, row.chunkDigests.length) }, async () => {
          while (next < row.chunkDigests.length) {
            if (Date.now() > assemblyDeadline)
              throw new PromptAttachmentError(
                'attachment_storage_unavailable',
                'Attachment processing timed out. Retry this file.',
                503,
              );
            const index = next++;
            const chunk = await download(chunkPath(row, index));
            if (
              digest(chunk) !== row.chunkDigests[index] ||
              chunk.byteLength !==
                Math.min(
                  PROMPT_ATTACHMENT_CHUNK_BYTES,
                  row.sizeBytes - index * PROMPT_ATTACHMENT_CHUNK_BYTES,
                )
            )
              throw new PromptAttachmentError(
                'attachment_integrity_failed',
                'Attachment bytes failed verification. Attach the file again.',
              );
            bytes.set(chunk, index * PROMPT_ATTACHMENT_CHUNK_BYTES);
          }
        }),
      );
      const failedRead = reads.find((result) => result.status === 'rejected');
      if (failedRead?.status === 'rejected') throw failedRead.reason;
      if (Date.now() > assemblyDeadline)
        throw new PromptAttachmentError(
          'attachment_storage_unavailable',
          'Attachment processing timed out. Retry this file.',
          503,
        );
      const hash = digest(bytes);
      const { error } = await storage().upload(filePath(row), bytes, {
        upsert: true,
        contentType: row.mime,
      });
      if (error)
        throw new PromptAttachmentError(
          'attachment_storage_unavailable',
          'Attachment processing failed. Retry this file.',
          503,
        );
      const [ready] = await db
        .update(promptAttachments)
        .set({ status: 'ready', sha256: hash, finalizeToken: null, updatedAt: new Date() })
        .where(
          and(
            eq(promptAttachments.attachmentId, attachmentId),
            eq(promptAttachments.finalizeToken, token),
            eq(promptAttachments.status, 'finalizing'),
          ),
        )
        .returning();
      if (!ready)
        throw new PromptAttachmentError(
          'attachment_processing',
          'Attachment processing changed. Retry shortly.',
          409,
        );
      // Chunk names remain derivable even if removal fails; the expiry sweep
      // retries their deletion together with the final object.
      await storage()
        .remove(row.chunkDigests.map((_, i) => chunkPath(row, i)))
        .catch(() => {});
      return metadata(ready);
    } catch (error) {
      await db
        .update(promptAttachments)
        .set({ status: 'uploading', finalizeToken: null, updatedAt: new Date() })
        .where(
          and(
            eq(promptAttachments.attachmentId, attachmentId),
            eq(promptAttachments.finalizeToken, token),
            eq(promptAttachments.status, 'finalizing'),
          ),
        );
      throw error;
    }
  } finally {
    finalizations--;
  }
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

function noReferences() {
  return notExists(
    db
      .select({ id: promptAttachmentReferences.commandId })
      .from(promptAttachmentReferences)
      .where(eq(promptAttachmentReferences.attachmentId, promptAttachments.attachmentId)),
  );
}
async function removeObjects(row: Row, now = new Date()) {
  const paths = [
    filePath(row),
    ...Array.from({ length: Math.ceil(row.sizeBytes / PROMPT_ATTACHMENT_CHUNK_BYTES) }, (_, i) =>
      chunkPath(row, i),
    ),
  ];
  const { data, error } = await storage().remove(paths);
  if (error)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment removal failed. Retry shortly.',
      503,
    );
  // Missing objects are a successful deletion. Supabase returns only existing
  // keys, so an absent item in its response is not evidence of failure.
  void data;
  await db
    .delete(promptAttachments)
    .where(
      and(
        eq(promptAttachments.attachmentId, row.attachmentId),
        eq(promptAttachments.status, 'deleting'),
        lt(promptAttachments.expiresAt, now),
        noReferences(),
      ),
    );
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

export async function cleanupExpiredPromptAttachments(
  now = new Date(),
): Promise<{ deleted: number; errors: number }> {
  const rows = await db.transaction(async (tx) => {
    const rows = await tx
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
      .orderBy(asc(promptAttachments.attachmentId))
      .limit(CLEANUP_BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (!rows.length) return [];
    // READ COMMITTED gives this statement a fresh reference snapshot. The
    // candidate SELECT can predate a binder's commit even after tuple locking.
    return tx
      .update(promptAttachments)
      .set({ status: 'deleting' })
      .where(
        and(
          inArray(
            promptAttachments.attachmentId,
            rows.map((row) => row.attachmentId),
          ),
          noReferences(),
        ),
      )
      .returning();
  });
  let deleted = 0,
    errors = 0;
  for (const row of rows) {
    try {
      await removeObjects(row, now);
      deleted++;
    } catch {
      errors++;
    }
  }
  return { deleted, errors };
}

/** Internal only: the caller must name the persisted command and its scope.
 * Signed URLs never enter an inbox payload or a client response. */
export async function resolvePromptAttachment(input: {
  attachmentId: string;
  commandId: string;
  projectId: string;
  accountId: string;
  sessionId?: string;
}) {
  const [found] = await db
    .select({ attachment: promptAttachments })
    .from(promptAttachmentReferences)
    .innerJoin(
      promptAttachments,
      eq(promptAttachments.attachmentId, promptAttachmentReferences.attachmentId),
    )
    .innerJoin(
      sessionLifecycleCommands,
      eq(sessionLifecycleCommands.commandId, promptAttachmentReferences.commandId),
    )
    .where(
      and(
        eq(promptAttachmentReferences.attachmentId, input.attachmentId),
        eq(promptAttachmentReferences.commandId, input.commandId),
        eq(sessionLifecycleCommands.projectId, input.projectId),
        eq(sessionLifecycleCommands.accountId, input.accountId),
        eq(promptAttachments.projectId, input.projectId),
        eq(promptAttachments.accountId, input.accountId),
        input.sessionId ? eq(sessionLifecycleCommands.sessionId, input.sessionId) : undefined,
      ),
    )
    .limit(1);
  const row = found?.attachment;
  if (!row || row.status !== 'ready' || !row.sha256)
    throw new PromptAttachmentError(
      'attachment_not_found',
      'The command attachment is unavailable.',
      404,
    );
  const { data, error } = await storage().createSignedUrl(filePath(row), 5 * 60);
  if (error || !data?.signedUrl)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment storage is unavailable.',
      503,
    );
  return {
    attachmentId: row.attachmentId,
    filename: row.filename,
    mime: row.mime,
    size: row.sizeBytes,
    sha256: row.sha256,
    signedUrl: toPublicStorageUrl(data.signedUrl),
    async readBytes(): Promise<Uint8Array> {
      const bytes = await download(filePath(row));
      if (bytes.byteLength !== row.sizeBytes || digest(bytes) !== row.sha256)
        throw new PromptAttachmentError(
          'attachment_integrity_failed',
          'Attachment bytes failed verification.',
        );
      return bytes;
    },
  };
}
