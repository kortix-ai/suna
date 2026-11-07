/**
 * Workspaces — `/projects`, every workspace the user belongs to as ONE flat
 * list (Workspaces ux.md §1: no per-account grouping; a legacy account with
 * several projects shows each as its own row), a plain root-stack page.
 * The app never lands here on its own: app start opens the last workspace,
 * or `/new` (create or join) when there is none (`app/index.tsx`). It is
 * reached from the start screen's failure state (All workspaces) and after a
 * workspace is archived; the drawer's switcher sheet
 * (`ProjectSwitcherSheet`) is the everyday way between workspaces.
 *
 * Pending invitations show first. With no workspace and no invitation the
 * page hands over to `/new`, the create-or-join screen: never an empty list.
 * Search shows at 8+ rows (`shouldShowWorkspacePageSearch`).
 */

import * as React from 'react';
import { Animated, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import {
  WarningCircleIcon as AlertCircle,
  DotsThreeVerticalIcon as MoreVertical,
  PlusIcon as Plus,
  MagnifyingGlassIcon as Search,
} from '@/lib/icons';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { EmptyState } from '@/components/shared/EmptyState';
import { useWebCreateHandoff } from '@/components/projects/useWebCreateHandoff';
import { WebHandoffSheet } from '@/components/session/WebHandoffSheet';
import type { SheetRef } from '@/components/kortix/sheet';
import { ProjectActions } from '@/components/projects/ProjectActions';
import { PlatformButton } from '@/components/kortix/platform-button';
import { SearchHeader } from '@/components/kortix/search-header';
import { useAuthContext, useLanguage } from '@/contexts';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { useMyInvites } from '@/lib/invites/hooks';
import { inviteHref } from '@/lib/invites/invite-landing';
import { useWorkspaceStateAction, useWorkspaces } from '@/lib/projects/hooks';
import {
  filterWorkspaceRows,
  projectHref,
  shouldShowWorkspacePageSearch,
  type WorkspaceRow,
} from '@/lib/projects/switcher';
import { isOpenableWorkspaceRow } from '@/lib/projects/switcher';
import { newWorkspaceWebUrl } from '@/lib/projects/web-project-links';
import type { KortixProject } from '@/lib/projects/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { WorkspaceInvitations } from '@/components/projects/WorkspaceInvitations';
import { haptics } from '@/lib/haptics';
import { projectToRow } from '@/lib/ui/format';
import { THEME } from '@/lib/utils/theme';

function SkeletonRow() {
  const opacity = React.useRef(new Animated.Value(0.5)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ opacity }} className="mb-2 h-14 rounded-md bg-primary/10" />;
}

/** Scroll content never adjusts for the safe area itself: the header pads the top, `bottomPadding` the bottom. */
const SCROLL_INSET_ADJUSTMENT = 'never';

export default function ProjectsPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { user } = useAuthContext();
  // The last row clears the home indicator by 24pt.
  const bottomPadding = useSafeAreaInsets().bottom + 24;

  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);
  const [query, setQuery] = React.useState('');
  // Search mode swaps the header row for the search field + Cancel.
  const [searchOpen, setSearchOpen] = React.useState(false);
  const closeSearch = React.useCallback(() => {
    setQuery('');
    setSearchOpen(false);
  }, []);
  const createHandoffRef = React.useRef<SheetRef>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const workspaces = useWorkspaces(!!user);
  const invitesQuery = useMyInvites(!!user);
  const invites = invitesQuery.data ?? [];

  const filtered: WorkspaceRow[] = React.useMemo(
    () => filterWorkspaceRows(workspaces.rows, query),
    [workspaces.rows, query],
  );

  const total = workspaces.rows.length;
  // Not loaded yet — in flight, or paused offline (`isPending`, not
  // `isLoading`) — is never the empty state.
  const loading = total === 0 && workspaces.isPending;
  const failed = total === 0 && !loading && workspaces.isError;
  const empty = !loading && !failed && total === 0;
  const showNoResults = total > 0 && filtered.length === 0;
  // Search needs something to search: shown from 8 rows (ux.md §1).
  // Archiving rows while searching can leave search mode.
  const canSearch = shouldShowWorkspacePageSearch(total);
  React.useEffect(() => {
    if (!canSearch && searchOpen) closeSearch();
  }, [canSearch, searchOpen, closeSearch]);

  // No workspace and no invitation: the create-or-join screen, never an
  // empty list. Wait for the invite list so an invitee keeps the Join rows.
  const inviteListSettled = !invitesQuery.isPending;
  React.useEffect(() => {
    if (empty && inviteListSettled && invites.length === 0) router.replace('/new');
  }, [empty, inviteListSettled, invites.length, router]);

  // A workspace replaces the list, never stacks on it: back from it must not
  // return here.
  const openWorkspace = React.useCallback(
    (p: KortixProject) => {
      if (p.account_id) setSelectedAccountId(p.account_id);
      router.replace(projectHref(p.project_id));
    },
    [router, setSelectedAccountId],
  );
  const openInvite = React.useCallback(
    (inviteId: string) => {
      haptics.selection();
      router.push(inviteHref(inviteId));
    },
    [router],
  );

  // Row ⋯ menu: a bottom sheet of actions (Open, Archive) with an
  // AlertDialog confirm for Archive. See components/projects/ProjectActions.
  const [menuProject, setMenuProject] = React.useState<KortixProject | null>(null);
  const onRowMenu = React.useCallback((p: KortixProject) => {
    haptics.selection();
    setMenuProject(p);
  }, []);
  const closeRowMenu = React.useCallback(() => setMenuProject(null), []);

  // Create workspace: web `/new` (KRTX-246). The workspace that did not
  // exist before opens.
  const webCreate = useWebCreateHandoff();
  const runCreateHandoff = React.useCallback(async () => {
    const { project } = await webCreate.open(newWorkspaceWebUrl(KORTIX_WEB_URL));
    if (project) openWorkspace(project);
  }, [webCreate, openWorkspace]);
  const openCreate = React.useCallback(() => {
    haptics.selection();
    createHandoffRef.current?.open();
  }, []);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([workspaces.refetch(), invitesQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [workspaces, invitesQuery]);

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
    />
  );

  const stateAction = useWorkspaceStateAction();
  const renderItem = React.useCallback(
    ({ item }: { item: WorkspaceRow }) => {
      const row = projectToRow(item.project);
      // Set up (it pays, no repository yet) or Restore (deleted, inside its
      // restore window): the row opens nothing until the action ran.
      if (!isOpenableWorkspaceRow(item)) {
        const deleting = item.state === 'deleting';
        const busy = stateAction.isPending && stateAction.variables?.workspaceId === item.project.project_id;
        return (
          <PressableSurface
            disabled={stateAction.isPending}
            onPress={() =>
              stateAction.mutate(
                { workspaceId: item.project.project_id, state: deleting ? 'deleting' : 'setup_required' },
                { onSuccess: () => openWorkspace(item.project) },
              )
            }
            accessibilityRole="button"
            style={({ pressed }) => (pressed ? { transform: [{ scale: 0.99 }] } : undefined)}
            className="mx-4 mb-2.5 flex-row items-center gap-3 rounded-xl bg-secondary/70 px-4 py-3.5 active:bg-secondary">
            <Avatar chalk fallbackText={item.project.name} size={42} />
            <View className="min-w-0 flex-1">
              <Text variant="small" className="leading-5 text-muted-foreground" numberOfLines={1}>
                {row.title}
              </Text>
              <Text variant="muted" className="mt-0.5 text-xs" numberOfLines={1}>
                {deleting
                  ? t('workspace.deletingOn', {
                      defaultValue: 'Deleting on {{date}}',
                      date: item.deletionScheduledFor ? new Date(item.deletionScheduledFor).toLocaleDateString() : '',
                    })
                  : t('workspace.setupRequired', 'Paid, no repository yet')}
              </Text>
            </View>
            <Text variant="small" className="text-foreground">
              {busy ? '…' : deleting ? t('workspace.restore', 'Restore') : t('workspace.setUp', 'Set up')}
            </Text>
          </PressableSurface>
        );
      }
      return (
        <PressableSurface
          onPress={() => openWorkspace(item.project)}
          // The row is one accessibility element, which hides the ⋯ button
          // inside it from VoiceOver/TalkBack; expose the menu as an action.
          accessibilityRole="button"
          accessibilityActions={[{ name: 'menu', label: t('workspace.actions', 'Workspace actions') }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'menu') onRowMenu(item.project);
          }}
          style={({ pressed }) => (pressed ? { transform: [{ scale: 0.99 }] } : undefined)}
          className="mx-4 mb-2.5 flex-row items-center gap-3 rounded-xl bg-secondary/70 px-4 py-3.5 active:bg-secondary">
          <Avatar chalk fallbackText={item.project.name} size={42} />
          <View className="min-w-0 flex-1">
            <Text variant="small" className="leading-5 text-foreground" numberOfLines={1}>
              {row.title}
            </Text>
            <Text variant="muted" className="mt-0.5 text-xs" numberOfLines={1}>
              {row.subtitle}
            </Text>
          </View>
          <Pressable
            onPress={() => onRowMenu(item.project)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('workspace.actionsNamed', {
              defaultValue: 'Workspace actions, {{workspace}}',
              workspace: item.project.name,
            })}
            className="p-1">
            <Icon as={MoreVertical} size={18} className="text-muted-foreground" />
          </Pressable>
        </PressableSurface>
      );
    },
    [onRowMenu, openWorkspace, t, stateAction],
  );

  const invitationsHeader =
    invites.length > 0 ? (
      <View className="px-4 pb-4">
        <WorkspaceInvitations invites={invites} onOpenInvite={openInvite} />
      </View>
    ) : undefined;

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-background">
        {/* Same row height in both modes (40pt controls + py-3.5), so the list
            below never jumps when search opens or closes. */}
        <View className="flex-row items-center justify-between px-4 py-3.5">
          {searchOpen ? (
            <SearchHeader
              value={query}
              onChangeText={setQuery}
              onCancel={closeSearch}
              placeholder={t('workspace.search', 'Search workspaces')}
            />
          ) : (
          <>
          <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
            <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
            <Text variant="small" numberOfLines={1}>
              {t('workspace.switcherTitle', 'Workspaces')}
            </Text>
          </View>

          <View className="flex-row items-center gap-2">
            {/* Search: icon-size button that switches the header to search mode. */}
            {canSearch && (
              <PlatformButton
                systemImage="magnifyingglass"
                icon={Search}
                fallbackVariant="secondary"
                accessibilityLabel={t('workspace.search', 'Search workspaces')}
                onPress={() => {
                  haptics.selection();
                  setSearchOpen(true);
                }}
              />
            )}
            {/* New: native SwiftUI button on iOS, design-system pill on Android. */}
            <PlatformButton
              label={t('common.new', 'New')}
              systemImage="plus"
              icon={Plus}
              accessibilityLabel={t('workspace.create', 'Create workspace')}
              disabled={webCreate.pending}
              onPress={openCreate}
            />
          </View>
          </>
          )}
        </View>
      </SafeAreaView>

      {loading ? (
        <ScrollView
          contentInsetAdjustmentBehavior={SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: bottomPadding }}
          refreshControl={refreshControl}>
          <View className="flex-1 px-4 pt-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </View>
        </ScrollView>
      ) : failed ? (
        <ScrollView
          contentInsetAdjustmentBehavior={SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: bottomPadding }}
          refreshControl={refreshControl}>
          <View className="flex-1 px-4 pt-4">
            <EmptyState
              icon={AlertCircle}
              title={t('workspace.loadFailed', "Couldn't load workspaces")}
              description={t('workspace.loadFailedBody', 'Check your connection and try again.')}
              actionLabel={t('common.retry', 'Try again')}
              onActionPress={() => onRefresh()}
            />
          </View>
        </ScrollView>
      ) : showNoResults ? (
        <ScrollView
          contentInsetAdjustmentBehavior={SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: bottomPadding }}
          refreshControl={refreshControl}>
          <View className="flex-1 px-4 pt-4">
            <EmptyState
              icon={Search}
              title={t('workspace.noMatches', { defaultValue: 'No matches for "{{query}}"', query: query.trim() })}
              description={t('workspace.noMatchesBody', 'Try a different search term')}
            />
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.project.project_id}
          renderItem={renderItem}
          ListHeaderComponent={invitationsHeader}
          contentInsetAdjustmentBehavior={SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: bottomPadding }}
          refreshControl={refreshControl}
          keyboardShouldPersistTaps="handled"
        />
      )}

      <ProjectActions project={menuProject} onOpenProject={openWorkspace} onClose={closeRowMenu} />

      <WebHandoffSheet
        ref={createHandoffRef}
        title={t('workspace.createOnWebTitle', 'Create a workspace on the web')}
        line={t('workspace.createOnWebLine', 'Workspaces are created on kortix.com.')}
        run={runCreateHandoff}
      />
    </View>
  );
}
