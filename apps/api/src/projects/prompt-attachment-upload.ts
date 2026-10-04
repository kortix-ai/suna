import { createHash } from 'node:crypto';
import { promptAttachments, promptAttachmentReferences, sessionLifecycleCommands } from '@kortix/db';
import { MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS_BYTES, MAX_PROMPT_ATTACHMENT_FILES, PROMPT_ATTACHMENT_TTL_MS, isModelNativeAttachmentMime, sanitizePromptUploadFilename } from '@kortix/shared';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../lib/db';
import { toPublicStorageUrl } from '../lib/supabase';
import type { PromptPartWire } from './session-lifecycle/store';
import { completeChunkedPromptAttachment, processingError } from './prompt-attachment-chunks';
import { PromptAttachmentError, type BindingRow, type Transaction, type PromptAttachmentScope, type Row, storage, storageUnavailable, chunkedMode, chunkBytes, filePath, metadata, assertOwner, assertUnexpired, selectAttachment, noReferences, COMPLETE_BOUND_MS } from './prompt-attachment-storage';

/** Lifetime reported for a direct upload URL. Storage signs for 2 hours by
 * default; a shorter report makes the client re-sign before Storage refuses. */
const DIRECT_UPLOAD_URL_TTL_MS = 60 * 60_000;
type PromptAttachmentUploadTarget =
  | {
      kind: 'direct';
      url: string;
      method: 'PUT';
      headers: Record<string, string>;
      expires_at: string;
    }
  | { kind: 'chunked'; chunk_size: number };
/** Per-user budget for uploads not yet part of a sent prompt (D17). */
const PROMPT_ATTACHMENT_MAX_PENDING_HANDLES = 40;
const PROMPT_ATTACHMENT_MAX_UNBOUND_BYTES = 500 * 1024 * 1024;
/** The upload target for one attachment. The direct URL carries a write token:
 * never log it. */
async function uploadTarget(
  row: Pick<Row, 'objectPath' | 'mime'>,
): Promise<PromptAttachmentUploadTarget> {
  if (chunkedMode()) return { kind: 'chunked', chunk_size: chunkBytes() };
  const { data, error } = await storage().createSignedUploadUrl(filePath(row), { upsert: false });
  if (error || !data?.signedUrl) throw storageUnavailable();
  return {
    kind: 'direct',
    url: toPublicStorageUrl(data.signedUrl),
    method: 'PUT',
    // Mirrors @supabase/storage-js `uploadToSignedUrl` for a raw body. The URL
    // token authorizes the write, so the client sends no Authorization header.
    headers: { 'content-type': row.mime, 'cache-control': 'max-age=3600', 'x-upsert': 'false' },
    expires_at: new Date(Date.now() + DIRECT_UPLOAD_URL_TTL_MS).toISOString(),
  };
}

/** Begin an upload, or with `attachment_id` return a fresh target for the same
 * unfinished upload. A re-sign never creates a second row. */
export async function beginPromptAttachment(
  scope: PromptAttachmentScope,
  input: { attachment_id?: string; filename: string; mime: string; size: number },
) {
  if (!scope.userId)
    throw new PromptAttachmentError(
      'attachment_owner_required',
      'Attachment upload requires a user.',
    );
  if (input.attachment_id) {
    const row = await selectAttachment(input.attachment_id);
    assertOwner(row, scope);
    assertUnexpired(row, new Date());
    if (row.status !== 'uploading')
      throw new PromptAttachmentError(
        'attachment_not_uploading',
        'Attachment upload cannot restart. Attach the file again.',
        409,
      );
    return { ...metadata(row), upload: await uploadTarget(row) };
  }
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
  const declaredMime = input.mime.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(declaredMime) || declaredMime.length > 255)
    throw new PromptAttachmentError('attachment_mime_invalid', 'Attachment MIME type is invalid.');
  const mime = isModelNativeAttachmentMime(declaredMime) ? declaredMime : 'application/octet-stream';
  // The prompt path's billing decision, without its admission hold: an upload
  // spends no compute, and the hold is reconciled only by an LLM request.
  const { checkBillingAdmission } = await import('../billing/services/billing-gate');
  const billing = await checkBillingAdmission(scope.accountId);
  if (!billing.ok) {
    const body = {
      error: billing.message,
      message: billing.message,
      code: billing.reason,
      balance: billing.balance,
      billing_model: billing.billingModel,
      has_subscription: billing.hasSubscription,
      billing_state: billing.billingState,
      account_id: scope.accountId,
    };
    throw new HTTPException(402, {
      message: billing.message,
      res: Response.json(body, { status: 402 }),
    });
  }
  const userId = scope.userId;
  const attachmentId = crypto.randomUUID();
  const objectPath = `prompt-attachments/${scope.projectId}/${attachmentId}`;
  // Sign before the insert: a failed signature leaves no row behind. Signing is
  // a Storage call, so it stays outside the transaction.
  const upload = await uploadTarget({ objectPath, mime });
  const row = await db.transaction(async (tx) => {
    // One begin at a time per user, so parallel begins cannot overshoot the budget.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`prompt-attachments:${userId}`}, 0))`,
    );
    const now = new Date();
    const [usage] = await tx
      .select({
        pendingHandles: sql<number>`count(*) filter (where ${promptAttachments.status} in ('uploading', 'finalizing'))`.mapWith(
          Number,
        ),
        unboundBytes: sql<number>`coalesce(sum(${promptAttachments.sizeBytes}) filter (where ${noReferences()}), 0)`.mapWith(
          Number,
        ),
      })
      .from(promptAttachments)
      .where(
        and(
          eq(promptAttachments.userId, userId),
          inArray(promptAttachments.status, ['uploading', 'finalizing', 'ready']),
          gt(promptAttachments.expiresAt, now),
        ),
      );
    if ((usage?.pendingHandles ?? 0) + 1 > PROMPT_ATTACHMENT_MAX_PENDING_HANDLES)
      throw new PromptAttachmentError(
        'attachment_budget_exceeded',
        `You already have ${PROMPT_ATTACHMENT_MAX_PENDING_HANDLES} unfinished attachment uploads. Unfinished uploads expire within 24 hours.`,
        429,
      );
    if ((usage?.unboundBytes ?? 0) + input.size > PROMPT_ATTACHMENT_MAX_UNBOUND_BYTES)
      throw new PromptAttachmentError(
        'attachment_budget_exceeded',
        'Unsent attachments are limited to 500 MiB. Unused uploads expire within 24 hours.',
        429,
      );
    const [inserted] = await tx
      .insert(promptAttachments)
      .values({
        ...scope,
        userId,
        attachmentId,
        objectPath,
        filename: sanitizePromptUploadFilename(input.filename),
        mime,
        sizeBytes: input.size,
        expiresAt: new Date(now.getTime() + PROMPT_ATTACHMENT_TTL_MS),
      })
      .returning();
    return inserted!;
  });
  return { ...metadata(row), upload };
}


function isMissingObject(error: unknown): boolean {
  const { status, statusCode } = (error ?? {}) as { status?: number; statusCode?: string };
  return status === 404 || statusCode === '404' || statusCode === 'not_found';
}

/** Stream the stored object once: exact size and incremental SHA-256, without
 * holding the file in memory. */
async function verifyStoredObject(
  row: Row,
): Promise<{ state: 'missing' } | { state: 'mismatch' } | { state: 'verified'; sha256: string }> {
  const { data, error } = await storage()
    .download(filePath(row), {}, { signal: AbortSignal.timeout(COMPLETE_BOUND_MS) })
    .asStream();
  if (error || !data) {
    if (isMissingObject(error)) return { state: 'missing' };
    throw storageUnavailable();
  }
  const hash = createHash('sha256');
  const reader = data.getReader();
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > row.sizeBytes) {
        await reader.cancel().catch(() => {});
        return { state: 'mismatch' };
      }
      hash.update(next.value);
    }
  } catch {
    throw storageUnavailable();
  } finally {
    reader.releaseLock();
  }
  return size === row.sizeBytes ? { state: 'verified', sha256: hash.digest('hex') } : { state: 'mismatch' };
}

export async function completePromptAttachment(scope: PromptAttachmentScope, attachmentId: string) {
  return chunkedMode()
    ? completeChunkedPromptAttachment(scope, attachmentId)
    : completeDirectPromptAttachment(scope, attachmentId);
}


/** Direct mode: verify the object the client PUT. No Storage write, no transaction. */
async function completeDirectPromptAttachment(scope: PromptAttachmentScope, attachmentId: string) {
  const row = await selectAttachment(attachmentId);
  assertOwner(row, scope);
  assertUnexpired(row, new Date());
  if (row.status === 'ready') return metadata(row);
  if (row.status === 'failed')
    throw new PromptAttachmentError(
      'attachment_failed',
      'Attachment upload failed verification. Attach the file again.',
      409,
    );
  if (row.status !== 'uploading') throw processingError();
  const verified = await verifyStoredObject(row);
  if (verified.state === 'missing')
    throw new PromptAttachmentError(
      'attachment_not_uploaded',
      'Attachment bytes have not arrived. Upload the file, then complete it.',
      409,
    );
  const uploading = and(
    eq(promptAttachments.attachmentId, attachmentId),
    eq(promptAttachments.status, 'uploading'),
  );
  if (verified.state === 'mismatch') {
    // A failed removal is repeated by the expiry sweep, which removes the same path.
    await storage()
      .remove([filePath(row)])
      .catch(() => undefined);
    await db
      .update(promptAttachments)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(uploading);
    throw new PromptAttachmentError(
      'attachment_size_mismatch',
      'Attachment bytes do not match the declared size. Attach the file again.',
      400,
    );
  }
  const [ready] = await db
    .update(promptAttachments)
    .set({
      status: 'ready',
      sha256: verified.sha256,
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS),
    })
    .where(uploading)
    .returning();
  if (ready) return metadata(ready);
  // A concurrent completion or removal changed the row first.
  const current = await selectAttachment(attachmentId);
  assertOwner(current, scope);
  assertUnexpired(current, new Date());
  if (current.status === 'ready') return metadata(current);
  throw processingError();
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
