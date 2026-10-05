'use client';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { errorToast, successToast } from '@/components/ui/toast';
import { deleteProjectSession } from '@kortix/sdk';
import { qk, removeCachedProjectSession } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from '@/i18n/use-translations';

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
  const queryClient = useQueryClient();
  const openSessionId = useParams<{ sessionId?: string }>()?.sessionId;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProjectSession(projectId, id),
    // The row leaves every cached list the moment the user confirms, not when
    // the server does. Returns the restore for `onError`. Not for the session
    // this route renders: removing its row entry makes the page's own readers
    // (header, chat, the runtime pin) refetch a session that is being deleted.
    onMutate: (id) =>
      id === openSessionId ? undefined : removeCachedProjectSession(queryClient, projectId, id),
    onSuccess: () => {
      successToast(
        sessionLabel
          ? tHardcodedUi('i18nComplete.text0690079160b0', { value0: sessionLabel })
          : tHardcodedUi.raw('i18nComplete.text3c0cf36859ac'),
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
      description={
        <>
          {tHardcodedUi.raw(
            'componentsProjectsProjectSessionList.line191JsxTextThisWillPermanentlyDestroyTheBranchAndSandbox',
          )}{' '}
          <span className="text-foreground font-medium">{sessionLabel}</span>
          {tHardcodedUi.raw(
            'componentsProjectsProjectSessionList.line193JsxTextThisActionCannotBeUndone',
          )}
        </>
      }
      confirmLabel={tHardcodedUi.raw('i18nComplete.texte2d0a54968ea')}
      confirmVariant="destructive"
      isPending={deleteMutation.isPending}
      onConfirm={confirmDelete}
    />
  );
}
