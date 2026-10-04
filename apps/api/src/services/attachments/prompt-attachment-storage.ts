import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { promptAttachments, promptAttachmentReferences } from '@kortix/db';
import { eq, notExists } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../lib/db';
import { config } from '../../lib/config';

const BUCKET = 'staged-files';
export const STORAGE_TIMEOUT_MS = 20_000;
export const COMPLETE_BOUND_MS = 85_000;
/** A crashed chunked finalizer's row is reclaimable after this. It exceeds
 * COMPLETE_BOUND_MS, so a live finalizer is never overtaken. */
export const FINALIZE_LEASE_MS = 2 * 60_000;
let storageClient: SupabaseClient | undefined;
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Row = typeof promptAttachments.$inferSelect;
export interface PromptAttachmentScope {
  accountId: string;
  projectId: string;
  userId: string | null;
}
export type BindingRow = Pick<
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
    status: 400 | 404 | 409 | 413 | 429 | 503 = 400,
  ) {
    super(status, { message, res: Response.json({ error: message, code }, { status }) });
  }
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function storage(): ReturnType<SupabaseClient['storage']['from']> {
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
export function chunkedMode(): boolean {
  return config.PROMPT_ATTACHMENT_UPLOAD_MODE === 'chunked';
}
/** Read only in chunked mode. */
export function chunkBytes(): number {
  return config.PROMPT_ATTACHMENT_CHUNK_BYTES;
}
export function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}
export function storageUnavailable(message = 'Attachment storage is unavailable. Retry this file.') {
  return new PromptAttachmentError('attachment_storage_unavailable', message, 503);
}
export function filePath(row: Pick<Row, 'objectPath'>) {
  return `${row.objectPath}/file`;
}
export function chunkPath(row: Pick<Row, 'objectPath'>, index: number) {
  return `${row.objectPath}/chunks/${index}`;
}
export function metadata(row: Row) {
  return {
    attachment_id: row.attachmentId,
    filename: row.filename,
    mime: row.mime,
    size: row.sizeBytes,
    expires_at: row.expiresAt.toISOString(),
  };
}
export function assertOwner(
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
export function assertUnexpired(row: BindingRow, now: Date) {
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
export async function selectAttachment(attachmentId: string): Promise<Row | undefined> {
  const [row] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, attachmentId))
    .limit(1);
  return row;
}

export function noReferences() {
  return notExists(
    db
      .select({ id: promptAttachmentReferences.commandId })
      .from(promptAttachmentReferences)
      .where(eq(promptAttachmentReferences.attachmentId, promptAttachments.attachmentId)),
  );
}
export async function download(path: string): Promise<Uint8Array> {
  const { data, error } = await storage().download(
    path,
    {},
    { signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) },
  );
  if (error || !data) throw storageUnavailable();
  return new Uint8Array(await data.arrayBuffer());
}
