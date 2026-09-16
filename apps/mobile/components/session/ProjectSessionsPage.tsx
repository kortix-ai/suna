/**
 * ProjectSessionsPage — every session of a project, at `/projects/[id]/sessions`
 * (opened from the project drawer's Sessions button).
 *
 *   header   SettingsHeader: hamburger row, then the large "Sessions" title
 *   search   SearchListHeader, filters by display title
 *   list     Today / Yesterday / This week / Older, headers only when more
 *            than one group has sessions. Row: status mark · title · time
 *
 * Tap a row → the session opens in the view route, which replaces this page
 * (useCoveringRoute), so the stack stays one screen over project home.
 * Long press → a bottom sheet of actions: Rename, Share, Restart, Stop (running
 * only), Delete. Rename, Share and Delete open their own overlay only after the
 * action sheet has closed, so two overlays never stack.
 *
 * No filter, grouping or ordering controls: the list is always newest activity
 * first. Title, status, grouping and relative time come from
 * lib/session/session-list (unit-tested).
 */

import * as React from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  View,
  type SectionListRenderItem,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router/react-navigation';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Pencil, RotateCcw, Share, Square, Trash2 } from 'lucide-react-native';

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
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SettingsGroup, SettingsHeader, SettingsRow } from '@/components/kortix/settings-list';
import { Sheet, type SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { SessionRenameSheet } from '@/components/session/SessionRenameSheet';
import { SessionShareSheet } from '@/components/session/SessionShareSheet';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { haptics } from '@/lib/haptics';
import { projectKeys, useProjectSessions } from '@/lib/projects/hooks';
import {
  deleteProjectSession,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@/lib/projects/projects-client';
import {
  filterSessionsByTitle,
  groupSessionsByActivity,
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusLabel,
  shortRelative,
  spokenRelative,
} from '@/lib/session/session-list';
import { cn } from '@/lib/utils/index';
import { THEME } from '@/lib/utils/theme';
import { useTabStore } from '@/stores/tab-store';

/** Relative times ("5m") re-render on this interval so they do not freeze. */
const NOW_TICK_MS = 60_000;

// ── Row ──────────────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: ProjectSession;
  now: number;
  /** First row of its group: rounded top, no separator above. */
  first: boolean;
  /** Last row of its group: rounded bottom. */
  last: boolean;
  onOpen: (session: ProjectSession) => void;
  onActions: (session: ProjectSession) => void;
}

/**
 * A group is a borderless rounded card like `SettingsGroup`, split into one
 * surface per row so the list stays virtualised. Row values match
 * `SettingsRow`: `px-4 py-3` (py one step below px), 20pt leading slot, one-line label.
 */
const SessionRow = React.memo(function SessionRow({
  session,
  now,
  first,
  last,
  onOpen,
  onActions,
}: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  const status = sessionDisplayStatus(session);
  const lastActivity = sessionLastActivityAt(session);
  const time = shortRelative(lastActivity, now);

  return (
    <View
      className={cn('overflow-hidden bg-card', first && 'rounded-t-2xl', last && 'rounded-b-2xl')}>
      {first ? null : <Separator />}
      <Pressable
        onPress={() => onOpen(session)}
        onLongPress={() => onActions(session)}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${sessionStatusLabel(status)}, ${spokenRelative(lastActivity, now)}`}
        accessibilityHint="Opens the session"
        accessibilityActions={[{ name: 'activate' }, { name: 'longpress', label: 'Session actions' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'longpress') onActions(session);
          else onOpen(session);
        }}
        className="flex-row items-center px-4 py-3 active:bg-accent">
        <View className="mr-3">
          <SessionStatusMark status={status} />
        </View>
        <Text className="flex-1 text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="muted" className="ml-3 tabular-nums">
          {time}
        </Text>
      </Pressable>
    </View>
  );
});

// ── Page ─────────────────────────────────────────────────────────────────────

type SheetAction = 'rename' | 'share' | 'delete';
type EditTarget = { kind: 'rename' | 'share'; session: ProjectSession };

interface SessionSection {
  key: string;
  title: string;
  data: ProjectSession[];
}

export function ProjectSessionsPage() {
  const { projectId, openDrawer } = useProjectRoute();
  // Opens a row's session once; also replaces this page with the view when a
  // session opens without a row tap (drawer row, notification, deep link).
  const openSession = useCoveringRoute();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const toast = useToast();
  const queryClient = useQueryClient();

  // Poll for provisioning rows only while this page is on top.
  const sessionsQuery = useProjectSessions(projectId, { poll: isFocused });
  const allSessions = React.useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  // No haptic on a row tap: ProjectScreen's open handler fires the one tap.

  // ── Clock for grouping and relative time ──
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);
  React.useEffect(() => {
    setNow(Date.now());
  }, [sessionsQuery.dataUpdatedAt]);

  // ── Search and grouping ──
  const [query, setQuery] = React.useState('');
  const hasSessions = allSessions.length > 0;
  React.useEffect(() => {
    // Nothing left to search: leave no hidden query behind.
    if (!hasSessions && query) setQuery('');
  }, [hasSessions, query]);

  const filtered = React.useMemo(
    () => filterSessionsByTitle(allSessions, query),
    [allSessions, query]
  );
  const grouped = React.useMemo(() => groupSessionsByActivity(filtered, now), [filtered, now]);
  const sections = React.useMemo<SessionSection[]>(
    () =>
      grouped.sections.map((section) => ({
        key: section.id,
        title: section.label,
        data: section.sessions,
      })),
    [grouped]
  );

  // ── Refresh ──
  const invalidateSessions = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) }),
    [queryClient, projectId]
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await sessionsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [sessionsQuery]);

  // ── Action sheet ──
  const actionSheetRef = React.useRef<SheetRef>(null);
  const [menuSession, setMenuSession] = React.useState<ProjectSession | null>(null);
  // Set before the sheet closes; read when its close animation ends.
  const afterCloseRef = React.useRef<SheetAction | null>(null);

  const openActions = React.useCallback((session: ProjectSession) => {
    haptics.medium();
    setMenuSession(session);
  }, []);

  React.useEffect(() => {
    if (menuSession) actionSheetRef.current?.open();
  }, [menuSession]);

  // Rename and Share reuse the session sheets. The target is set first and
  // the sheet presents after that render, so it seeds from this session.
  const renameSheetRef = React.useRef<BottomSheetModal>(null);
  const shareSheetRef = React.useRef<BottomSheetModal>(null);
  const [editTarget, setEditTarget] = React.useState<EditTarget | null>(null);
  React.useEffect(() => {
    if (!editTarget) return;
    const ref = editTarget.kind === 'rename' ? renameSheetRef : shareSheetRef;
    ref.current?.present();
  }, [editTarget]);
  // The live row, so a refetch while a sheet is open reaches it.
  const editSession = editTarget
    ? (allSessions.find((s) => s.session_id === editTarget.session.session_id) ??
      editTarget.session)
    : null;

  const [confirmDelete, setConfirmDelete] = React.useState<ProjectSession | null>(null);
  // The title of the last delete target. It is not cleared on close, so the
  // dialog keeps its text while its close animation runs.
  const [deleteTitle, setDeleteTitle] = React.useState('');
  const [deleteFailed, setDeleteFailed] = React.useState(false);

  const handleSheetDismiss = React.useCallback(() => {
    const session = menuSession;
    const next = afterCloseRef.current;
    afterCloseRef.current = null;
    setMenuSession(null);
    if (!session || !next) return;
    if (next === 'delete') {
      setDeleteFailed(false);
      setDeleteTitle(sessionDisplayTitle(session));
      setConfirmDelete(session);
    } else {
      setEditTarget({ kind: next, session });
    }
  }, [menuSession]);

  const closeSheetThen = React.useCallback((action: SheetAction) => {
    afterCloseRef.current = action;
    actionSheetRef.current?.close();
  }, []);

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
    actionSheetRef.current?.close();
    void runLifecycle(menuSession, 'restart', restartProjectSession, {
      success: 'Session restarting',
      failure: 'Unable to restart the session. Try again.',
    });
  }, [menuSession, runLifecycle]);

  const handleStop = React.useCallback(() => {
    if (!menuSession) return;
    haptics.tap();
    actionSheetRef.current?.close();
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
      // Mirrors ProjectScreen's delete: drop the session's tab, so the store
      // never points at a deleted session and no dead tab survives.
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

  // ── Render ──
  const renderItem = React.useCallback<SectionListRenderItem<ProjectSession, SessionSection>>(
    ({ item, index, section }) => (
      <SessionRow
        session={item}
        now={now}
        first={index === 0}
        last={index === section.data.length - 1}
        onOpen={openSession}
        onActions={openActions}
      />
    ),
    [now, openSession, openActions]
  );

  const showHeaders = grouped.showHeaders;
  const renderSectionHeader = React.useCallback(
    ({ section }: { section: SessionSection }) =>
      showHeaders ? (
        <Text
          variant="muted"
          accessibilityRole="header"
          className="mb-2 px-4"
          style={section.key === sections[0]?.key ? undefined : { marginTop: 18 }}>
          {section.title}
        </Text>
      ) : null,
    [showHeaders, sections]
  );

  const loading = sessionsQuery.isLoading;
  const loadFailed = sessionsQuery.isError && !hasSessions;
  const emptyMessage = loadFailed
    ? 'Unable to load sessions. Pull to refresh.'
    : !hasSessions
      ? 'No sessions yet'
      : 'No matching sessions';

  const menuStatus = menuSession ? sessionDisplayStatus(menuSession) : null;
  const canManageLifecycle = menuSession?.can_manage_lifecycle !== false;
  const canManageSharing = menuSession?.can_manage_sharing !== false;

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title="Sessions" largeTitle gutter="project" onOpenMenu={openDrawer} />

      {loading ? (
        <View className="flex-1 items-center justify-center" style={{ paddingBottom: insets.bottom }}>
          <KortixLoader />
        </View>
      ) : (
        <>
          {hasSessions ? (
            <SearchListHeader
              value={query}
              onChangeText={setQuery}
              placeholder="Search sessions"
              inputProps={{ accessibilityLabel: 'Search sessions' }}
            />
          ) : null}
          <SectionList
            sections={sections}
            keyExtractor={(session) => session.session_id}
            renderItem={renderItem}
            renderSectionHeader={renderSectionHeader}
            stickySectionHeadersEnabled={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            initialNumToRender={20}
            style={{ flex: 1 }}
            contentContainerStyle={{
              flexGrow: 1,
              paddingHorizontal: 16,
              paddingTop: 4,
              paddingBottom: insets.bottom + 28,
            }}
            ListEmptyComponent={
              <View className="flex-1 items-center justify-center px-8">
                <Text variant="muted" className="text-center">
                  {emptyMessage}
                </Text>
              </View>
            }
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
              />
            }
          />
        </>
      )}

      <Sheet ref={actionSheetRef} enablePanDownToClose onDismiss={handleSheetDismiss}>
        {menuSession ? (
          <View
            className="px-5 pt-1"
            style={{ gap: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
            <Text variant="large" accessibilityRole="header" className="px-1" numberOfLines={1}>
              {sessionDisplayTitle(menuSession)}
            </Text>
            <SettingsGroup>
              <SettingsRow icon={Pencil} label="Rename" onPress={() => closeSheetThen('rename')} />
              {canManageSharing ? (
                <SettingsRow icon={Share} label="Share" onPress={() => closeSheetThen('share')} />
              ) : null}
              {canManageLifecycle ? (
                <SettingsRow icon={RotateCcw} label="Restart" right={null} onPress={handleRestart} />
              ) : null}
              {canManageLifecycle && menuStatus === 'running' ? (
                <SettingsRow icon={Square} label="Stop" right={null} onPress={handleStop} />
              ) : null}
              {canManageLifecycle ? (
                <SettingsRow
                  icon={Trash2}
                  label="Delete"
                  destructive
                  right={null}
                  onPress={() => {
                    haptics.warning();
                    closeSheetThen('delete');
                  }}
                />
              ) : null}
            </SettingsGroup>
          </View>
        ) : null}
      </Sheet>

      <SessionRenameSheet
        ref={renameSheetRef}
        projectId={projectId}
        session={editTarget?.kind === 'rename' ? editSession : null}
      />
      <SessionShareSheet
        ref={shareSheetRef}
        projectId={projectId}
        session={editTarget?.kind === 'share' ? editSession : null}
      />

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
    </View>
  );
}
