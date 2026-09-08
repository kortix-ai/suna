import type {
  PromptAttachmentItem,
  PromptAttachmentSnapshot,
  SessionPromptPart,
} from '@kortix/sdk';

import type { AttachedFile } from './types';

export interface AttachmentSubmissionReader {
  getReadyParts: () => SessionPromptPart[];
  getSnapshot: () => PromptAttachmentSnapshot;
}

export interface StageComposerFilesDependencies {
  addMany: (files: readonly File[]) => string[];
  createObjectURL: (file: File) => string;
  isImage: (file: File) => boolean;
}

/** Validate and start every upload before creating preview URLs or React state. */
export function stageComposerFiles(
  files: readonly File[],
  dependencies: StageComposerFilesDependencies,
): Extract<AttachedFile, { kind: 'local' }>[] {
  if (files.length === 0) return [];
  const ids = dependencies.addMany(files);
  if (ids.length !== files.length) throw new Error('Attachment upload batch was not accepted');
  return files.map((file, index) => ({
    kind: 'local',
    uploadId: ids[index]!,
    file,
    localUrl: dependencies.createObjectURL(file),
    isImage: dependencies.isImage(file),
  }));
}

/** Keep optimistic previews alive after the composer revokes its submitted URLs. */
export function retainAttachmentPreviews(
  files: readonly AttachedFile[],
  createObjectURL: (file: File) => string,
): AttachedFile[] {
  return files.map((file) =>
    file.kind === 'local' ? { ...file, localUrl: createObjectURL(file.file) } : file,
  );
}

export function attachedFileUploadId(file: AttachedFile): string | undefined {
  return file.kind === 'remote' ? undefined : file.uploadId;
}

/**
 * Capture one Send's private upload handles synchronously.
 *
 * `getReadyParts()` is the gate. It throws while any selected upload is not
 * ready, including a paste and Enter dispatched in the same browser tick.
 */
export function captureAttachmentSubmission(
  files: readonly AttachedFile[],
  controller: AttachmentSubmissionReader,
): { submittedIds: string[]; parts: SessionPromptPart[] } {
  const readyParts = controller.getReadyParts();
  const byLocalId = new Map<string, PromptAttachmentItem>(
    controller.getSnapshot().attachments.map((item) => [item.id, item]),
  );
  const byAttachmentId = new Map(
    readyParts
      .filter((part) => part.type === 'file' && typeof part.attachment_id === 'string')
      .map((part) => [part.attachment_id!, part]),
  );
  const submittedIds: string[] = [];
  const parts: SessionPromptPart[] = [];

  for (const file of files) {
    const localId = attachedFileUploadId(file);
    if (!localId) continue;
    const item = byLocalId.get(localId);
    const attachmentId = item?.attachment?.attachment_id;
    const part = attachmentId ? byAttachmentId.get(attachmentId) : undefined;
    if (!part) throw new Error('Attachment selection changed before Send. Try again.');
    submittedIds.push(localId);
    parts.push(part);
  }

  return { submittedIds, parts };
}
