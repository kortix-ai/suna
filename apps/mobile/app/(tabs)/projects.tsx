/**
 * Projects tab — post-login landing, reskinned to the web design system.
 *
 * Repo-first model: lists projects for the current account (GET /accounts +
 * GET /projects?account_id=). Data wiring is ported verbatim from the
 * original `app/projects/index.tsx` (now retired) — only the presentation
 * layer changed (tokens + shared primitives instead of inline hex).
 */

import * as React from 'react';
import { Animated, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertCircle, MoreVertical, Plus, Search, Sparkles } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/kortix/avatar';
import { Button } from '@/components/ui/button';
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { EmptyState } from '@/components/shared/EmptyState';
import { AccountSwitcherSheet } from '@/components/projects/AccountSwitcherSheet';
import { NewProjectSheet } from '@/components/projects/NewProjectSheet';
import { ProjectActions } from '@/components/projects/ProjectActions';
import { PlatformButton } from '@/components/kortix/platform-button';
import { SearchHeader } from '@/components/kortix/search-header';
import {
  TAB_SCROLL_INSET_ADJUSTMENT,
  useTabBarClearance,
} from '@/components/navigation/tab-bar-layout';
import { useAuthContext } from '@/contexts';
import { useAccounts, useProjects } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';
import { useAccountState, accountStateSelectors } from '@/lib/billing/hooks';
import { haptics } from '@/lib/haptics';
import { projectToRow } from '@/lib/ui/format';
import { chalkColors } from '@kortix/shared';
import type { KortixProject } from '@/lib/projects/projects-client';
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

export default function ProjectsTab() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { user } = useAuthContext();
  const tabBarClearance = useTabBarClearance();

  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const openUpgradeSheet = useUpgradeSheetStore((s) => s.openUpgradeSheet);
  const [query, setQuery] = React.useState('');
  // Search mode swaps the header row for the search field + Cancel.
  const [searchOpen, setSearchOpen] = React.useState(false);
  const closeSearch = React.useCallback(() => {
    setQuery('');
    setSearchOpen(false);
  }, []);
  const [accountSheetOpen, setAccountSheetOpen] = React.useState(false);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const accountsQuery = useAccounts(!!user);

  // Keep the selected account valid — fall back to the first account if the
  // persisted selection no longer exists (e.g. removed, or first launch).
  React.useEffect(() => {
    const accounts = accountsQuery.data;
    if (!accounts) return;
    const exists = accounts.some((a) => a.account_id === selectedAccountId);
    const next = exists ? selectedAccountId : (accounts[0]?.account_id ?? null);
    if (next !== selectedAccountId) setSelectedAccountId(next);
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId]);

  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;
  const activeAccountId = activeAccount?.account_id ?? null;

  const projectsQuery = useProjects(activeAccountId);

  // Free-tier users get an Upgrade CTA that opens the global upgrade sheet.
  // Gate on a loaded account state so paid users never see it flash.
  const accountStateQuery = useAccountState({
    accountId: activeAccountId ?? undefined,
    enabled: !!activeAccountId,
  });
  const tierKey = accountStateSelectors.tierKey(accountStateQuery.data);
  const showUpgrade = !!accountStateQuery.data && (tierKey === 'free' || tierKey === 'none');

  const openUpgrade = React.useCallback(() => {
    haptics.selection();
    openUpgradeSheet({
      reason: 'subscription_required',
      accountId: activeAccountId ?? undefined,
      message: '',
    });
  }, [openUpgradeSheet, activeAccountId]);

  const filtered: KortixProject[] = React.useMemo(() => {
    const items = projectsQuery.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) =>
      [p.name, p.repo_url, p.default_branch].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [projectsQuery.data, query]);

  const total = projectsQuery.data?.length ?? 0;
  const loading = accountsQuery.isLoading || projectsQuery.isLoading;
  const showEmpty = !!activeAccountId && !loading && !projectsQuery.isError && total === 0;
  const showNoResults =
    !!activeAccountId && !loading && !projectsQuery.isError && total > 0 && filtered.length === 0;
  // Search needs something to search: hidden until the account has a project.
  // Archiving the last project while searching leaves search mode.
  const hasProjects = total > 0;
  React.useEffect(() => {
    if (!hasProjects && searchOpen) closeSearch();
  }, [hasProjects, searchOpen, closeSearch]);

  const openProject = React.useCallback(
    (p: KortixProject) => router.push(`/projects/${p.project_id}`),
    [router],
  );

  const canCreate =
    activeAccount?.account_role === 'owner' || activeAccount?.account_role === 'admin';
  const accountCount = accountsQuery.data?.length ?? 0;

  // Row ⋯ menu: a bottom sheet of actions (Open, Archive) with an
  // AlertDialog confirm for Archive. See components/projects/ProjectActions.
  const [menuProject, setMenuProject] = React.useState<KortixProject | null>(null);
  const onRowMenu = React.useCallback((p: KortixProject) => {
    haptics.selection();
    setMenuProject(p);
  }, []);
  const closeRowMenu = React.useCallback(() => setMenuProject(null), []);

  const handleCreated = React.useCallback(
    (project: KortixProject) => {
      setNewProjectOpen(false);
      router.push(`/projects/${project.project_id}`);
    },
    [router],
  );

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const tasks: Promise<unknown>[] = [accountsQuery.refetch()];
      if (activeAccountId) tasks.push(projectsQuery.refetch());
      await Promise.all(tasks);
    } finally {
      setRefreshing(false);
    }
  }, [accountsQuery, projectsQuery, activeAccountId]);

  const renderItem = React.useCallback(
    ({ item }: { item: KortixProject }) => {
      const row = projectToRow(item);
      const chalk = chalkColors(item.name);
      return (
        <Pressable
          onPress={() => openProject(item)}
          style={({ pressed }) => (pressed ? { transform: [{ scale: 0.99 }] } : undefined)}
          className="mx-4 mb-2.5 flex-row items-center gap-3 rounded-xl bg-secondary/70 px-4 py-3.5 active:bg-secondary">
          <Avatar
            variant="custom"
            fallbackText={item.name}
            size={42}
            backgroundColor={chalk.background}
            iconColor={chalk.foreground}
            borderColor={chalk.border}
          />
          <View className="min-w-0 flex-1">
            <Text variant="small" className="text-foreground" numberOfLines={1}>
              {row.title}
            </Text>
            <Text variant="muted" className="mt-0.5 text-xs" numberOfLines={1}>
              {row.subtitle}
            </Text>
          </View>
          <Pressable
            onPress={() => onRowMenu(item)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            className="p-1">
            <Icon as={MoreVertical} size={18} className="text-muted-foreground" strokeWidth={2.2} />
          </Pressable>
        </Pressable>
      );
    },
    [onRowMenu, openProject],
  );

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
              placeholder="Search projects"
            />
          ) : (
          <>
          <View className="min-w-0 flex-1 flex-row items-center">
            <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
          </View>

          <View className="flex-row items-center gap-2">
            {showUpgrade && (
              <Button variant="secondary" size="sm" onPress={openUpgrade}>
                <Icon as={Sparkles} size={15} className="text-kortix-blue" strokeWidth={2.4} />
                <Text className="font-medium text-sm">Upgrade</Text>
              </Button>
            )}
            {/* Search: icon-size button that switches the header to search mode. */}
            {hasProjects && (
              <PlatformButton
                systemImage="magnifyingglass"
                icon={Search}
                fallbackVariant="secondary"
                accessibilityLabel="Search projects"
                onPress={() => {
                  haptics.selection();
                  setSearchOpen(true);
                }}
              />
            )}
            {/* New: native SwiftUI button on iOS, design-system pill on Android. */}
            {canCreate && (
              <PlatformButton
                label="New"
                systemImage="plus"
                icon={Plus}
                accessibilityLabel="New project"
                onPress={() => {
                  haptics.selection();
                  setNewProjectOpen(true);
                }}
              />
            )}
          </View>
          </>
          )}
        </View>
      </SafeAreaView>

      {loading ? (
        <ScrollView
          contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarClearance }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />}>
          <View className="flex-1 px-4 pt-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </View>
        </ScrollView>
      ) : projectsQuery.isError ? (
        <ScrollView
          contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarClearance }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />}>
          <View className="flex-1 px-4 pt-4">
            <EmptyState
              icon={AlertCircle}
              title="Couldn't load projects"
              description={(projectsQuery.error as Error)?.message ?? 'Check your connection and try again.'}
              actionLabel="Retry"
              onActionPress={() => onRefresh()}
            />
          </View>
        </ScrollView>
      ) : showEmpty ? (
        <ScrollView
          contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarClearance }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />}>
          {/* Plain page: no card, no icon, no description — title and one pill,
              centred in the space between the header and the tab bar. */}
          <View className="flex-1 items-center justify-center gap-6 px-8">
            <Text variant="large">No projects yet</Text>
            {canCreate && (
              <Button
                size="lg"
                className="rounded-full"
                onPress={() => {
                  haptics.selection();
                  setNewProjectOpen(true);
                }}>
                <Text>Create project</Text>
              </Button>
            )}
          </View>
        </ScrollView>
      ) : showNoResults ? (
        <ScrollView
          contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarClearance }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />}>
          <View className="flex-1 px-4 pt-4">
            <EmptyState
              icon={Search}
              title={`No matches for "${query.trim()}"`}
              description="Try a different search term"
            />
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.project_id}
          renderItem={renderItem}
          contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: tabBarClearance }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />}
          keyboardShouldPersistTaps="handled"
        />
      )}

      {accountSheetOpen ? (
        <AccountSwitcherSheet
          open
          accounts={accountsQuery.data ?? []}
          selectedAccountId={activeAccountId}
          onSelect={(id) => setSelectedAccountId(id)}
          onClose={() => setAccountSheetOpen(false)}
        />
      ) : null}

      <ProjectActions project={menuProject} onOpenProject={openProject} onClose={closeRowMenu} />

      {newProjectOpen ? (
        <NewProjectSheet
          open
          accountId={activeAccountId}
          onClose={() => setNewProjectOpen(false)}
          onCreated={handleCreated}
        />
      ) : null}
    </View>
  );
}
