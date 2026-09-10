'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  createPromptAttachmentController,
  type PromptAttachmentController,
  type PromptAttachmentControllerOptions,
  type PromptAttachmentSnapshot,
} from '../core/attachments/prompt-attachments';

export type UsePromptAttachmentsResult = PromptAttachmentController & PromptAttachmentSnapshot;

/** Composer upload state. Uses the host's configured SDK transport; requires no session runtime. */
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

  return { ...controller, ...snapshot };
}
