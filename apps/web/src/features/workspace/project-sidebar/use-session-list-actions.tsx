'use client';

import { errorToast, successToast, undoToast } from '@/components/ui/toast';
import { ArchiveIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useSessionListState } from '@kortix/sdk/react';
import { useMemo } from 'react';
import { UNDO_TOAST_MS } from './modal/session-delete-modal';

/**
 * Pin or archive a session in the viewer's own list (KRTX-2418), with the
 * result toast. Archive offers Undo, because the row leaves the list at once.
 * One hook for the sidebar, the sessions page and the session header. The
 * callbacks are stable, so a memoized row is not re-rendered.
 */
export function useSessionListActions(projectId: string) {
  const t = useTranslations('sidebar.pinArchive');
  const { setPinned: savePinned, setArchived: saveArchived } = useSessionListState(projectId);

  return useMemo(() => {
    const setPinned = async (sessionId: string, pinned: boolean) => {
      try {
        await savePinned(sessionId, pinned);
        successToast(t(pinned ? 'pinned' : 'unpinned'));
      } catch {
        errorToast(t(pinned ? 'pinFailed' : 'unpinFailed'));
      }
    };

    const setArchived = async (sessionId: string, archived: boolean): Promise<void> => {
      try {
        await saveArchived(sessionId, archived);
      } catch {
        errorToast(t(archived ? 'archiveFailed' : 'unarchiveFailed'));
        return;
      }
      if (!archived) {
        successToast(t('unarchived'));
        return;
      }
      undoToast(t('archived'), {
        id: `session-archive-undo-${sessionId}`,
        // As long as delete's Undo: the row has already left the list.
        duration: UNDO_TOAST_MS,
        icon: <ArchiveIcon className="size-4" />,
        undoLabel: t('undo'),
        onUndo: () => void setArchived(sessionId, false),
      });
    };

    return { setPinned, setArchived };
  }, [savePinned, saveArchived, t]);
}
