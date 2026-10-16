import type { PromptAttachment, PromptAttachmentItem } from '@kortix/sdk';

import type { AttachedFile } from '../types';
import type { StoredUpload } from './composer-draft';

/** The tray's finished uploads: what a draft keeps, and what an unmount releases. */
export interface FinishedDraftUpload {
  /** The controller id. */
  uploadId: string;
  upload: StoredUpload;
  /** The File, while this tab still holds it. */
  file?: File;
}

/** The tray entries whose upload finished, in tray order. Unfinished ones cannot outlive the controller. */
export function finishedDraftUploads(
  files: readonly AttachedFile[],
  items: readonly PromptAttachmentItem[],
): FinishedDraftUpload[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return files.flatMap((file) => {
    if (file.kind === 'remote' || !file.uploadId) return [];
    const item = byId.get(file.uploadId);
    if (item?.status !== 'ready' || !item.attachment) return [];
    const { attachment_id, filename, mime, size, expires_at } = item.attachment;
    return [
      {
        uploadId: file.uploadId,
        upload: { attachment_id, filename, mime, size, expires_at, isImage: file.isImage },
        ...(file.kind === 'local' ? { file: file.file } : {}),
      },
    ];
  });
}

/**
 * The Files of finished uploads a draft keeps, for this tab only, keyed by
 * `attachment_id`. A session switch unmounts the composer but not the tab, so
 * the restored tile keeps its picture and Retry. After a reload the Map is
 * empty and the tile shows the name only. Bounded by the server's budget of 40
 * unsent uploads per person: the oldest File goes first.
 */
// replica-local: one browser tab's memory, never shared.
const unsentUploadFiles = new Map<string, File>();
const MAX_KEPT_FILES = 40;

export function keepUnsentUploadFile(attachmentId: string, file: File): void {
  unsentUploadFiles.delete(attachmentId);
  unsentUploadFiles.set(attachmentId, file);
  while (unsentUploadFiles.size > MAX_KEPT_FILES) {
    const oldest = unsentUploadFiles.keys().next().value;
    if (oldest === undefined) break;
    unsentUploadFiles.delete(oldest);
  }
}

/** The File kept for `attachmentId`, handed back once. */
export function takeUnsentUploadFile(attachmentId: string): File | undefined {
  const file = unsentUploadFiles.get(attachmentId);
  unsentUploadFiles.delete(attachmentId);
  return file;
}

/**
 * List a draft's finished uploads in the controller again (`restore`) and build
 * their tray entries. A File this tab kept becomes a `local` entry with its
 * picture; without one the entry is `uploaded` and shows the name only. A handle
 * the controller refuses (expired, invalid) has no entry.
 */
export function restoreDraftUploads(
  uploads: readonly StoredUpload[],
  dependencies: {
    restore: (uploads: readonly { attachment: PromptAttachment; file?: File }[]) => (string | undefined)[];
    createObjectURL: (file: File) => string;
  },
): AttachedFile[] {
  const files = uploads.map((upload) => takeUnsentUploadFile(upload.attachment_id));
  const ids = dependencies.restore(
    uploads.map(({ isImage: _isImage, ...attachment }, index) => ({
      attachment,
      ...(files[index] ? { file: files[index] } : {}),
    })),
  );
  return uploads.flatMap((upload, index): AttachedFile[] => {
    const uploadId = ids[index];
    if (!uploadId) return [];
    const file = files[index];
    if (file)
      return [
        {
          kind: 'local',
          uploadId,
          file,
          localUrl: dependencies.createObjectURL(file),
          isImage: upload.isImage,
        },
      ];
    return [
      {
        kind: 'uploaded',
        uploadId,
        filename: upload.filename,
        mime: upload.mime,
        size: upload.size,
        isImage: false,
      },
    ];
  });
}
