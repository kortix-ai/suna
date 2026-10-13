'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { dismissToast, errorToast, successToast } from '@/components/ui/toast';
import { deleteProjectSession, restoreProjectSession } from '@kortix/sdk';
import { qk, removeCachedProjectSession } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from '@/i18n/use-translations';

/** Days a deleted session stays restorable (`SESSION_DELETE_ROWS_DAYS` in the API). */
const RESTORE_DAYS = 30;
/** How long the delete toast offers Undo. */
const UNDO_TOAST_MS = 8000;

interface SessionDeleteModalProps {
  projectId: string;
  sessionId: string | null;
  sessionLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

export function SessionDeleteModal({
  projectId,
  sessionId,
  sessionLabel,
  open,
  onOpenChange,
  onDeleted,
}: SessionDeleteModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = useTranslations('sessionDelete');
  const queryClient = useQueryClient();
  const router = useRouter();
  const openSessionId = useParams<{ sessionId?: string }>()?.sessionId;

  // Runs from the toast, after the dialog closed (and maybe unmounted).
  const undoDelete = async (id: string, toastId: string) => {
    dismissToast(toastId);
    try {
      await restoreProjectSession(projectId, id);
    } catch (err) {
      errorToast(err instanceof Error && err.message ? err.message : t('restoreFailed'));
      return;
    }
    successToast(t('restored'));
    void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    // Deleting the open session left its page: Undo goes back to it.
    if (id === openSessionId) router.push(`/projects/${projectId}/sessions/${id}`);
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProjectSession(projectId, id),
    // The row leaves every cached list the moment the user confirms, not when
    // the server does. Returns the restore for `onError`. Not for the session
    // this route renders: removing its row entry makes the page's own readers
    // (header, chat, the runtime pin) refetch a session that is being deleted.
    onMutate: (id) =>
      id === openSessionId ? undefined : removeCachedProjectSession(queryClient, projectId, id),
    onSuccess: (_result, id) => {
      const toastId = `session-delete-undo-${id}`;
      successToast(
        sessionLabel
          ? tHardcodedUi('i18nComplete.text0690079160b0', { value0: sessionLabel })
          : tHardcodedUi.raw('i18nComplete.text3c0cf36859ac'),
        {
          id: toastId,
          duration: UNDO_TOAST_MS,
          button: (
            <Button size="sm" variant="outline" onClick={() => void undoDelete(id, toastId)}>
              {t('undo')}
            </Button>
          ),
        },
      );
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
      onDeleted?.();
      onOpenChange(false);
    },
    onError: (err, _id, restore) => {
      restore?.();
      errorToast(
        err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.text5c9c6608b47d'),
      );
    },
  });

  const confirmDelete = () => {
    if (!sessionId || deleteMutation.isPending) return;
    deleteMutation.mutate(sessionId);
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!deleteMutation.isPending) onOpenChange(o);
      }}
      title={tHardcodedUi.raw('componentsProjectsProjectSessionList.line189JsxTextDeleteSession')}
      description={t.rich('description', {
        label: sessionLabel ?? '',
        days: RESTORE_DAYS,
        name: (chunks) => <span className="text-foreground font-medium">{chunks}</span>,
      })}
      confirmLabel={tHardcodedUi.raw('i18nComplete.texte2d0a54968ea')}
      confirmVariant="destructive"
      isPending={deleteMutation.isPending}
      onConfirm={confirmDelete}
    />
  );
}
