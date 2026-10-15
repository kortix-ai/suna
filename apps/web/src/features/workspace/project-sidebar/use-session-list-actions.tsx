'use client';

import { Button } from '@/components/ui/button';
import { dismissToast, errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useSessionListState } from '@kortix/sdk/react';

/**
 * Pin or archive a session in the viewer's own list (KRTX-2418), with the
 * result toast. Archive offers Undo, because the row leaves the list at once.
 * One hook for the sidebar, the sessions page and the session header.
 */
export function useSessionListActions(projectId: string) {
  const t = useTranslations('sidebar.pinArchive');
  const state = useSessionListState(projectId);

  const setPinned = async (sessionId: string, pinned: boolean) => {
    try {
      await state.setPinned(sessionId, pinned);
      successToast(t(pinned ? 'pinned' : 'unpinned'));
    } catch {
      errorToast(t(pinned ? 'pinFailed' : 'unpinFailed'));
    }
  };

  const setArchived = async (sessionId: string, archived: boolean): Promise<void> => {
    try {
      await state.setArchived(sessionId, archived);
    } catch {
      errorToast(t(archived ? 'archiveFailed' : 'unarchiveFailed'));
      return;
    }
    if (!archived) {
      successToast(t('unarchived'));
      return;
    }
    const toastId = `session-archive-undo-${sessionId}`;
    successToast(t('archived'), {
      id: toastId,
      button: (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            dismissToast(toastId);
            void setArchived(sessionId, false);
          }}
        >
          {t('undo')}
        </Button>
      ),
    });
  };

  return { setPinned, setArchived };
}
