import {
  MAX_PROMPT_UPLOAD_FILENAME_BYTES,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from '@kortix/shared';
import type { UploadResult } from '@/features/files/api/runtime-files';
import { attachmentMime } from '@/features/session/attachment-mime';
import type { AttachedFile } from '@/features/session/session-chat-input';

export type PromptFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename: string;
};

export type UploadFileForPrompt = (
  file: File | Blob,
  targetPath?: string,
  filename?: string,
) => Promise<UploadResult[]>;

export type UploadedFileRef = {
  /** Where the bytes actually landed. Empty ONLY on an optimistic ref, which
   *  is rendered before any upload has happened. */
  path: string;
  mime: string;
  filename: string;
  /**
   * Set only on an optimistic ref: a stable id for this attachment within its
   * own message, standing in for the path the server has not assigned yet.
   *
   * The optimistic ref used to carry a PREDICTED path
   * (`/workspace/uploads/<sanitized name>`) and that prediction is wrong far
   * more often than it is right: the daemon writes with `wx` and suffixes on
   * collision (`report-mgk2x1-a3f9b201.pdf`), so every re-upload of a name
   * already in the session lands somewhere else. Worse, two attachments in one
   * message whose names sanitize alike predicted the SAME path, and the
   * transcript keys uploads by path — three pasted screenshots (all named
   * `image.png`) produced three identical React keys.
   */
  pendingId?: string;
};

export const UPLOADS_DIR = '/workspace/uploads';

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
    pendingId: input.pendingId,
  });
}

/**
 * The ref rendered while the bytes are still in flight.
 *
 * `index` is the attachment's position in its own message — a stable identity
 * that two same-named attachments cannot share, unlike the path they used to
 * be keyed by.
 */
export function optimisticUploadedFileRef(file: AttachedFile, index = 0): UploadedFileRef {
  if (file.kind === 'local') {
    return {
      path: '',
      mime: attachmentMime(file.file.type, file.file.name),
      filename: file.file.name,
      pendingId: `upl_${index}`,
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
    .map((file, index) => uploadedFileRefXml(optimisticUploadedFileRef(file, index)))
    .join('\n');

  return refs ? `${text}\n\n${refs}` : text;
}

function splitFiles(files: AttachedFile[] | undefined): {
  localFiles: Extract<AttachedFile, { kind: 'local' }>[];
  remoteParts: PromptFilePart[];
} {
  const localFiles: Extract<AttachedFile, { kind: 'local' }>[] = [];
  const remoteParts: PromptFilePart[] = [];

  for (const file of files ?? []) {
    if (file.kind === 'local') {
      localFiles.push(file);
    } else {
      remoteParts.push({
        type: 'file',
        mime: file.mime,
        url: file.url,
        filename: file.filename,
      });
    }
  }

  return { localFiles, remoteParts };
}

/**
 * Where each already-uploaded `File` landed.
 *
 * A batch used to be `Promise.all`, so one failed upload rejected the send
 * while the other files were already written to the sandbox. The composer
 * restores the draft on that throw, so the natural next move is to press send
 * again — and the second attempt re-uploaded the survivors, which the daemon
 * cannot overwrite, so it suffixed them. Two orphan copies per retry.
 *
 * Remembering the landing path means a retry uploads only what actually failed.
 * Reuse beats deleting the survivors: a delete is a second network call that
 * can fail on its own, and it throws away bytes the user has already paid to
 * transfer.
 *
 * Keyed by the `File` object, which the composer preserves across the failed
 * send (`session-chat-input.tsx` `mergeFailedSubmissionFiles`) — a WeakMap, so
 * a dropped attachment takes its entry with it.
 */
const landedUploadPaths = new WeakMap<File | Blob, string>();

/** One failed upload inside a batch. */
export interface UploadFailure {
  filename: string;
  reason: string;
}

/**
 * A send that could not upload every attachment.
 *
 * Names each file that failed and why, because "Upload failed" alone leaves the
 * user with no idea which of five attachments to remove.
 */
export class UploadBatchError extends Error {
  readonly failures: UploadFailure[];
  /** The files that DID land. They are cached for the retry, not orphaned. */
  readonly uploaded: UploadedFileRef[];

  constructor(failures: UploadFailure[], uploaded: UploadedFileRef[]) {
    super(`Upload failed: ${failures.map((f) => `${f.filename} — ${f.reason}`).join('; ')}`);
    this.name = 'UploadBatchError';
    this.failures = failures;
    this.uploaded = uploaded;
  }
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'unknown error';
}

async function uploadLocalFile(
  file: Extract<AttachedFile, { kind: 'local' }>,
  uploadFile: UploadFileForPrompt,
): Promise<UploadedFileRef> {
  const mime = attachmentMime(file.file.type, file.file.name);
  const cached = landedUploadPaths.get(file.file);
  if (cached) return { path: cached, mime, filename: file.file.name };

  const safeName = sanitizeUploadFilename(file.file.name);
  const results = await uploadFile(file.file, UPLOADS_DIR, safeName);
  // The server path is authoritative: the daemon suffixes on collision and
  // reports where the bytes REALLY landed, which is rarely what a client can
  // predict.
  const path = results[0]?.path;
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('did not return a file path');
  }
  landedUploadPaths.set(file.file, path);
  return { path, mime, filename: file.file.name };
}

export async function buildPromptPartsWithUploads(
  text: string,
  files: AttachedFile[] | undefined,
  uploadFile: UploadFileForPrompt,
): Promise<{
  text: string;
  remoteParts: PromptFilePart[];
}> {
  const { localFiles, remoteParts } = splitFiles(files);
  if (localFiles.length === 0) return { text, remoteParts };

  // `allSettled`, not `all`: an upload's side effect (bytes on disk) is not
  // undone by its sibling's rejection, so the batch has to account for every
  // outcome rather than abandon the first failure's peers.
  const settled = await Promise.allSettled(
    localFiles.map((file) => uploadLocalFile(file, uploadFile)),
  );

  const uploaded: UploadedFileRef[] = [];
  const failures: UploadFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      uploaded.push(result.value);
      return;
    }
    failures.push({
      filename: localFiles[index].file.name,
      reason: failureReason(result.reason),
    });
  });

  if (failures.length > 0) throw new UploadBatchError(failures, uploaded);

  const refs = uploaded.map(uploadedFileRefXml).join('\n');
  return {
    text: `${text}\n\n${refs}`,
    remoteParts,
  };
}

/**
 * First-prompt attachments: the session's sandbox does not exist yet, so there
 * is nowhere to upload into. `data:` URLs are a durable control-plane staging
 * envelope for local files. The API removes non-native file parts before the
 * prompt reaches OpenCode. Already-remote files remain ordinary URL parts,
 * exactly as they do on every later send.
 *
 * The cap mirrors the API's serialized-row ceiling (`PROMPT_PARTS_MAX_BYTES`,
 * 12 MB of JSON ≈ 9 MB of file bytes): a durable row is a Postgres row, not a
 * blob store. Past it, the refusal names the way out — send the prompt and
 * attach the file once the session is running, where the ordinary upload path
 * takes over.
 */
export const DATA_URL_ATTACHMENTS_MAX_BYTES = 9 * 1024 * 1024;

export async function stageFirstPromptAttachments(
  files: AttachedFile[] | undefined,
): Promise<PromptFilePart[]> {
  if (!files?.length) return [];
  let totalBytes = 0;
  const parts: PromptFilePart[] = [];
  for (const file of files) {
    if (file.kind === 'remote') {
      parts.push({ type: 'file', mime: file.mime, url: file.url, filename: file.filename });
      continue;
    }
    totalBytes += file.file.size;
    if (totalBytes > DATA_URL_ATTACHMENTS_MAX_BYTES) {
      throw new Error(
        `Attachments over ${Math.floor(DATA_URL_ATTACHMENTS_MAX_BYTES / (1024 * 1024))} MB can't ride the first message — send it, then attach the file after the session starts.`,
      );
    }
    const mime = attachmentMime(file.file.type, file.file.name);
    const bytes = new Uint8Array(await file.file.arrayBuffer());
    // btoa over chunks: String.fromCharCode(...bytes) overflows the argument
    // limit on multi-MB files.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    parts.push({
      type: 'file',
      mime,
      url: `data:${mime};base64,${btoa(binary)}`,
      filename: file.file.name,
    });
  }
  return parts;
}
