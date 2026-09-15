import {
  MAX_PROMPT_UPLOAD_FILENAME_BYTES,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from '@kortix/shared';
import type { SessionPromptPart } from '@kortix/sdk';
import { attachmentMime } from '@/features/session/attachment-mime';
import type { SentAttachment } from '@/features/session/sent-attachment-previews';
import type { AttachedFile } from '@/features/session/session-chat-input';

export type PromptFilePart = SessionPromptPart & { type: 'file' };

export type UploadedFileRef = {
  /** Where the runtime holds the bytes. Empty ONLY on an optimistic ref, which
   *  is rendered before the runtime has the file. */
  path: string;
  mime: string;
  filename: string;
  /**
   * Set only on an optimistic handle-backed ref: the attachment identity (see
   * `sent-attachment-previews.ts`). It keys the sent tile and finds its picture.
   * A ref never predicts a path: the daemon suffixes on collision, and three
   * pasted `image.png` files would share one predicted path.
   */
  attachment?: string;
};

/**
 * The largest upload filename we will hand the daemon, in BYTES.
 *
 * `NAME_MAX` is 255 bytes on every filesystem a sandbox runs on — bytes, not
 * characters, so a CJK name hits the wall at ~85 characters. Past it,
 * `fs.writeFile` throws and the user saw the raw errno:
 * `Upload failed (500): ENAMETOOLONG: name too long, open '/workspace/…'`.
 *
 * The budget stops short of 255 because the daemon may still rename on
 * collision: `withSuffix` inserts `-<uuid>` (37 bytes) before the extension.
 * Leaving that headroom means a collision cannot push a legal name back over
 * the limit.
 */
export const MAX_UPLOAD_FILENAME_BYTES = MAX_PROMPT_UPLOAD_FILENAME_BYTES;
export const sanitizeUploadFilename = sanitizePromptUploadFilename;

export function uploadedFileRefXml(input: UploadedFileRef): string {
  return promptFileReferenceXml({
    path: input.path,
    mime: input.mime,
    filename: input.filename,
    attachment: input.attachment,
  });
}

/** The ref a sent message draws before the runtime has the file. It is never pending. */
export function optimisticUploadedFileRef(file: AttachedFile): UploadedFileRef {
  if (file.kind === 'local') {
    return {
      path: '',
      mime: attachmentMime(file.file.type, file.file.name),
      filename: file.file.name,
      ...(file.uploadId ? { attachment: file.uploadId } : {}),
    };
  }

  return {
    path: file.filename,
    mime: file.mime,
    filename: file.filename,
  };
}

export function buildOptimisticPromptTextWithUploads(
  text: string,
  files: AttachedFile[] | undefined,
): string {
  const refs = (files ?? [])
    .map((file) => uploadedFileRefXml(optimisticUploadedFileRef(file)))
    .join('\n');

  return refs ? `${text}\n\n${refs}` : text;
}

/** What one Send carried, in send order: identity, name and type. */
export function sentAttachmentsOf(files: readonly AttachedFile[]): SentAttachment[] {
  return files.map((file) => {
    const ref = optimisticUploadedFileRef(file);
    return {
      ...(ref.attachment ? { id: ref.attachment } : {}),
      filename: ref.filename,
      mime: ref.mime,
    };
  });
}

/**
 * A prompt's file parts, in attachment order.
 *
 * Every composer file starts its upload when it enters the composer, so at the
 * POST each one takes the next handle-only part `whenReady` resolved. A remote
 * file rides as a URL part. Send never reads or uploads file bytes itself: a
 * local file without a ready handle is refused.
 */
export function promptFileParts(
  files: readonly AttachedFile[] | undefined,
  readyParts: readonly SessionPromptPart[],
): PromptFilePart[] {
  const parts: PromptFilePart[] = [];
  let next = 0;
  for (const file of files ?? []) {
    if (file.kind === 'remote') {
      parts.push({ type: 'file', mime: file.mime, url: file.url, filename: file.filename });
      continue;
    }
    const part = readyParts[next++];
    if (!file.uploadId || !part || part.type !== 'file' || !part.attachment_id)
      throw new Error('A staged attachment is missing its completed upload handle');
    parts.push(part as PromptFilePart);
  }
  if (next !== readyParts.length)
    throw new Error('Attachment selection changed before Send. Try again.');
  return parts;
}
