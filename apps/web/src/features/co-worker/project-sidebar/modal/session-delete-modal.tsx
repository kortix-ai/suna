'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { errorToast, successToast } from '@/components/ui/toast';
import { deleteProjectSession } from '@/lib/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

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

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProjectSession(projectId, id),
    onSuccess: () => {
      successToast('Session deleted');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      onDeleted?.();
      onOpenChange(false);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to delete session');
    },
  });

  const confirmDelete = () => {
    if (!sessionId || deleteMutation.isPending) return;
    deleteMutation.mutate(sessionId);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tHardcodedUi.raw('componentsProjectsProjectSessionList.line189JsxTextDeleteSession')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {tHardcodedUi.raw(
              'componentsProjectsProjectSessionList.line191JsxTextThisWillPermanentlyDestroyTheBranchAndSandbox',
            )}{' '}
            <span className="text-foreground font-medium">{sessionLabel}</span>
            {tHardcodedUi.raw(
              'componentsProjectsProjectSessionList.line193JsxTextThisActionCannotBeUndone',
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmDelete} disabled={deleteMutation.isPending}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
