/**
 * F3 large texts of the session log (P2.3). A text block, or a tool result's
 * text item, over 256 kB (UTF-8) leaves the row at ingest:
 * - the row keeps the first 16 kB in `text` (never a cut UTF-8 sequence), plus
 *   `ref` and `bytes` (the full text's UTF-8 length);
 * - the full text is one object in the private `session-attachments` bucket,
 *   `<project_id>/<session_id>/<attachment_id>`, the key of every session file.
 *   `attachment_id` is `stableSessionAttachmentId('session-log-text:<sha256>')`,
 *   so `ref` is an ordinary `kortix-attachment://` reference: the attachments
 *   route, `fetchSessionAttachment` and session deletion and account erasure
 *   (both delete the session's prefix) handle it as they handle an upload;
 * - `session_log_blobs` indexes the object by (session_id, sha256). A row means
 *   the object exists: a later put of the same text uploads nothing.
 *
 * The objects are written before the batch's transaction, so a batch that then
 * answers 409 or 422 leaves objects no message names. They stay indexed and go
 * with the session (retention is P2.8).
 *
 * `GET .../log` serves rows as stored. The v1 reads serve whole bodies, so they
 * call `rehydrateLargeTexts`. A `ref` the daemon sent is stored as sent, and
 * `rehydrateLargeTexts` follows only a reference to the session's own folder.
 */
import { createHash } from 'node:crypto';
import { parseSessionAttachmentRef, sessionAttachmentRef } from '@kortix/shared';
import { sessionLogBlobs } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { stableSessionAttachmentId } from './lib/session-attachment-identity';
import { sessionAttachmentStore } from './lib/session-attachments';

export const SESSION_LOG_OFFLOAD_BYTES = 256 * 1024;
export const SESSION_LOG_PREVIEW_BYTES = 16 * 1024;
const MIME = 'text/plain; charset=utf-8';

type Scope = { projectId: string; sessionId: string };
type Text = { type: 'text'; text: string; ref?: string; bytes?: number };
type Block = { type?: string; result?: { content?: unknown[]; model_content?: unknown[] } };

/** The F3 texts of a record: its text blocks and its tool results' text items. */
function textsOf(record: unknown): Text[] {
  const blocks = ((record as { blocks?: unknown }).blocks ?? []) as Block[];
  return blocks.flatMap((b) =>
    (b.type === 'text' ? [b] : b.type === 'tool_call' ? [...(b.result?.content ?? []), ...(b.result?.model_content ?? [])] : []).filter(
      (t): t is Text => (t as Text)?.type === 'text' && typeof (t as Text).text === 'string',
    ),
  );
}

/** The first 16 kB, cut at a character boundary. */
function preview(bytes: Buffer): string {
  let end = SESSION_LOG_PREVIEW_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/** The record to store for `message`: each text over 256 kB becomes preview + `ref` + `bytes`. */
export async function offloadLargeTexts<T>(scope: Scope, message: T): Promise<T> {
  const large = (t: Text) => t.ref === undefined && Buffer.byteLength(t.text) > SESSION_LOG_OFFLOAD_BYTES;
  if (!textsOf(message).some(large)) return message;
  const record = structuredClone(message);
  for (const t of textsOf(record).filter(large)) {
    const bytes = Buffer.from(t.text);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const object = { ...scope, attachmentId: stableSessionAttachmentId(`session-log-text:${sha256}`) };
    await storeOnce(object, sha256, bytes);
    Object.assign(t, { text: preview(bytes), ref: sessionAttachmentRef(object), bytes: bytes.byteLength });
  }
  return record;
}

async function storeOnce(object: Scope & { attachmentId: string }, sha256: string, bytes: Buffer): Promise<void> {
  const [known] = await db
    .select({ sha256: sessionLogBlobs.sha256 })
    .from(sessionLogBlobs)
    .where(and(eq(sessionLogBlobs.sessionId, object.sessionId), eq(sessionLogBlobs.sha256, sha256), isNull(sessionLogBlobs.deletedAt)))
    .limit(1);
  if (known) return;
  // An object a failed earlier attempt left is the same text: `put` accepts it.
  await sessionAttachmentStore().put({ ...object, filename: `${sha256}.txt`, mime: MIME, bytes });
  await db
    .insert(sessionLogBlobs)
    .values({ sessionId: object.sessionId, sha256, objectKey: `${object.projectId}/${object.sessionId}/${object.attachmentId}`, bytes: bytes.byteLength, mime: MIME })
    .onConflictDoUpdate({ target: [sessionLogBlobs.sessionId, sessionLogBlobs.sha256], set: { deletedAt: null } });
}

/** The records with each F3 text of this session whole again. A missing object keeps its preview. */
export async function rehydrateLargeTexts<T>(scope: Scope, records: T[]): Promise<T[]> {
  return Promise.all(
    records.map(async (record) => {
      if (!textsOf(record).some((t) => t.ref !== undefined)) return record;
      const copy = structuredClone(record);
      for (const t of textsOf(copy)) {
        const object = parseSessionAttachmentRef(t.ref);
        if (!object || object.projectId !== scope.projectId || object.sessionId !== scope.sessionId) continue;
        const blob = await sessionAttachmentStore().read(object);
        if (!blob) {
          logger.warn('[session-log] large text object missing; serving its preview', { sessionId: scope.sessionId, ref: t.ref });
          continue;
        }
        t.text = await blob.text();
        delete t.ref;
        delete t.bytes;
      }
      return copy;
    }),
  );
}
