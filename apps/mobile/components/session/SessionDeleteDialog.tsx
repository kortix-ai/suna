/**
 * SessionDeleteDialog — the session delete flow the actions sheet defers to
 * (KRTX-774). Owns the confirm `AlertDialog`, the mutation, the double-tap
 * guard, the optimistic paged-cache write with undo, the tab cleanup and the
 * toasts. Mounted once by `SessionActionsSheet`; `present(session)` opens the
 * confirm for one session — the sheet calls it from its dismiss handler, so
 * the confirm opens only after the sheet has closed (never two overlays).
 */
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/components/kortix/toast-provider';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { projectKeys, sessionListKeys } from '@/lib/projects/hooks';
import { type ProjectSession, deleteProjectSession } from '@/lib/projects/projects-client';
import {
  applyToSessionCache,
  withoutSession,
  writeSessionLists,
} from '@/lib/session/session-cache-write';
import { sessionDisplayTitle } from '@/lib/session/session-list';
import { useTabStore } from '@/stores/tab-store';

export interface SessionDeleteDialogRef {
  /** Open the confirm for this session. */
  present: (session: ProjectSession) => void;
}

export const SessionDeleteDialog = React.forwardRef<SessionDeleteDialogRef, { projectId: string }>(
  function SessionDeleteDialog({ projectId }, ref) {
    const toast = useToast();
    const queryClient = useQueryClient();

    const [confirmDelete, setConfirmDelete] = React.useState<ProjectSession | null>(null);
    // The title of the last delete target. It is not cleared on close, so the
    // dialog keeps its text while its close animation runs.
    const [deleteTitle, setDeleteTitle] = React.useState('');
    const [deleteFailed, setDeleteFailed] = React.useState(false);

    const invalidateSessions = React.useCallback(
      () => queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) }),
      [queryClient, projectId],
    );

    React.useImperativeHandle(
      ref,
      () => ({
        present: (session: ProjectSession) => {
          setDeleteFailed(false);
          setDeleteTitle(sessionDisplayTitle(session));
          setConfirmDelete(session);
        },
      }),
      [],
    );

    // ── Delete ──
    const deleteSession = useMutation({
      mutationFn: (session: ProjectSession) => deleteProjectSession(projectId, session.session_id),
    });

    // Set from the tap: `isPending` flips only once the request starts, after
    // the list write below, and a second tap in between would delete twice.
    const deletingRef = React.useRef(false);
    const confirmDeleteSession = React.useCallback(async () => {
      if (!confirmDelete || deletingRef.current) return;
      deletingRef.current = true;
      haptics.medium();
      setDeleteFailed(false);
      let undo = () => {};
      try {
        // The row leaves the drawer and the Sessions page behind the dialog
        // now, and comes back if the server refuses. A refetch in flight would
        // put it back first, so it is cancelled. The paged list only: the flat
        // one names the open thread, which keeps its title until the delete
        // succeeds.
        // Paged lists and children only (keys longer than the flat list's).
        const listKeys = sessionListKeys(queryClient, projectId).filter((key) => key.length > 2);
        await queryClient.cancelQueries({ queryKey: projectKeys.projectSessions(projectId) });
        undo = writeSessionLists(queryClient, listKeys, (cached) =>
          applyToSessionCache<ProjectSession>(cached, (rows) =>
            withoutSession(rows, confirmDelete.session_id),
          ),
        );
        await deleteSession.mutateAsync(confirmDelete);
        // Drop the session's tab, so the store never points at a deleted
        // session and no dead tab survives — matters most when this was the
        // open thread: closing its tab clears `activeSessionId`, and the
        // project stack's view route pops itself back to home.
        const tabs = useTabStore.getState();
        const rootId = confirmDelete.runtime_session_id ?? confirmDelete.opencode_session_id;
        if (rootId) {
          tabs.closeTab(rootId);
        } else if (tabs.activeSessionId === confirmDelete.session_id) {
          tabs.navigateToSession(null);
        }
        haptics.success();
        toast.success('Session deleted');
        setConfirmDelete(null);
      } catch {
        undo();
        haptics.warning();
        setDeleteFailed(true);
      } finally {
        deletingRef.current = false;
        void invalidateSessions();
      }
    }, [confirmDelete, deleteSession, projectId, queryClient, toast, invalidateSessions]);

    return (
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight delete settles.
          if (!open && !deleteSession.isPending) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session</AlertDialogTitle>
            <AlertDialogDescription className={deleteFailed ? 'text-destructive' : undefined}>
              {deleteFailed
                ? 'Unable to delete. Check your connection and try again.'
                : `Delete “${deleteTitle}”? Its sandbox is destroyed. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild disabled={deleteSession.isPending}>
              <Button variant="secondary" size="lg" className="rounded-full">
                <Text>Cancel</Text>
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="lg"
              className="rounded-full"
              disabled={deleteSession.isPending}
              onPress={confirmDeleteSession}
            >
              <Text>{deleteSession.isPending ? 'Deleting…' : 'Delete session'}</Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  },
);
