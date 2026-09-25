/**
 * prompt-parts — assembles the `SessionPromptPart[]` a send POSTs, from the
 * composer's text and its uploaded files. Mobile parity with apps/web
 * `features/session/uploaded-file-refs.ts` `promptFileParts` (mobile has no
 * `remote` file kind, so the check is narrower).
 */
import type { SessionPromptPart } from '@kortix/sdk';
import type { AttachedFile } from './attachments';

/**
 * `[{ type: 'text', text }, ...fileParts]`, dropping the text part when
 * `text` is blank. Throws when there would be nothing to send.
 */
export function promptParts(text: string, fileParts: readonly SessionPromptPart[]): SessionPromptPart[] {
  const trimmed = text.trim();
  const parts: SessionPromptPart[] = trimmed ? [{ type: 'text', text: trimmed }] : [];
  parts.push(...fileParts);
  if (parts.length === 0) throw new Error('A prompt needs text or a file');
  return parts;
}

/**
 * Pairs each staged file with its completed upload handle, by index. A file
 * with no `uploadId`, or a `ready[i]` that is not a file part with a string
 * `attachment_id`, means the upload never finished — the send is refused
 * rather than sent without that attachment.
 */
export function assertUploadedFileParts(
  files: readonly AttachedFile[],
  ready: readonly SessionPromptPart[],
): SessionPromptPart[] {
  return files.map((file, index) => {
    const part = ready[index];
    if (
      !file.uploadId ||
      !part ||
      part.type !== 'file' ||
      typeof part.attachment_id !== 'string' ||
      !part.attachment_id
    )
      throw new Error('A staged attachment is missing its completed upload handle');
    return part;
  });
}
