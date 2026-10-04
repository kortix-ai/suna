import { promptAttachments } from '@kortix/db';
import { PROMPT_ATTACHMENT_TTL_MS } from '@kortix/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { PromptAttachmentError, type PromptAttachmentScope, storage, storageUnavailable, chunkedMode, chunkBytes, formatBytes, filePath, chunkPath, metadata, assertOwner, assertUnexpired, selectAttachment, digest, download, STORAGE_TIMEOUT_MS, COMPLETE_BOUND_MS, FINALIZE_LEASE_MS } from './prompt-attachment-storage';

/** Chunked assembly holds one whole file in memory; this bounds it per process. */
const MAX_CHUNKED_FINALIZATIONS = 2;
let chunkedFinalizations = 0;

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

export function processingError() {
  return new PromptAttachmentError(
    'attachment_processing',
    'Attachment is being processed. Retry shortly.',
    409,
  );
}

/** Chunked mode (preview only): assemble the chunks into one object. */
export async function completeChunkedPromptAttachment(
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
