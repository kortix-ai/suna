'use client';

import { uiRoutes } from '../../lib/routes';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { IconDelete } from '../../primitives/kortix-icons';
import {
  dismissToast,
  errorToast,
  progressToast,
  successToast,
  undoToast,
} from '../../primitives/toast';
import { deleteProjectSession, restoreProjectSession } from '@kortix/sdk';
import { qk, removeCachedProjectSession } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useUiParams, useUiRouter } from '../../providers/ui-provider';
import { useTranslations } from '../../i18n';

/** Days a deleted session stays restorable (`SESSION_DELETE_ROWS_DAYS` in the API). */
export const RESTORE_DAYS = 30;
/** How long the delete toast offers Undo. */
export const UNDO_TOAST_MS = 8000;
/**
 * The waits between restore attempts while the API answers 409
 * `session_sandbox_removal_pending`: the provider usually confirms the old
 * sandbox removed within seconds of the delete.
 */
const RESTORE_RETRY_MS = [2_000, 4_000, 8_000, 16_000];

const removalPending = (err: unknown) =>
  (err as { code?: unknown } | null)?.code === 'session_sandbox_removal_pending';

/** Restore a deleted session, retrying while its old sandbox is still being removed.
 *  Undo here, and Restore session under Recently deleted (KRTX-2853). */
export async function restoreWhenRemoved(projectId: string, sessionId: string): Promise<void> {
  for (const wait of RESTORE_RETRY_MS) {
    try {
      await restoreProjectSession(projectId, sessionId);
      return;
    } catch (err) {
      if (!removalPending(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  await restoreProjectSession(projectId, sessionId);
}

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
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const router = useUiRouter();
  const openSessionId = useUiParams<{ sessionId?: string }>()?.sessionId;

  // Runs from the toast, after the dialog closed (and maybe unmounted).
  const undoDelete = async (id: string, toastId: string) => {
    dismissToast(toastId);
    const progressId = progressToast(t('restoring'));
    try {
      await restoreWhenRemoved(projectId, id);
    } catch (err) {
      errorToast(
        err instanceof Error && err.message ? err.message : t('restoreFailed'),
        // Undo is the only restore in the web app: keep a way to try again.
        removalPending(err)
          ? {
              id: toastId,
              duration: UNDO_TOAST_MS,
              actions: [{ label: tCommon('retry'), onClick: () => void undoDelete(id, toastId) }],
            }
          : undefined,
      );
      return;
    } finally {
      dismissToast(progressId);
    }
    successToast(t('restored'));
    void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    // Deleting the open session left its page: Undo goes back to it.
    if (id === openSessionId) router.push(uiRoutes().session(projectId, id));
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
      undoToast(
        sessionLabel
          ? tHardcodedUi('i18nComplete.text0690079160b0', { value0: sessionLabel })
          : tHardcodedUi.raw('i18nComplete.text3c0cf36859ac'),
        {
          id: toastId,
          duration: UNDO_TOAST_MS,
          icon: <IconDelete className="size-4" />,
          undoLabel: t('undo'),
          onUndo: () => void undoDelete(id, toastId),
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
