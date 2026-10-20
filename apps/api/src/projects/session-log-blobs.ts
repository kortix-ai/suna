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
 * answers 409 or 422, or a capture batch that ends `skipped` (a journal wrote, or
 * a newer mirror capture ran), leaves objects no message names. They stay indexed
 * and go with the session's folder when the retention purge removes it
 * (`session-log-purge.ts`: 7 days after the rows; an orphan in a live session's folder stays until
 * then). They are not deleted on a skip:
 * the object is shared by sha256, so a row of the same session may name it.
 *
 * `GET .../log` serves rows as stored. The v1 reads serve whole bodies, so they
 * call `rehydrateLargeTexts`. A text over 256 kB is offloaded even when the
 * daemon sent a `ref` with it (the API's `ref` replaces it). A smaller text
 * keeps the `ref` the daemon sent, and `rehydrateLargeTexts` follows only a
 * reference to the session's own folder.
 *
 * Attachment bytes (P2.13). The journal writes an image or file as `ref: blob:<sha256>`.
 * Before it posts the record, it asks `GET .../log/blobs/<sha256>` for the object and,
 * when there is none, uploads the bytes with `PUT .../log/blobs/<sha256>`
 * (`storeSessionLogBlob`: the body's sha256 must equal the path's, at most 50 MiB). Both
 * answer the object's `kortix-attachment://` ref, and the journal puts that ref in the
 * record. So a record names only an object that exists. `attachment_id` is
 * `stableSessionAttachmentId('session-log-blob:<sha256>')`, in the same folder and index
 * as the texts: one object per sha256 per session, whichever wrote it first.
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
type Block = { type?: string; id?: string; result?: { content?: unknown[]; model_content?: unknown[] } };

const blocksOf = (record: unknown) => ((record as { blocks?: unknown }).blocks ?? []) as Block[];
/** The F3 texts of one block: the text block itself, or a tool result's text items. */
const blockTexts = (b: Block): Text[] =>
  (b.type === 'text' ? [b] : b.type === 'tool_call' ? [...(b.result?.content ?? []), ...(b.result?.model_content ?? [])] : []).filter(
    (t): t is Text => (t as Text)?.type === 'text' && typeof (t as Text).text === 'string',
  );
/** The F3 texts of a record: its text blocks and its tool results' text items. */
const textsOf = (record: unknown): Text[] => blocksOf(record).flatMap(blockTexts);

/** Every text of a record that carries a `ref`, with the id of its block (the text block, or the tool call). */
export const referencedTexts = (record: unknown): Array<{ block_id: string; ref: string }> =>
  blocksOf(record).flatMap((b) => blockTexts(b).flatMap((t) => (t.ref === undefined ? [] : [{ block_id: String(b.id), ref: t.ref }])));

/** The first 16 kB, cut at a character boundary. */
function preview(bytes: Buffer): string {
  let end = SESSION_LOG_PREVIEW_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

const large = (t: Text) => Buffer.byteLength(t.text) > SESSION_LOG_OFFLOAD_BYTES;

/** How many texts of `record` `offloadLargeTexts` would move to an object. */
export const largeTextCount = (record: unknown): number => textsOf(record).filter(large).length;

/** The record to store for `message`: each text over 256 kB becomes preview + `ref` + `bytes`. */
export async function offloadLargeTexts<T>(scope: Scope, message: T): Promise<T> {
  if (!textsOf(message).some(large)) return message;
  const record = structuredClone(message);
  for (const t of textsOf(record).filter(large)) {
    const bytes = Buffer.from(t.text);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref = await storeOnce({ ...scope, attachmentId: stableSessionAttachmentId(`session-log-text:${sha256}`) }, sha256, bytes, MIME);
    Object.assign(t, { text: preview(bytes), ref, bytes: bytes.byteLength });
  }
  return record;
}

/** The ref of this session's object with these bytes, or null when the session has none. */
export async function findSessionLogBlob(scope: Scope, sha256: string): Promise<string | null> {
  const [known] = await db
    .select({ objectKey: sessionLogBlobs.objectKey })
    .from(sessionLogBlobs)
    .where(and(eq(sessionLogBlobs.sessionId, scope.sessionId), eq(sessionLogBlobs.sha256, sha256), isNull(sessionLogBlobs.deletedAt)))
    .limit(1);
  return known ? `kortix-attachment://${known.objectKey}` : null;
}

/** Stores the bytes of an attachment the journal names `blob:<sha256>` (the caller checked the digest); answers its ref. */
export function storeSessionLogBlob(scope: Scope, sha256: string, mime: string, bytes: Buffer): Promise<string> {
  return storeOnce({ ...scope, attachmentId: stableSessionAttachmentId(`session-log-blob:${sha256}`) }, sha256, bytes, mime);
}

/** The object's ref. A row in the index means the object exists, so a known sha256 uploads nothing. */
async function storeOnce(object: Scope & { attachmentId: string }, sha256: string, bytes: Buffer, mime: string): Promise<string> {
  const known = await findSessionLogBlob(object, sha256);
  if (known) return known;
  // An object a failed earlier attempt left holds the same bytes: `put` accepts it.
  await sessionAttachmentStore().put({ ...object, filename: sha256, mime, bytes });
  await db
    .insert(sessionLogBlobs)
    .values({ sessionId: object.sessionId, sha256, objectKey: `${object.projectId}/${object.sessionId}/${object.attachmentId}`, bytes: bytes.byteLength, mime })
    // A racing put of the same bytes under the other id keeps its row: a text's ref must stay indexed (restore `blobs`).
    .onConflictDoUpdate({ target: [sessionLogBlobs.sessionId, sessionLogBlobs.sha256], set: { deletedAt: null } });
  return sessionAttachmentRef(object);
}

/** The records with each F3 text of this session whole again. An object Storage does not return keeps its preview. */
export async function rehydrateLargeTexts<T>(scope: Scope, records: T[]): Promise<T[]> {
  return Promise.all(
    records.map(async (record) => {
      if (!textsOf(record).some((t) => t.ref !== undefined)) return record;
      const copy = structuredClone(record);
      for (const t of textsOf(copy)) {
        const object = parseSessionAttachmentRef(t.ref);
        if (!object || object.projectId !== scope.projectId || object.sessionId !== scope.sessionId) continue;
        // A Storage failure degrades this text to its preview; it never fails the whole v1 window.
        const blob = await sessionAttachmentStore().read(object).catch((error: unknown) => {
          logger.warn('[session-log] large text object unreadable; serving its preview', { sessionId: scope.sessionId, ref: t.ref, error: String(error) });
          return undefined;
        });
        if (blob === null) logger.warn('[session-log] large text object missing; serving its preview', { sessionId: scope.sessionId, ref: t.ref });
        if (!blob) continue;
        t.text = await blob.text();
        delete t.ref;
        delete t.bytes;
      }
      return copy;
    }),
  );
}
