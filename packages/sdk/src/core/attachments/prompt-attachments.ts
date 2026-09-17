import { createAbortError } from '../http/abort';
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

/** At most ten progress snapshots per second per upload. */
const PROGRESS_INTERVAL_MS = 100;

/**
 * One counter for every controller in this JavaScript realm. A host keys sent
 * tiles and their pictures by id, and one tab runs several composers.
 */
let lastAttachmentId = 0;

/** Server codes after which the upload handle can never complete. Retry starts a new upload. */
const FAILED_HANDLE_CODES = new Set(['attachment_size_mismatch', 'attachment_failed']);

/** The same code the server answers for an expired upload, so a host words both the same way. */
const expiredError = () =>
  new ApiError('Attachment expired. Attach the file again.', { code: 'attachment_expired' });

export type PromptAttachmentStatus =
  'pending' | 'uploading' | 'processing' | 'ready' | 'error' | 'aborted';

export interface PromptAttachmentItem {
  readonly id: string;
  /** The same File reference survives progress, error and retry updates. */
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
  /** The composer selection. Entries handed to a send with `submit` are not listed. */
  readonly attachments: readonly PromptAttachmentItem[];
}

export interface PromptAttachmentControllerOptions {
  /** Defaults to two simultaneous files. Each file uses the transport its server selects. */
  concurrency?: number;
}

/** One composer's uploads, plus the uploads its sends still hold. */
export interface PromptAttachmentController {
  /** Start one upload now. Returns its id, unique across every controller in this JavaScript realm. */
  add(file: File): string;
  /** Validate the whole batch against the limits, then start every upload. */
  addMany(files: readonly File[]): string[];
  /**
   * Resume a failed or aborted upload with the same File and `attachment_id`.
   * After `attachment_size_mismatch` or `attachment_failed` the server keeps no
   * usable handle, so Retry uploads the same File as a new attachment.
   * A handed-off entry can be retried after `dispose()`.
   */
  retry(id: string): void;
  /**
   * Remove the entry now and abort its upload. Resolves after the local removal.
   * Deleting the unbound server upload is best-effort, so the promise never rejects.
   */
  remove(id: string): Promise<void>;
  /** Cancel unfinished work. */
  abort(id: string): void;
  /**
   * Hand `ids` to one send. They leave `attachments`, stop counting toward the
   * limits, and keep uploading after `dispose()`.
   */
  submit(ids: readonly string[]): void;
  /** Return handed-off `ids` to `attachments`, for a failed send that restores its draft. */
  reclaim(ids: readonly string[]): void;
  /**
   * Resolve handle-only file parts in `ids` order once every upload is ready.
   * Rejects when an upload fails, is aborted or removed, or `signal` aborts.
   */
  whenReady(
    ids: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<SessionPromptPart[]>;
  /** Release entries without deleting server objects. Defaults to the listed selection. */
  forget(ids?: readonly string[]): void;
  /**
   * Abort listed work and delete its server uploads best-effort: no send holds
   * them, and drafts keep no handle. Handed-off uploads continue.
   */
  dispose(): void;
  getSnapshot(): PromptAttachmentSnapshot;
  subscribe(listener: () => void): () => void;
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
): PromptAttachmentController {
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
    /** Held by a send: unlisted, outside the limits, and alive after dispose. */
    handedOff?: boolean;
  };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const waiters = new Set<() => void>();
  let active = 0;
  let disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: PromptAttachmentSnapshot = { attachments: [] };

  const listed = () => [...entries.values()].filter((entry) => !entry.handedOff);

  function emit() {
    if (expiryTimer) clearTimeout(expiryTimer);
    const attachments = listed().map(({ item }) => item);
    // A held upload's progress changes nothing a composer draws.
    if (
      attachments.length !== snapshot.attachments.length ||
      attachments.some((item, index) => item !== snapshot.attachments[index])
    )
      snapshot = { attachments };
    const expiry = Math.min(
      ...attachments
        .filter((item) => item.status === 'ready')
        .map((item) => Date.parse(item.attachment!.expires_at)),
    );
    if (Number.isFinite(expiry) && !disposed) {
      expiryTimer = setTimeout(
        () => {
          for (const entry of listed()) {
            if (
              entry.item.status === 'ready' &&
              Date.parse(entry.item.attachment!.expires_at) <= Date.now()
            )
              entry.item = {
                ...entry.item,
                status: 'error',
                error: expiredError(),
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
    for (const check of [...waiters]) check();
  }

  function requireProject(): string {
    if (disposed) throw new Error('Attachment controller is disposed');
    if (!projectId) throw new Error('A project is required to attach files');
    return projectId;
  }

  function validateSizes(sizes: number[]) {
    requireProject();
    const selection = listed();
    if (selection.length + sizes.length > MAX_PROMPT_ATTACHMENT_FILES)
      throw new Error('A message can contain up to 20 attachments');
    if (
      sizes.some(
        (size) => !Number.isSafeInteger(size) || size <= 0 || size > MAX_PROMPT_ATTACHMENT_BYTES,
      )
    )
      throw new Error('Each attachment must contain 1 byte to 50 MiB');
    const total =
      selection.reduce((sum, entry) => sum + entry.item.size, 0) +
      sizes.reduce((sum, size) => sum + size, 0);
    if (total > MAX_PROMPT_ATTACHMENTS_BYTES) throw new Error('Message attachments exceed 100 MiB');
  }

  function pump() {
    for (const entry of entries.values()) {
      if (active >= concurrency) break;
      if (entry.item.status !== 'pending' || !entry.item.file) continue;
      if (disposed && !entry.handedOff) continue;
      const file = entry.item.file;
      active++;
      const generation = ++entry.generation;
      const abort = new AbortController();
      entry.abort = abort;
      entry.item = { ...entry.item, status: 'uploading', error: undefined };
      const current = () =>
        (!disposed || entry.handedOff === true) &&
        entries.get(entry.item.id) === entry &&
        entry.generation === generation;
      // Progress snapshots: a whole-percent change only, at most one per interval.
      let unseenBytes: number | undefined;
      let seenAt = 0;
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const showProgress = () => {
        progressTimer = undefined;
        if (!current() || entry.item.status !== 'uploading' || unseenBytes === undefined) return;
        entry.item = { ...entry.item, receivedBytes: unseenBytes };
        unseenBytes = undefined;
        seenAt = Date.now();
        emit();
      };
      const percent = (bytes: number) => Math.floor((bytes * 100) / entry.item.size);
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
          if (!current() || percent(receivedBytes) === percent(entry.item.receivedBytes)) return;
          unseenBytes = receivedBytes;
          if (progressTimer) return;
          const wait = seenAt + PROGRESS_INTERVAL_MS - Date.now();
          if (wait <= 0) return showProgress();
          progressTimer = setTimeout(showProgress, wait);
          if (typeof progressTimer === 'object' && 'unref' in progressTimer) progressTimer.unref();
        },
        onProcessing: () => {
          // Every byte is sent. A throttled percent still waiting would be stale.
          if (progressTimer) clearTimeout(progressTimer);
          progressTimer = undefined;
          unseenBytes = undefined;
          if (current()) {
            entry.item = { ...entry.item, status: 'processing', receivedBytes: entry.item.size };
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
          // The server failed this handle for good. Retry uploads the same File as a new attachment.
          if (error instanceof ApiError && FAILED_HANDLE_CODES.has(error.code ?? ''))
            entry.upload = undefined;
          if (current())
            entry.item = {
              ...entry.item,
              status: error instanceof ApiError && error.code === 'ABORTED' ? 'aborted' : 'error',
              error: error instanceof Error ? error : new Error(String(error)),
            };
        })
        .finally(() => {
          active--;
          if (progressTimer) clearTimeout(progressTimer);
          if (entry.abort === abort) entry.abort = undefined;
          // After dispose this settles waiters and starts the next handed-off upload.
          emit();
          pump();
        });
    }
    emit();
  }

  function addMany(files: readonly File[]): string[] {
    validateSizes(files.map((file) => file.size));
    const ids = files.map((file) => {
      const id = `attachment-${++lastAttachmentId}`;
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

  function whenReady(
    ids: readonly string[],
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<SessionPromptPart[]> {
    const wanted = [...ids];
    return new Promise((resolve, reject) => {
      const stop = () => {
        waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        stop();
        reject(error);
      };
      const onAbort = () => fail(createAbortError());
      const check = () => {
        let waiting = false;
        for (const id of wanted) {
          const entry = entries.get(id);
          if (!entry) return fail(new Error('Attachment was removed before it was sent'));
          if (disposed && !entry.handedOff)
            return fail(new Error('Attachment controller is disposed'));
          if (entry.item.status === 'error' || entry.item.status === 'aborted')
            return fail(entry.item.error ?? new Error('Attachment upload failed'));
          if (entry.item.status !== 'ready') waiting = true;
        }
        if (waiting) return;
        let parts: SessionPromptPart[];
        try {
          parts = wanted.map((id) => {
            const attachment = completedMetadata(entries.get(id)!.item.attachment!);
            return {
              type: 'file',
              attachment_id: attachment.attachment_id,
              filename: attachment.filename,
              mime: attachment.mime,
            };
          });
        } catch (error) {
          return fail(error instanceof Error ? error : new Error(String(error)));
        }
        stop();
        resolve(parts);
      };
      if (signal?.aborted) return onAbort();
      waiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  return {
    add: (file: File): string => addMany([file])[0]!,
    addMany,
    retry(id: string): void {
      const entry = entries.get(id);
      // A send keeps its handed-off uploads after the composer unmounts, so the
      // send's Retry reaches them after `dispose()`.
      if (!entry?.handedOff) requireProject();
      if (
        !entry ||
        entry.item.status === 'ready' ||
        entry.item.status === 'uploading' ||
        entry.item.status === 'processing' ||
        entry.item.status === 'pending'
      )
        return;
      if (!entry.item.file || (entry.upload && Date.parse(entry.upload.expires_at) <= Date.now()))
        throw expiredError();
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
      // Best-effort: the entry is already gone, and an unbound upload expires after 24 hours.
      if (attachmentId) void deletePromptAttachment(projectId!, attachmentId).catch(() => {});
    },
    abort,
    submit(ids: readonly string[]): void {
      if (disposed) return;
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry) entry.handedOff = true;
      }
      emit();
    },
    reclaim(ids: readonly string[]): void {
      if (disposed) return;
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry) entry.handedOff = false;
      }
      emit();
    },
    whenReady,
    /** Release after an accepted send. Storage objects remain available for server command binding. */
    forget(ids: readonly string[] = listed().map((entry) => entry.item.id)): void {
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      for (const entry of entries.values()) {
        if (entry.handedOff) continue;
        entry.generation++;
        entry.abort?.abort();
        // No send holds a listed upload, and drafts keep no handle, so nothing can
        // send it later. Delete it now so it stops counting toward the per-user
        // upload budget. Best-effort: a bound upload answers 409, a lost one expires.
        const attachmentId = entry.upload?.attachment_id ?? entry.item.attachment?.attachment_id;
        if (attachmentId && projectId)
          void deletePromptAttachment(projectId, attachmentId).catch(() => {});
      }
      listeners.clear();
      // Waiters on listed entries reject; waiters on handed-off entries keep waiting.
      emit();
    },
    getSnapshot: (): PromptAttachmentSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
