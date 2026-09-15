import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  promptAttachments,
  promptAttachmentReferences,
  sessionSandboxes,
  sessionLifecycleCommands,
} from '@kortix/db';
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS_BYTES,
  MAX_PROMPT_ATTACHMENT_FILES,
  PROMPT_ATTACHMENT_TTL_MS,
  sanitizePromptUploadFilename,
} from '@kortix/shared';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../shared/db';
import { toPublicStorageUrl } from '../shared/supabase';
import { config } from '../config';
import { buildPromptAttachmentReference } from './session-lifecycle/prompt-attachment-reference';
import type { PromptPartWire } from './session-lifecycle/store';

const BUCKET = 'staged-files';
const STORAGE_TIMEOUT_MS = 20_000;
/**
 * Upper bound on the Storage work of one `complete` request. Direct mode: the
 * verifying download. Chunked mode: assembly stops starting reads at 50 s; the
 * last read and the final object write take at most 20 s each, and chunk
 * removal runs after the answer. The whole request, database waits included,
 * has its own 105 s deadline (middleware/request-deadline.ts). The SDK request
 * timeout (120 s) is longer, so a live server always answers first.
 */
const COMPLETE_BOUND_MS = 90_000;
/** A crashed chunked finalizer's row is reclaimable after this. It exceeds
 * COMPLETE_BOUND_MS, so a live finalizer is never overtaken. */
const FINALIZE_LEASE_MS = 2 * 60_000;
/** Lifetime reported for a direct upload URL. Storage signs for 2 hours by
 * default; a shorter report makes the client re-sign before Storage refuses. */
const DIRECT_UPLOAD_URL_TTL_MS = 60 * 60_000;
const CLEANUP_BATCH_SIZE = 20;
/** Chunked assembly holds one whole file in memory; this bounds it per process. */
const MAX_CHUNKED_FINALIZATIONS = 2;
let chunkedFinalizations = 0;
let storageClient: SupabaseClient | undefined;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof promptAttachments.$inferSelect;
interface PromptAttachmentScope {
  accountId: string;
  projectId: string;
  userId: string | null;
}
type PromptAttachmentUploadTarget =
  | {
      kind: 'direct';
      url: string;
      method: 'PUT';
      headers: Record<string, string>;
      expires_at: string;
    }
  | { kind: 'chunked'; chunk_size: number };
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

/** Per-user budget for uploads not yet part of a sent prompt (D17). */
const PROMPT_ATTACHMENT_MAX_PENDING_HANDLES = 40;
const PROMPT_ATTACHMENT_MAX_UNBOUND_BYTES = 500 * 1024 * 1024;

class PromptAttachmentError extends HTTPException {
  constructor(
    readonly code: string,
    message: string,
    status: 400 | 404 | 409 | 413 | 429 | 503 = 400,
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
            // A caller deadline (the streaming verification) replaces the default.
            signal: init?.signal ?? AbortSignal.timeout(STORAGE_TIMEOUT_MS),
          }),
        { preconnect: fetch.preconnect },
      ),
    },
  });
  return storageClient.storage.from(BUCKET);
}
function chunkedMode(): boolean {
  return config.PROMPT_ATTACHMENT_UPLOAD_MODE === 'chunked';
}
/** Read only in chunked mode. */
function chunkBytes(): number {
  return config.PROMPT_ATTACHMENT_CHUNK_BYTES;
}
function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}
function storageUnavailable(message = 'Attachment storage is unavailable. Retry this file.') {
  return new PromptAttachmentError('attachment_storage_unavailable', message, 503);
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
async function selectAttachment(attachmentId: string): Promise<Row | undefined> {
  const [row] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, attachmentId))
    .limit(1);
  return row;
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
  const mime = input.mime.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 255)
    throw new PromptAttachmentError('attachment_mime_invalid', 'Attachment MIME type is invalid.');
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

/** The chunk route exists only for a deployment that selects chunked mode. */
export function assertChunkedPromptAttachmentUpload(): void {
  if (!chunkedMode())
    throw new PromptAttachmentError(
      'attachment_upload_mode',
      'This server uploads attachments directly to storage. Upload the file to its upload URL.',
      409,
    );
}

export async function readPromptAttachmentChunk(request: Request): Promise<Uint8Array> {
  const limit = chunkBytes();
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
      if (size > limit) {
        await reader.cancel();
        throw new PromptAttachmentError(
          'attachment_chunk_limit',
          `Attachment chunks must not exceed ${formatBytes(limit)}.`,
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

/** Chunked mode only. No statement holds a transaction or row lock across the
 * Storage write: renew expiry, write Storage, then record with one
 * compare-and-set UPDATE. */
export async function uploadPromptAttachmentChunk(
  scope: PromptAttachmentScope,
  attachmentId: string,
  index: number,
  bytes: Uint8Array,
) {
  const limit = chunkBytes();
  if (!Number.isSafeInteger(index) || index < 0 || !bytes.byteLength || bytes.byteLength > limit)
    throw new PromptAttachmentError('attachment_chunk_invalid', 'Invalid attachment chunk.', 400);
  const row = await selectAttachment(attachmentId);
  assertOwner(row, scope);
  assertUnexpired(row, new Date());
  const offset = index * limit;
  const end = offset + bytes.byteLength;
  // A replayed, acknowledged chunk returns the current acknowledgment. The first
  // stored bytes stay authoritative; completion hashes what Storage holds.
  if (end <= row.receivedBytes) return { received_bytes: row.receivedBytes, size: row.sizeBytes };
  const conflict = () =>
    new PromptAttachmentError(
      'attachment_chunk_conflict',
      'Attachment chunk is out of order.',
      409,
    );
  if (row.status !== 'uploading' || offset !== row.receivedBytes) throw conflict();
  if (bytes.byteLength !== Math.min(limit, row.sizeBytes - offset))
    throw new PromptAttachmentError(
      'attachment_chunk_size',
      'Attachment chunk does not match the expected size.',
    );
  const uploading = and(
    eq(promptAttachments.attachmentId, attachmentId),
    eq(promptAttachments.status, 'uploading'),
  );
  // Renew first, so cleanup leaves a full TTL for an ambiguous write to settle.
  await db
    .update(promptAttachments)
    .set({ expiresAt: new Date(Date.now() + PROMPT_ATTACHMENT_TTL_MS), updatedAt: new Date() })
    .where(uploading);
  // The row already names every chunk path, so a repeated upsert cannot orphan an object.
  const { error } = await storage().upload(chunkPath(row, index), bytes, {
    upsert: true,
    contentType: 'application/octet-stream',
  });
  if (error) throw storageUnavailable('Attachment upload failed. Retry this file.');
  const [recorded] = await db
    .update(promptAttachments)
    .set({ receivedBytes: end, updatedAt: new Date() })
    .where(and(uploading, eq(promptAttachments.receivedBytes, offset)))
    .returning({ receivedBytes: promptAttachments.receivedBytes });
  if (recorded) return { received_bytes: recorded.receivedBytes, size: row.sizeBytes };
  // A concurrent retry of this chunk recorded it first.
  const current = await selectAttachment(attachmentId);
  if (current && current.receivedBytes >= end)
    return { received_bytes: current.receivedBytes, size: current.sizeBytes };
  throw conflict();
}

async function download(path: string): Promise<Uint8Array> {
  const { data, error } = await storage().download(
    path,
    {},
    { signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) },
  );
  if (error || !data) throw storageUnavailable();
  return new Uint8Array(await data.arrayBuffer());
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

function processingError() {
  return new PromptAttachmentError(
    'attachment_processing',
    'Attachment is being processed. Retry shortly.',
    409,
  );
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

/** Chunked mode (preview only): assemble the chunks into one object. */
async function completeChunkedPromptAttachment(
  scope: PromptAttachmentScope,
  attachmentId: string,
) {
  if (chunkedFinalizations >= MAX_CHUNKED_FINALIZATIONS)
    throw new PromptAttachmentError(
      'attachment_upload_busy',
      'Attachment processing is busy. Retry shortly.',
      503,
    );
  chunkedFinalizations++;
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
        throw processingError();
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
      const limit = chunkBytes();
      const count = Math.ceil(row.sizeBytes / limit);
      const bytes = new Uint8Array(row.sizeBytes);
      let next = 0;
      // Reads stop starting early enough that the last read and the final write
      // still finish inside COMPLETE_BOUND_MS.
      const assemblyDeadline = Date.now() + COMPLETE_BOUND_MS - 2 * STORAGE_TIMEOUT_MS;
      const timedOut = () => storageUnavailable('Attachment processing timed out. Retry this file.');
      const reads = await Promise.allSettled(
        Array.from({ length: Math.min(16, count) }, async () => {
          while (next < count) {
            if (Date.now() > assemblyDeadline) throw timedOut();
            const index = next++;
            const chunk = await download(chunkPath(row, index));
            if (chunk.byteLength !== Math.min(limit, row.sizeBytes - index * limit))
              throw new PromptAttachmentError(
                'attachment_integrity_failed',
                'Attachment bytes failed verification. Attach the file again.',
              );
            bytes.set(chunk, index * limit);
          }
        }),
      );
      const failedRead = reads.find((result) => result.status === 'rejected');
      if (failedRead?.status === 'rejected') throw failedRead.reason;
      if (Date.now() > assemblyDeadline) throw timedOut();
      const hash = digest(bytes);
      const { error } = await storage().upload(filePath(row), bytes, {
        upsert: true,
        contentType: row.mime,
      });
      if (error) throw storageUnavailable('Attachment processing failed. Retry this file.');
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
      // Cleanup, not completion: the file is ready, so the answer does not wait
      // for it and the COMPLETE_BOUND_MS budget above holds. Chunk names remain
      // derivable, so the expiry sweep retries a failed removal with the file.
      void storage()
        .remove(Array.from({ length: count }, (_, i) => chunkPath(row, i)))
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
    chunkedFinalizations--;
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
  // Direct mode stores one object. Chunked mode also stores derivable chunk objects.
  const chunkCount = chunkedMode() ? Math.ceil(row.sizeBytes / chunkBytes()) : 0;
  const paths = [
    filePath(row),
    ...Array.from({ length: chunkCount }, (_, i) => chunkPath(row, i)),
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

/** A delivered prompt keeps its files this long after its command closed. A
 * redelivery can re-queue a closed prompt whose turn never ran; the grace keeps
 * its files for that window. Forwarded prompts are not closed, so they wait. */
const PROMPT_ATTACHMENT_RELEASE_GRACE_MS = 60 * 60_000;
const RELEASE_BATCH_SIZE = 200;

/** Drop the references of the selected commands. An attachment left with no
 * reference expires now, so the cleanup sweep removes its object, then its
 * metadata (KEEP 4). Two statements: a crash between them leaves the attachment
 * to its own TTL. */
async function releaseCommandReferences(
  commands: SQLWrapper,
  expireAt: Date,
): Promise<number> {
  const released = await db
    .delete(promptAttachmentReferences)
    .where(inArray(promptAttachmentReferences.commandId, commands))
    .returning({ attachmentId: promptAttachmentReferences.attachmentId });
  const ids = [...new Set(released.map((reference) => reference.attachmentId))];
  if (ids.length > 0)
    await db
      .update(promptAttachments)
      .set({ expiresAt: expireAt })
      .where(
        and(
          inArray(promptAttachments.attachmentId, ids),
          gt(promptAttachments.expiresAt, expireAt),
          noReferences(),
        ),
      );
  return released.length;
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

export async function cleanupExpiredPromptAttachments(
  now = new Date(),
): Promise<{ deleted: number; errors: number }> {
  let releaseErrors = 0;
  // Delivered prompts release first, so their files expire in this same sweep.
  await releaseDeliveredPromptAttachments(now).catch((error) => {
    releaseErrors = 1;
    console.warn(
      '[prompt-attachments] reference release failed:',
      error instanceof Error ? error.message : error,
    );
  });
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
      // Walks idx_prompt_attachments_expiry from the oldest expired row. Released
      // references leave only unsent, in-flight and dead-lettered rows behind.
      .orderBy(asc(promptAttachments.expiresAt))
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
    errors = releaseErrors;
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

interface PromptAttachmentHandle {
  attachmentId: string;
  partIndex: number;
}

interface ResolvedCommandAttachment {
  attachmentId: string;
  objectPath: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  targetPath: string;
  readBytes(): Promise<Uint8Array>;
}

const commandAttachmentUnavailable = () =>
  new PromptAttachmentError('attachment_not_found', 'The command attachment is unavailable.', 404);

/** Internal only: the caller must name the persisted command and its scope.
 * Resolves every handle of one running command with one query and signs
 * nothing. A handle that is not this command's verified part is absent from the
 * result. */
export async function resolvePromptAttachments(input: {
  commandId: string;
  projectId: string;
  accountId: string;
  sessionId: string;
  handles: PromptAttachmentHandle[];
}): Promise<Map<number, ResolvedCommandAttachment>> {
  const resolved = new Map<number, ResolvedCommandAttachment>();
  const ids = [...new Set(input.handles.map((handle) => handle.attachmentId))];
  if (!ids.length) return resolved;
  const found = await db
    .select({
      attachment: promptAttachments,
      commandStatus: sessionLifecycleCommands.status,
      commandPayload: sessionLifecycleCommands.payload,
    })
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
        inArray(promptAttachmentReferences.attachmentId, ids),
        eq(promptAttachmentReferences.commandId, input.commandId),
        eq(sessionLifecycleCommands.projectId, input.projectId),
        eq(sessionLifecycleCommands.accountId, input.accountId),
        eq(promptAttachments.projectId, input.projectId),
        eq(promptAttachments.accountId, input.accountId),
        eq(sessionLifecycleCommands.sessionId, input.sessionId),
      ),
    );
  if (!found.length) return resolved;
  // Every row joins the same command.
  if (found[0]!.commandStatus !== 'running')
    throw new PromptAttachmentError(
      'attachment_command_not_running',
      'The command attachment is not active.',
      409,
    );
  const parts = Array.isArray(found[0]!.commandPayload.parts)
    ? (found[0]!.commandPayload.parts as PromptPartWire[])
    : [];
  const rows = new Map(found.map(({ attachment }) => [attachment.attachmentId, attachment]));
  for (const { attachmentId, partIndex } of input.handles) {
    const row = rows.get(attachmentId);
    const part = parts[partIndex];
    const matchingParts = parts.filter(
      (candidate) => candidate?.type === 'file' && candidate.attachment_id === attachmentId,
    );
    if (
      !row ||
      !Number.isSafeInteger(partIndex) ||
      partIndex < 0 ||
      part?.type !== 'file' ||
      part.attachment_id !== attachmentId ||
      matchingParts.length !== 1 ||
      row.status !== 'ready' ||
      !row.sha256 ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      row.sizeBytes <= 0 ||
      row.sizeBytes > MAX_PROMPT_ATTACHMENT_BYTES
    )
      continue;
    const sha256 = row.sha256;
    const reference = buildPromptAttachmentReference({
      part: { type: 'file', filename: row.filename, mime: row.mime },
      index: partIndex,
      materializationKey: input.commandId,
    });
    resolved.set(partIndex, {
      attachmentId: row.attachmentId,
      objectPath: row.objectPath,
      filename: row.filename,
      mime: row.mime,
      size: row.sizeBytes,
      sha256,
      targetPath: reference.targetPath,
      async readBytes(): Promise<Uint8Array> {
        const bytes = await download(filePath(row));
        if (bytes.byteLength !== row.sizeBytes || digest(bytes) !== sha256)
          throw new PromptAttachmentError(
            'attachment_integrity_failed',
            'Attachment bytes failed verification.',
          );
        return bytes;
      },
    });
  }
  return resolved;
}

/** One handle of one running command. */
export async function resolvePromptAttachment(
  input: PromptAttachmentHandle & {
    commandId: string;
    projectId: string;
    accountId: string;
    sessionId: string;
  },
): Promise<ResolvedCommandAttachment> {
  const { attachmentId, partIndex, ...command } = input;
  const resolved = (
    await resolvePromptAttachments({ ...command, handles: [{ attachmentId, partIndex }] })
  ).get(partIndex);
  if (!resolved) throw commandAttachmentUnavailable();
  return resolved;
}

/** Resolve the descriptor available to one live session sandbox credential. */
export async function resolveRuntimePromptAttachmentDescriptor(input: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  commandId: string;
  attachmentId: string;
  partIndex: number;
}) {
  const [sandbox] = await db
    .select({ sessionId: sessionSandboxes.sessionId })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sandboxId, input.sandboxId),
        eq(sessionSandboxes.accountId, input.accountId),
        eq(sessionSandboxes.projectId, input.projectId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  if (!sandbox)
    throw new PromptAttachmentError(
      'attachment_not_found',
      'The command attachment is unavailable.',
      404,
    );
  const resolved = await resolvePromptAttachment({
    attachmentId: input.attachmentId,
    commandId: input.commandId,
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: sandbox.sessionId,
    partIndex: input.partIndex,
  });
  // The only signed download URL: the daemon fetches it directly.
  const { data, error } = await storage().createSignedUrl(filePath(resolved), 5 * 60);
  if (error || !data?.signedUrl)
    throw new PromptAttachmentError(
      'attachment_storage_unavailable',
      'Attachment storage is unavailable.',
      503,
    );
  return {
    version: 1 as const,
    command_id: input.commandId,
    attachment_id: resolved.attachmentId,
    part_index: input.partIndex,
    filename: resolved.filename,
    mime: resolved.mime,
    size_bytes: resolved.size,
    sha256: resolved.sha256,
    target_path: resolved.targetPath,
    download_url: toPublicStorageUrl(data.signedUrl),
    download_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}
