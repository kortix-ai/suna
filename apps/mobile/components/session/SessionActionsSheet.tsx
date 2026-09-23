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
 * COR-148 (Jay, 2026-09-24): three rows sit above Rename, in their own
 * untitled group — Open change request · View changes · Compact. Open change
 * request opens `OpenCRSheet` as its own sheet after this one has closed,
 * prefilled with the session's branch → its base. View changes pushes the
 * session's changed files in place (`SessionChangesList`), and a file pushes
 * its diff (`SessionChangeFileView`); disabled with "No changes" when the
 * runtime reports none. Compact confirms (`useConfirmDialog`) after the sheet
 * has closed, then calls `useCompactSession`; the thread's compaction divider
 * is the progress, and only a failure toasts (web `compact-modal.tsx`).
 * Disabled while the session works. View changes and Compact need the live
 * runtime, so they show only for the thread on screen; a drawer long press on
 * another session shows Open change request alone. Rules:
 * `lib/session/session-actions.ts`. Export transcript and Archive are not on
 * mobile.
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
import { useColorScheme } from 'nativewind';
import {
  GitDiffIcon,
  GitPullRequestIcon,
  PencilIcon as Pencil,
  ArrowCounterClockwiseIcon as RotateCcw,
  ExportIcon as Share,
  SquareIcon as Square,
  StackIcon,
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
import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { OpenCRSheet } from '@/components/review/OpenCRSheet';
import { SessionChangeFileView, SessionChangesList } from '@/components/session/SessionChangesView';
import { SessionRenameForm } from '@/components/session/SessionRenameForm';
import { SessionShareForm } from '@/components/session/SessionShareForm';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { haptics } from '@/lib/haptics';
import { useCompactSession } from '@/lib/opencode/hooks/use-compact-session';
import { useSessionChanges } from '@/lib/opencode/hooks/use-session-changes';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { reviewKeys } from '@/lib/review/use-review';
import {
  isOpenThreadSession,
  openChangeRequestPrefill,
  sessionActionRows,
  type ChangedFile,
} from '@/lib/session/session-actions';
import { useCompactionStore } from '@/stores/compaction-store';
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
type SheetView = 'options' | 'rename' | 'share' | 'changes' | 'change-file';
const PUSHED_VIEW_TITLE: Record<Exclude<SheetView, 'options'>, string> = {
  rename: 'Rename session',
  share: 'Share session',
  changes: 'Changes',
  // The pushed file's name replaces this while one shows.
  'change-file': 'Changes',
};
/** What runs once the sheet has closed: a follow-up overlay, never two at once. */
type AfterClose = 'delete' | 'open-cr' | 'compact' | null;

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
    // The file pushed over the changes list (View changes → a file).
    const [changeFile, setChangeFile] = React.useState<ChangedFile | null>(null);
    // Set before the sheet closes; read when its close animation ends.
    // Delete and Compact confirm in a dialog, and Open change request is its
    // own sheet: each opens only after this sheet has closed.
    const afterCloseRef = React.useRef<AfterClose>(null);

    // ── COR-148: Open change request · View changes · Compact ──
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const { sandboxUrl } = useSandboxContext();
    // The thread on screen, keyed by its OpenCode id (SessionPage's `sessionId`).
    const activeSessionId = useTabStore((s) => s.activeSessionId);
    const isOpenThread = !!menuSession && isOpenThreadSession(menuSession, activeSessionId);
    const liveSessionId = isOpenThread ? activeSessionId : null;
    const changesQuery = useSessionChanges(sandboxUrl, isOpenThread);
    const runtimeStatus = useSyncStore((s) => (liveSessionId ? s.sessionStatus[liveSessionId] : undefined));
    const isBusy = runtimeStatus?.type === 'busy' || runtimeStatus?.type === 'retry';
    const isCompacting = useCompactionStore((s) =>
      liveSessionId ? Boolean(s.compactingBySession[liveSessionId]) : false
    );
    const compactSession = useCompactSession();
    const { confirm, dialog: confirmDialog } = useConfirmDialog();
    const openCRSheetRef = React.useRef<BottomSheetModal>(null);
    const [openCRPrefill, setOpenCRPrefill] = React.useState<ReturnType<
      typeof openChangeRequestPrefill
    >>(null);
    // The session and runtime a Compact tap was for, kept past the sheet's close.
    const compactTargetRef = React.useRef<{ sessionId: string; sandboxUrl: string } | null>(null);

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

    const runCompact = React.useCallback(() => {
      const target = compactTargetRef.current;
      compactTargetRef.current = null;
      if (!target) return;
      // The session may have started working while the dialog was up.
      const status = useSyncStore.getState().sessionStatus[target.sessionId];
      if (status?.type === 'busy' || status?.type === 'retry') {
        haptics.warning();
        toast.error('The session is working. Compact it when it stops.');
        return;
      }
      haptics.medium();
      // No progress or success toast: the thread's compaction divider mounts
      // at once (`startCompaction`) and becomes the server's compaction turn.
      compactSession.mutate(target, {
        onError: (error) => {
          haptics.warning();
          toast.error(error instanceof Error && error.message ? error.message : 'Unable to compact the session. Try again.');
        },
      });
    }, [compactSession, toast]);

    const handleSheetDismiss = React.useCallback(() => {
      const session = menuSession;
      const next = afterCloseRef.current;
      afterCloseRef.current = null;
      setMenuSession(null);
      setSheetView('options');
      setReturning(false);
      setChangeFile(null);
      if (!session || !next) return;
      if (next === 'delete') {
        setDeleteFailed(false);
        setDeleteTitle(sessionDisplayTitle(session));
        setConfirmDelete(session);
      } else if (next === 'open-cr') {
        setOpenCRPrefill(openChangeRequestPrefill(session, sessionDisplayTitle(session)));
        openCRSheetRef.current?.present();
      } else if (next === 'compact') {
        confirm({
          title: 'Compact session',
          description:
            'Older messages are summarized into a short recap to free up context. Recent messages stay as they are.',
          confirmLabel: 'Compact',
          onConfirm: runCompact,
        });
      }
    }, [menuSession, confirm, runCompact]);

    const pushView = React.useCallback((view: Exclude<SheetView, 'options'>) => {
      haptics.tap();
      setReturning(false);
      setSheetView(view);
      // Rename goes to full height (Jay, 2026-09-22): the field sits at the top,
      // clear of the keyboard, and the sheet does not resize as the keyboard moves.
      // A file's diff is long and wide: it reads at full height too.
      if (view === 'rename' || view === 'change-file') actionSheetRef.current?.snapToPosition('100%');
    }, []);
    const popView = React.useCallback(() => {
      haptics.tap();
      setReturning(true);
      // A file's diff goes back to the changes list; every other view to the options.
      setSheetView((view) => (view === 'change-file' ? 'changes' : 'options'));
      // Back to the content height: index 0, the stop under the full-height one.
      actionSheetRef.current?.snapToIndex(0);
    }, []);
    const openChangeFile = React.useCallback(
      (file: ChangedFile) => {
        setChangeFile(file);
        pushView('change-file');
      },
      [pushView]
    );
    const closeThen = React.useCallback((next: Exclude<AfterClose, null>) => {
      afterCloseRef.current = next;
      actionSheetRef.current?.dismiss();
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
    const topRows = sessionActionRows({
      isOpenThread,
      hasRuntime: !!sandboxUrl,
      canManageLifecycle,
      hasBranch: !!menuSession && openChangeRequestPrefill(menuSession, '') !== null,
      changes: {
        pending: changesQuery.isPending,
        error: changesQuery.isError,
        count: changesQuery.data?.count ?? 0,
      },
      busy: isBusy,
      compacting: isCompacting,
    });
    const hasTopRows =
      topRows.openChangeRequest.visible || topRows.viewChanges.visible || topRows.compact.visible;

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
              ? sheetView === 'change-file' && changeFile
                ? changeFile.name
                : PUSHED_VIEW_TITLE[sheetView]
              : menuSession
                ? sessionDisplayTitle(menuSession)
                : 'Session'
          }
          titleLeading={sheetView !== 'options' ? <SheetBackButton onPress={popView} /> : undefined}
          enableDynamicSizing
          enablePanDownToClose
          onDismiss={handleSheetDismiss}
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore">
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
                  {/* COR-148: the session's work first — Open change request ·
                      View changes · Compact — in their own group on top. */}
                  {hasTopRows ? (
                    <SettingsGroup>
                      {topRows.openChangeRequest.visible ? (
                        <SettingsRow
                          icon={GitPullRequestIcon}
                          label="Open change request"
                          onPress={() => {
                            haptics.tap();
                            closeThen('open-cr');
                          }}
                        />
                      ) : null}
                      {topRows.viewChanges.visible ? (
                        <SettingsRow
                          icon={GitDiffIcon}
                          label="View changes"
                          value={topRows.viewChanges.value}
                          disabled={!topRows.viewChanges.enabled}
                          right={topRows.viewChanges.enabled ? undefined : null}
                          onPress={() => pushView('changes')}
                        />
                      ) : null}
                      {topRows.compact.visible ? (
                        <SettingsRow
                          icon={StackIcon}
                          label="Compact"
                          value={topRows.compact.value}
                          disabled={!topRows.compact.enabled}
                          right={null}
                          onPress={() => {
                            if (!liveSessionId || !sandboxUrl) return;
                            haptics.tap();
                            compactTargetRef.current = { sessionId: liveSessionId, sandboxUrl };
                            closeThen('compact');
                          }}
                        />
                      ) : null}
                    </SettingsGroup>
                  ) : null}
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
                          closeThen('delete');
                        }}
                      />
                    </SettingsGroup>
                  ) : null}
                </View>
              </Animated.View>
            ) : sheetView === 'changes' ? (
              // View changes: the file list. Back from a file slides it back in.
              <Animated.View key="changes" entering={returning ? POP_IN : PUSH_IN}>
                <SessionChangesList
                  summary={changesQuery.data}
                  isLoading={changesQuery.isPending}
                  isError={changesQuery.isError}
                  onRetry={() => void changesQuery.refetch()}
                  onOpenFile={openChangeFile}
                />
              </Animated.View>
            ) : sheetView === 'change-file' ? (
              <Animated.View key="change-file" entering={PUSH_IN}>
                {changeFile ? <SessionChangeFileView file={changeFile} /> : null}
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

        {/* Open change request (COR-148): the Review page's `OpenCRSheet`,
            same sheet values as there, opened after this sheet has closed,
            prefilled with the session's branch → its base and its title. */}
        <KortixBottomSheetModal
          ref={openCRSheetRef}
          snapPoints={['88%']}
          enableDynamicSizing={false}
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore"
          onDismiss={() => setOpenCRPrefill(null)}>
          <OpenCRSheet
            projectId={projectId}
            isDark={isDark}
            initialHeadRef={openCRPrefill?.headRef ?? null}
            initialBaseRef={openCRPrefill?.baseRef || null}
            initialTitle={openCRPrefill?.title}
            onClose={() => openCRSheetRef.current?.dismiss()}
            onCreated={(_crId, number) => {
              openCRSheetRef.current?.dismiss();
              void queryClient.invalidateQueries({ queryKey: reviewKeys.list(projectId) });
              toast.success(`Opened change request #${number}`);
            }}
          />
        </KortixBottomSheetModal>

        {/* Compact's confirm. */}
        {confirmDialog}
      </>
    );
  }
);
