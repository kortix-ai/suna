import { ApiError } from '../http/api-client';
import {
  deletePromptAttachment,
  uploadPromptAttachment,
  type PromptAttachment,
  type PromptAttachmentUpload,
} from '../rest/projects-client/prompt-attachments';
import type { SessionPromptPart } from '../rest/projects-client/sessions';
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS_BYTES,
  MAX_PROMPT_ATTACHMENT_FILES,
} from './limits';

export type PromptAttachmentStatus =
  'pending' | 'uploading' | 'processing' | 'ready' | 'error' | 'aborted';

export interface PromptAttachmentItem {
  readonly id: string;
  /** The same File reference survives progress, error and retry updates. Absent after restore. */
  readonly file?: File;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly status: PromptAttachmentStatus;
  readonly receivedBytes: number;
  readonly attachment?: PromptAttachment;
  readonly error?: Error;
}

export interface PromptAttachmentSnapshot {
  readonly attachments: readonly PromptAttachmentItem[];
  readonly canSend: boolean;
}

export interface PromptAttachmentControllerOptions {
  /** Defaults to two simultaneous files. Each file sends sequential chunks. */
  concurrency?: number;
}

function completedMetadata(value: PromptAttachment): PromptAttachment {
  if (
    !value ||
    typeof value.attachment_id !== 'string' ||
    !value.attachment_id ||
    typeof value.filename !== 'string' ||
    !value.filename ||
    typeof value.mime !== 'string' ||
    !value.mime ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_PROMPT_ATTACHMENT_BYTES ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.expires_at) <= Date.now()
  )
    throw new Error('Attachment metadata is invalid or expired. Attach the file again.');
  return {
    attachment_id: value.attachment_id,
    filename: value.filename,
    mime: value.mime,
    size: value.size,
    expires_at: value.expires_at,
  };
}

/** Own one composer selection. Plain-object methods also preserve createScopedKortix isolation. */
export function createPromptAttachmentController(
  projectId: string | null | undefined,
  options: PromptAttachmentControllerOptions = {},
) {
  const concurrency = options.concurrency ?? 2;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_PROMPT_ATTACHMENT_FILES
  )
    throw new Error('Attachment concurrency must be between 1 and 20');
  type Entry = {
    item: PromptAttachmentItem;
    upload?: PromptAttachmentUpload;
    abort?: AbortController;
    generation: number;
    removed?: boolean;
  };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let serial = 0;
  let active = 0;
  let disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: PromptAttachmentSnapshot = { attachments: [], canSend: true };

  function emit() {
    if (expiryTimer) clearTimeout(expiryTimer);
    const attachments = [...entries.values()].map(({ item }) => item);
    snapshot = {
      attachments,
      canSend: !disposed && attachments.every((item) => item.status === 'ready'),
    };
    const expiry = Math.min(
      ...attachments
        .filter((item) => item.status === 'ready')
        .map((item) => Date.parse(item.attachment!.expires_at)),
    );
    if (Number.isFinite(expiry) && !disposed) {
      expiryTimer = setTimeout(
        () => {
          for (const entry of entries.values()) {
            if (
              entry.item.status === 'ready' &&
              Date.parse(entry.item.attachment!.expires_at) <= Date.now()
            )
              entry.item = {
                ...entry.item,
                status: 'error',
                error: new Error('Attachment expired. Attach the file again.'),
              };
          }
          emit();
        },
        Math.min(2_147_483_647, Math.max(0, expiry - Date.now())),
      );
      // Do not keep a Node host alive solely for an abandoned selection.
      if (typeof expiryTimer === 'object' && 'unref' in expiryTimer) expiryTimer.unref();
    }
    for (const listener of listeners) listener();
  }

  function requireProject(): string {
    if (disposed) throw new Error('Attachment controller is disposed');
    if (!projectId) throw new Error('A project is required to attach files');
    return projectId;
  }

  function validateSizes(sizes: number[]) {
    requireProject();
    if (entries.size + sizes.length > MAX_PROMPT_ATTACHMENT_FILES)
      throw new Error('A message can contain up to 20 attachments');
    if (
      sizes.some(
        (size) => !Number.isSafeInteger(size) || size <= 0 || size > MAX_PROMPT_ATTACHMENT_BYTES,
      )
    )
      throw new Error('Each attachment must contain 1 byte to 50 MiB');
    const total =
      [...entries.values()].reduce((sum, entry) => sum + entry.item.size, 0) +
      sizes.reduce((sum, size) => sum + size, 0);
    if (total > MAX_PROMPT_ATTACHMENTS_BYTES) throw new Error('Message attachments exceed 100 MiB');
  }

  function pump() {
    if (disposed) return;
    for (const entry of entries.values()) {
      if (active >= concurrency) break;
      if (entry.item.status !== 'pending' || !entry.item.file) continue;
      const file = entry.item.file;
      active++;
      const generation = ++entry.generation;
      const abort = new AbortController();
      entry.abort = abort;
      entry.item = { ...entry.item, status: 'uploading', error: undefined };
      const current = () =>
        !disposed && entries.get(entry.item.id) === entry && entry.generation === generation;
      void uploadPromptAttachment(projectId!, file, {
        resume: entry.upload,
        signal: abort.signal,
        onUpload: (upload) => {
          entry.upload = upload;
          // An initiation response can race explicit removal before its handle was known.
          if (entry.removed)
            void deletePromptAttachment(projectId!, upload.attachment_id).catch(() => {});
        },
        onProgress: (receivedBytes) => {
          if (current()) {
            entry.item = { ...entry.item, receivedBytes };
            emit();
          }
        },
        onProcessing: () => {
          if (current()) {
            entry.item = { ...entry.item, status: 'processing' };
            emit();
          }
        },
      })
        .then((attachment) => {
          if (current()) {
            entry.item = {
              ...entry.item,
              status: 'ready',
              attachment: completedMetadata(attachment),
              receivedBytes: attachment.size,
            };
          }
        })
        .catch((error: unknown) => {
          if (current())
            entry.item = {
              ...entry.item,
              status: error instanceof ApiError && error.code === 'ABORTED' ? 'aborted' : 'error',
              error: error instanceof Error ? error : new Error(String(error)),
            };
        })
        .finally(() => {
          active--;
          if (entry.abort === abort) entry.abort = undefined;
          if (!disposed) {
            emit();
            pump();
          }
        });
    }
    emit();
  }

  function addMany(files: readonly File[]): string[] {
    validateSizes(files.map((file) => file.size));
    const ids = files.map((file) => {
      const id = `attachment-${++serial}`;
      entries.set(id, {
        generation: 0,
        item: {
          id,
          file,
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          status: 'pending',
          receivedBytes: 0,
        },
      });
      return id;
    });
    // The snapshot changes before returning, including before React's next render.
    emit();
    pump();
    return ids;
  }

  function abort(id: string) {
    const entry = entries.get(id);
    if (!entry || entry.item.status === 'ready') return;
    entry.generation++;
    entry.abort?.abort();
    entry.item = {
      ...entry.item,
      status: 'aborted',
      error: new Error('Attachment upload cancelled'),
    };
    emit();
  }

  return {
    add: (file: File): string => addMany([file])[0]!,
    addMany,
    restore(attachment: PromptAttachment): string {
      requireProject();
      const safe = completedMetadata(attachment);
      const existing = [...entries.values()].find(
        (entry) => entry.item.attachment?.attachment_id === safe.attachment_id,
      );
      if (existing) return existing.item.id;
      validateSizes([safe.size]);
      const id = `attachment-${++serial}`;
      entries.set(id, {
        generation: 0,
        item: {
          id,
          filename: safe.filename,
          mime: safe.mime,
          size: safe.size,
          status: 'ready',
          receivedBytes: safe.size,
          attachment: safe,
        },
      });
      emit();
      return id;
    },
    retry(id: string): void {
      requireProject();
      const entry = entries.get(id);
      if (
        !entry ||
        entry.item.status === 'ready' ||
        entry.item.status === 'uploading' ||
        entry.item.status === 'processing' ||
        entry.item.status === 'pending'
      )
        return;
      if (!entry.item.file || (entry.upload && Date.parse(entry.upload.expires_at) <= Date.now()))
        throw new Error('Attachment expired. Attach the file again.');
      entry.item = { ...entry.item, status: 'pending', error: undefined };
      pump();
    },
    async remove(id: string): Promise<void> {
      const entry = entries.get(id);
      if (!entry) return;
      entry.removed = true;
      entry.generation++;
      entry.abort?.abort();
      entries.delete(id);
      emit();
      pump();
      const attachmentId = entry.upload?.attachment_id ?? entry.item.attachment?.attachment_id;
      if (attachmentId) await deletePromptAttachment(projectId!, attachmentId);
    },
    abort,
    /** Successful-send handoff. Storage objects remain available for server command binding. */
    forget(ids: readonly string[] = [...entries.keys()]): void {
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry) {
          entry.generation++;
          entry.abort?.abort();
          entries.delete(id);
        }
      }
      emit();
      pump();
    },
    /** Abort unfinished transfers. Never delete ready objects during navigation. */
    dispose(): void {
      disposed = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      for (const entry of entries.values()) {
        entry.generation++;
        entry.abort?.abort();
      }
      snapshot = { ...snapshot, canSend: false };
      listeners.clear();
    },
    getSnapshot: (): PromptAttachmentSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Call in the submit handler, never gate Send only with a render-time boolean. */
    getReadyParts(): SessionPromptPart[] {
      if (disposed || !snapshot.canSend)
        throw new Error(
          'Wait for attachments to finish uploading, or retry/remove failed attachments',
        );
      return snapshot.attachments.map((item) => {
        const attachment = completedMetadata(item.attachment!);
        return {
          type: 'file',
          attachment_id: attachment.attachment_id,
          filename: attachment.filename,
          mime: attachment.mime,
        };
      });
    },
  };
}

export type PromptAttachmentController = ReturnType<typeof createPromptAttachmentController>;
