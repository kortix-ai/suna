'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  createPromptAttachmentController,
  type PromptAttachmentController,
  type PromptAttachmentControllerOptions,
  type PromptAttachmentSnapshot,
} from '../core/attachments/prompt-attachments';

/** The controller without its lifecycle and store plumbing, which the hook owns. */
export type UsePromptAttachmentsResult = Omit<
  PromptAttachmentController,
  'dispose' | 'subscribe' | 'getSnapshot'
> &
  PromptAttachmentSnapshot;

/**
 * Composer upload state. Uses the host's configured SDK transport; requires no
 * session runtime. The result keeps its identity until the snapshot changes.
 */
export function usePromptAttachments(
  projectId: string | null | undefined,
  options: PromptAttachmentControllerOptions = {},
): UsePromptAttachmentsResult {
  const concurrency = options.concurrency;
  const owner = useMemo(
    () => ({
      controller: createPromptAttachmentController(projectId, { concurrency }),
      mounts: 0,
    }),
    [projectId, concurrency],
  );
  const { controller } = owner;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    owner.mounts++;
    return () => {
      owner.mounts--;
      // StrictMode replays effects immediately. Dispose only after that replay can reclaim ownership.
      queueMicrotask(() => {
        if (owner.mounts === 0) controller.dispose();
      });
    };
  }, [owner, controller]);

  return useMemo(
    (): UsePromptAttachmentsResult => ({
      add: controller.add,
      addMany: controller.addMany,
      retry: controller.retry,
      remove: controller.remove,
      abort: controller.abort,
      submit: controller.submit,
      reclaim: controller.reclaim,
      whenReady: controller.whenReady,
      forget: controller.forget,
      ...snapshot,
    }),
    [controller, snapshot],
  );
}
