/**
 * useComposerAttachments — one composer's attachment state, backed by the
 * SDK's `PromptAttachmentController` (`packages/sdk/src/core/attachments/
 * prompt-attachments.ts`). Used by `SessionChatInput` (a thread) and
 * `ProjectHome` (a new session's composer, COR-185).
 *
 * Owns one controller per `projectId`, read through `useSyncExternalStore`.
 * The composer subscribes only to each upload's phase (`uploadPhaseKey`):
 * uploading, ready or failed. Progress ticks (up to 10 per second per file)
 * reach only the tile that draws them, through the `live` source each upload
 * entry carries (`ComposerAttachmentTiles`). `add` reads each picked file off the device
 * (`lib/session/attachment-file.ts`) and starts its upload; a read failure
 * drops that file and toasts (`lib/session/composer-uploads.ts`). `takeForSend`
 * waits for every staged upload, pairs the results with the picked files
 * (`lib/session/prompt-parts.ts`), and reclaims them on any failure so the
 * files stay in the composer for another try.
 */
import * as React from 'react';
import {
  createPromptAttachmentController,
  type PromptAttachmentSnapshot,
  type SessionPromptPart,
} from '@kortix/sdk';

import { useToast } from '@/components/kortix/toast-provider';
import { log } from '@/lib/logger';
import { toUploadFile } from '@/lib/session/attachment-file';
import type { AttachedFile } from '@/lib/session/attachments';
import {
  SEND_UPLOAD_WAIT_MS,
  composerUploadState,
  stillReadingError,
  uploadErrorMessage,
} from '@/lib/session/composer-uploads';
import { assertUploadedFileParts } from '@/lib/session/prompt-parts';
import type { ComposerAttachmentUpload } from './composer-attachment-tiles';

export interface UseComposerAttachments {
  files: AttachedFile[];
  add: (picked: AttachedFile[]) => void;
  remove: (index: number) => void;
  uploads: Record<number, ComposerAttachmentUpload>;
  takeForSend: () => Promise<{ files: AttachedFile[]; fileParts: SessionPromptPart[] }>;
  clearAfterSend: () => void;
  reclaim: (ids: readonly string[]) => void;
}

export function useComposerAttachments(
  projectId: string | null | undefined,
  opts?: { initialFiles?: AttachedFile[] },
): UseComposerAttachments {
  const toast = useToast();
  const controller = React.useMemo(() => createPromptAttachmentController(projectId), [projectId]);
  React.useEffect(() => () => controller.dispose(), [controller]);
  const getPhaseKey = React.useCallback(() => uploadPhaseKey(controller.getSnapshot()), [controller]);
  const phaseKey = React.useSyncExternalStore(controller.subscribe, getPhaseKey);

  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  // Files removed while still being read off the device. Their read resolves
  // later; the upload it would start is dropped at once, so nothing uploads
  // for a tile the user already removed.
  const removedWhileReadingRef = React.useRef(new WeakSet<AttachedFile>());

  const add = React.useCallback(
    (picked: AttachedFile[]) => {
      if (picked.length === 0) return;
      setFiles((prev) => [...prev, ...picked]);
      for (const f of picked) {
        void toUploadFile(f)
          .then((file) => {
            const id = controller.add(file);
            if (removedWhileReadingRef.current.has(f)) {
              void controller.remove(id);
              return;
            }
            setFiles((prev) => prev.map((entry) => (entry === f ? { ...entry, uploadId: id } : entry)));
          })
          .catch((err: unknown) => {
            log.warn('[attachments] could not read or stage a picked file:', err);
            if (removedWhileReadingRef.current.has(f)) return;
            setFiles((prev) => prev.filter((entry) => entry !== f));
            toast.error(uploadErrorMessage(err, f.name));
          });
      }
    },
    [controller, toast],
  );

  const initialFilesRef = React.useRef(opts?.initialFiles);
  React.useEffect(() => {
    const initial = initialFilesRef.current;
    if (!initial || initial.length === 0) return;
    add(initial.map((f) => ({ ...f, uploadId: undefined })));
    // Runs once, on mount, to restore a cancelled send's staged files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = React.useCallback(
    (index: number) => {
      setFiles((prev) => {
        const target = prev[index];
        if (target?.uploadId) void controller.remove(target.uploadId);
        else if (target) removedWhileReadingRef.current.add(target);
        return prev.filter((_, i) => i !== index);
      });
    },
    [controller],
  );

  // Rebuilt only when the file list or a phase changes, so each entry (and its
  // `onRetry`) keeps one identity across progress ticks and keystrokes.
  const uploads = React.useMemo(() => {
    const snapshot = controller.getSnapshot();
    const result: Record<number, ComposerAttachmentUpload> = {};
    files.forEach((file, index) => {
      const id = file.uploadId;
      const item = id ? snapshot.attachments.find((entry) => entry.id === id) : undefined;
      const state = composerUploadState(item);
      if (!state) return;
      if (state.failed) {
        result[index] = { ...state, onRetry: () => id && controller.retry(id) };
      } else if (id) {
        result[index] = {
          ...state,
          live: {
            subscribe: controller.subscribe,
            getProgress: () =>
              composerUploadState(controller.getSnapshot().attachments.find((entry) => entry.id === id))?.progress,
          },
        };
      } else {
        result[index] = state;
      }
    });
    return result;
    // `phaseKey` is the trigger: it changes when an upload starts, ends or fails.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, phaseKey, controller]);

  const takeForSend = React.useCallback(async () => {
    const ids = files.map((f) => f.uploadId);
    if (ids.some((id) => !id)) throw stillReadingError();
    const readyIds = ids as string[];
    controller.submit(readyIds);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), SEND_UPLOAD_WAIT_MS);
    try {
      const parts = await controller.whenReady(readyIds, { signal: abortController.signal });
      return { files, fileParts: assertUploadedFileParts(files, parts) };
    } catch (err) {
      controller.reclaim(readyIds);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, [files, controller]);

  const clearAfterSend = React.useCallback(() => {
    const sentIds = files.map((f) => f.uploadId).filter((id): id is string => Boolean(id));
    controller.forget(sentIds);
    setFiles([]);
  }, [files, controller]);

  const reclaim = React.useCallback(
    (ids: readonly string[]) => {
      controller.reclaim(ids);
    },
    [controller],
  );

  return { files, add, remove, uploads, takeForSend, clearAfterSend, reclaim };
}

/**
 * What the composer draws from a snapshot, without progress: each listed
 * upload's id and phase. A string, so an unchanged phase compares equal and a
 * progress tick does not re-render the composer.
 */
export function uploadPhaseKey(snapshot: PromptAttachmentSnapshot): string {
  return snapshot.attachments
    .map((item) => {
      const state = composerUploadState(item);
      return `${item.id}:${!state ? 'done' : state.failed ? 'failed' : 'running'}`;
    })
    .join('|');
}
