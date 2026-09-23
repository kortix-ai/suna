/**
 * SessionActionsSheet — the shared "session ···" sheet: Rename, Share,
 * Restart sandbox, Stop (running only), and Delete for one session.
 *
 * Extracted from the Sessions page's long-press sheet (COR-140 Task 5) so the
 * thread header's `···` (`ProjectHeaderActions`, via `SessionPage`) and the
 * project drawer's session-row long-press open the exact same sheet, instead
 * of three copies of the same logic.
 *
 * Layout (board 11b): the `KortixBottomSheetModal` title row, titled with
 * the session, close at the far left (Back while Rename or Share shows); one untitled
 * group of Rename · Share (when `can_manage_sharing !== false`) · Restart
 * sandbox · Stop (running only, both need `can_manage_lifecycle !== false`);
 * then Delete session alone in its own group, destructive. Rename and Share
 * push in place of the options (`sheet-push`), one sheet for the whole flow.
 * Delete confirms in an `AlertDialog` that opens only after the sheet has
 * closed — never two overlays at once.
 *
 * Controlled by an imperative ref (`present(session)`), so a caller needs no
 * state of its own: mount one instance and call `ref.current?.present(session)`
 * from a tap or a long press.
 */
import * as React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import Animated from 'react-native-reanimated';
import { View } from 'react-native';
import {
  PencilIcon as Pencil,
  ArrowCounterClockwiseIcon as RotateCcw,
  ExportIcon as Share,
  SquareIcon as Square,
  TrashIcon as Trash2,
} from '@/lib/icons';

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
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { useToast } from '@/components/kortix/toast-provider';
import { SessionRenameForm } from '@/components/session/SessionRenameForm';
import { SessionShareForm } from '@/components/session/SessionShareForm';
import { haptics } from '@/lib/haptics';
import { projectKeys, useProjectSessionsPaged } from '@/lib/projects/hooks';
import {
  deleteProjectSession,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@/lib/projects/projects-client';
import { sessionDisplayStatus, sessionDisplayTitle } from '@/lib/session/session-list';
import { useTabStore } from '@/stores/tab-store';

/** The sheet's view: its actions, or a form pushed over them. */
type SheetView = 'options' | 'rename' | 'share';
const PUSHED_VIEW_TITLE: Record<Exclude<SheetView, 'options'>, string> = {
  rename: 'Rename session',
  share: 'Share session',
};

export interface SessionActionsSheetRef {
  /**
   * Open the sheet for this session. `initialView: 'rename'` (COR-140) opens
   * straight to the Rename view instead of the options list — what the
   * thread header's title tap uses, so a rename has exactly one
   * implementation. Back from it returns to the options, same as a normal
   * Rename → Back.
   */
  present: (session: ProjectSession, initialView?: 'rename') => void;
}

export interface SessionActionsSheetProps {
  projectId: string;
  /**
   * Run the background poll on the live-session lookup below. `false` pauses
   * it while the project screen is not focused (a root screen — Billing,
   * Settings — covers it), matching every other project-sessions poll.
   * Default `true`.
   */
  poll?: boolean;
}

export const SessionActionsSheet = React.forwardRef<SessionActionsSheetRef, SessionActionsSheetProps>(
  function SessionActionsSheet({ projectId, poll = true }, ref) {
    const insets = useSafeAreaInsets();
    const toast = useToast();
    const queryClient = useQueryClient();

    // The freshest copy of the session: a caller may have long-pressed a row
    // from a list that has since refetched, and Rename/Share should never
    // seed from a stale title or a stale sharing state. `sessions` here is
    // every page loaded so far (not just the first 50) — a long press past
    // the first page (the Sessions page's list, or the drawer's) must still
    // resolve to the live row, not the static one `present()` was called
    // with. This is the SAME query the Sessions page and the drawer already
    // run (`projectKeys.projectSessionsPaged`), so mounting this sheet
    // subscribes to their cache instead of starting a second one.
    const { sessions: liveSessions } = useProjectSessionsPaged(projectId, { poll });
    const liveRow = React.useCallback(
      (session: ProjectSession) =>
        liveSessions.find((s) => s.session_id === session.session_id) ?? session,
      [liveSessions]
    );

    const invalidateSessions = React.useCallback(
      () => queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) }),
      [queryClient, projectId]
    );

    const actionSheetRef = React.useRef<BottomSheetModal>(null);
    const [sheetView, setSheetView] = React.useState<SheetView>('options');
    // True once the user came back from Rename: only then the options slide in.
    const [returning, setReturning] = React.useState(false);
    const [menuSession, setMenuSession] = React.useState<ProjectSession | null>(null);
    // Set before the sheet closes; read when its close animation ends.
    // Delete confirms in a dialog, which opens only after the sheet has closed.
    const deleteAfterCloseRef = React.useRef(false);

    const present = React.useCallback((session: ProjectSession, initialView?: 'rename') => {
      haptics.medium();
      setMenuSession(session);
      if (initialView) setSheetView(initialView);
    }, []);
    React.useImperativeHandle(ref, () => ({ present }), [present]);

    React.useEffect(() => {
      if (!menuSession) return;
      actionSheetRef.current?.present();
      // Mirrors `pushView`'s own snap: Rename opens at full height so the
      // field sits clear of the keyboard, whether reached by pushing from
      // the options or, here, opened straight to it.
      if (sheetView === 'rename') actionSheetRef.current?.snapToPosition('100%');
      // Deliberately keyed on `menuSession` alone: `sheetView` changing on
      // its own (Back, a normal push) must not re-trigger `.present()`.
    }, [menuSession]);

    const [confirmDelete, setConfirmDelete] = React.useState<ProjectSession | null>(null);
    // The title of the last delete target. It is not cleared on close, so the
    // dialog keeps its text while its close animation runs.
    const [deleteTitle, setDeleteTitle] = React.useState('');
    const [deleteFailed, setDeleteFailed] = React.useState(false);

    const handleSheetDismiss = React.useCallback(() => {
      const session = menuSession;
      const confirm = deleteAfterCloseRef.current;
      deleteAfterCloseRef.current = false;
      setMenuSession(null);
      setSheetView('options');
      setReturning(false);
      if (!session || !confirm) return;
      setDeleteFailed(false);
      setDeleteTitle(sessionDisplayTitle(session));
      setConfirmDelete(session);
    }, [menuSession]);

    const pushView = React.useCallback((view: Exclude<SheetView, 'options'>) => {
      haptics.tap();
      setSheetView(view);
      // Rename goes to full height (Jay, 2026-09-22): the field sits at the top,
      // clear of the keyboard, and the sheet does not resize as the keyboard moves.
      if (view === 'rename') actionSheetRef.current?.snapToPosition('100%');
    }, []);
    const popView = React.useCallback(() => {
      haptics.tap();
      setReturning(true);
      setSheetView('options');
      // Back to the content height: index 0, the stop under the full-height one.
      actionSheetRef.current?.snapToIndex(0);
    }, []);
    const closeSheet = React.useCallback(() => actionSheetRef.current?.dismiss(), []);

    // Restart and Stop open no overlay: close the sheet and run at once.
    const busyRef = React.useRef(new Set<string>());
    const runLifecycle = React.useCallback(
      async (
        session: ProjectSession,
        kind: 'restart' | 'stop',
        call: (projectId: string, sessionId: string) => Promise<unknown>,
        messages: { success: string; failure: string }
      ) => {
        const key = `${kind}:${session.session_id}`;
        if (busyRef.current.has(key)) return;
        busyRef.current.add(key);
        try {
          await call(projectId, session.session_id);
          haptics.success();
          toast.success(messages.success);
        } catch {
          haptics.warning();
          toast.error(messages.failure);
        } finally {
          busyRef.current.delete(key);
          void invalidateSessions();
        }
      },
      [projectId, toast, invalidateSessions]
    );

    const handleRestart = React.useCallback(() => {
      if (!menuSession) return;
      haptics.tap();
      actionSheetRef.current?.dismiss();
      void runLifecycle(menuSession, 'restart', restartProjectSession, {
        success: 'Session restarting',
        failure: 'Unable to restart the session. Try again.',
      });
    }, [menuSession, runLifecycle]);

    const handleStop = React.useCallback(() => {
      if (!menuSession) return;
      haptics.tap();
      actionSheetRef.current?.dismiss();
      void runLifecycle(menuSession, 'stop', stopProjectSession, {
        success: 'Session stopped',
        failure: 'Unable to stop the session. Try again.',
      });
    }, [menuSession, runLifecycle]);

    // ── Delete ──
    const deleteSession = useMutation({
      mutationFn: (session: ProjectSession) => deleteProjectSession(projectId, session.session_id),
    });

    const confirmDeleteSession = React.useCallback(async () => {
      if (!confirmDelete || deleteSession.isPending) return;
      haptics.medium();
      setDeleteFailed(false);
      try {
        await deleteSession.mutateAsync(confirmDelete);
        // Drop the session's tab, so the store never points at a deleted
        // session and no dead tab survives — matters most when this was the
        // open thread: closing its tab clears `activeSessionId`, and the
        // project stack's view route pops itself back to home.
        const tabs = useTabStore.getState();
        if (confirmDelete.opencode_session_id) {
          tabs.closeTab(confirmDelete.opencode_session_id);
        } else if (tabs.activeSessionId === confirmDelete.session_id) {
          tabs.navigateToSession(null);
        }
        haptics.success();
        toast.success('Session deleted');
        setConfirmDelete(null);
      } catch {
        haptics.warning();
        setDeleteFailed(true);
      } finally {
        void invalidateSessions();
      }
    }, [confirmDelete, deleteSession, toast, invalidateSessions]);

    const menuStatus = menuSession ? sessionDisplayStatus(menuSession) : null;
    const canManageLifecycle = menuSession?.can_manage_lifecycle !== false;
    const canManageSharing = menuSession?.can_manage_sharing !== false;

    return (
      <>
        {/* `KortixBottomSheetModal` directly, never the `Sheet` wrapper: it
            opens at its content height and drags up to full height (the
            `100%` stop and the safe-area top inset are the component's own
            defaults). Rename and Share push in place of the options
            (`sheet-push`). */}
        <KortixBottomSheetModal
          ref={actionSheetRef}
          // The shared title row in the handle area, like every titled sheet:
          // the X, and no second handle gap above an in-content title.
          title={
            menuSession && sheetView !== 'options'
              ? PUSHED_VIEW_TITLE[sheetView]
              : menuSession
                ? sessionDisplayTitle(menuSession)
                : 'Session'
          }
          titleLeading={sheetView !== 'options' ? <SheetBackButton onPress={popView} /> : undefined}
          enableDynamicSizing
          enablePanDownToClose
          onDismiss={handleSheetDismiss}
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore"
          android_keyboardInputMode="adjustResize">
          {/* One scrollable child: dynamic sizing needs it, and Share's member
              list can be taller than the screen. */}
          <BottomSheetScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
            {!menuSession ? null : sheetView === 'options' ? (
              <Animated.View key="options" entering={returning ? POP_IN : undefined}>
                {/* Board 11b: one group of Rename/Share/Restart/Stop, then
                    Delete alone in its own group, destructive. The 16pt
                    project edge matches the title row's inset; 18pt between
                    the two groups, the settings screens' gap. */}
                <View className="px-4" style={{ gap: 18 }}>
                  <SettingsGroup>
                    <SettingsRow icon={Pencil} label="Rename" onPress={() => pushView('rename')} />
                    {canManageSharing ? (
                      <SettingsRow icon={Share} label="Share" onPress={() => pushView('share')} />
                    ) : null}
                    {canManageLifecycle ? (
                      <SettingsRow
                        icon={RotateCcw}
                        label="Restart sandbox"
                        right={null}
                        onPress={handleRestart}
                      />
                    ) : null}
                    {canManageLifecycle && menuStatus === 'running' ? (
                      <SettingsRow icon={Square} label="Stop" right={null} onPress={handleStop} />
                    ) : null}
                  </SettingsGroup>
                  {canManageLifecycle ? (
                    <SettingsGroup>
                      <SettingsRow
                        icon={Trash2}
                        label="Delete session"
                        destructive
                        right={null}
                        onPress={() => {
                          haptics.warning();
                          deleteAfterCloseRef.current = true;
                          closeSheet();
                        }}
                      />
                    </SettingsGroup>
                  ) : null}
                </View>
              </Animated.View>
            ) : (
              // Rename and Share push in place of the options; Back returns to them.
              <Animated.View key={sheetView} entering={PUSH_IN}>
                {sheetView === 'rename' ? (
                  <SessionRenameForm
                    projectId={projectId}
                    session={liveRow(menuSession)}
                    onDone={closeSheet}
                  />
                ) : (
                  <SessionShareForm
                    projectId={projectId}
                    session={liveRow(menuSession)}
                    onDone={closeSheet}
                  />
                )}
              </Animated.View>
            )}
          </BottomSheetScrollView>
        </KortixBottomSheetModal>

        <AlertDialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            // Keep the dialog up until an in-flight delete settles.
            if (!open && !deleteSession.isPending) setConfirmDelete(null);
          }}>
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
                onPress={confirmDeleteSession}>
                <Text>{deleteSession.isPending ? 'Deleting…' : 'Delete session'}</Text>
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
);
