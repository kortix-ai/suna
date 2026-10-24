'use client';

import { ApiError, type ProjectMemoryUndoResult } from '@kortix/sdk';
import { useUndoProjectMemoryVersion } from '@kortix/sdk/react';

import { useTranslations } from '../../i18n';
import { errorToast, successToast } from '../../primitives/toast';

/**
 * Undo one change by any of its versions, with the toasts every Undo shares.
 * `onUndone` gets the pages the undo left live (empty when it removed a page
 * it had created).
 */
export function useUndoMemoryChange(projectId: string) {
  const t = useTranslations('spaces.memory');
  const undo = useUndoProjectMemoryVersion(projectId);
  // `mutateAsync`, not call-time `mutate` callbacks: TanStack drops those once
  // the caller unmounts (the toast's Undo after the last page was deleted),
  // and the hook's own `onError` is silent.
  const run = (versionId: string, onUndone?: (result: ProjectMemoryUndoResult) => void) =>
    undo.mutateAsync(versionId).then(
      (result) => {
        successToast(t('undone'));
        onUndone?.(result);
      },
      (err: unknown) => {
        const code = err instanceof ApiError ? err.code : null;
        errorToast(code === 'superseded' ? t('superseded') : code === 'already_undone' ? t('alreadyUndone') : t('undoFailed'));
      },
    );
  return { run, isPending: undo.isPending };
}
