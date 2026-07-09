/**
 * Projects tab — post-login landing, reskinned to the web design system.
 *
 * Repo-first model: lists projects for the current account (GET /accounts +
 * GET /projects?account_id=). Data wiring is ported verbatim from the
 * original `app/projects/index.tsx` (now retired) — only the presentation
 * layer changed (tokens + shared primitives instead of inline hex).
 */

import * as React from 'react';
import { Alert, Animated, FlatList, Platform, Pressable, RefreshControl, ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertCircle, FolderPlus, MoreVertical, Plus, Search, X } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/button';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { EmptyState } from '@/components/shared/EmptyState';
import { useToast } from '@/components/ui/toast-provider';
import { AccountSwitcherSheet } from '@/components/projects/AccountSwitcherSheet';
import { NewProjectSheet } from '@/components/projects/NewProjectSheet';
import { AccountMenuSheet } from '@/components/projects/AccountMenuSheet';
import { useAuthContext } from '@/contexts';
import { useAccounts, useArchiveProject, useProjects } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { haptics } from '@/lib/haptics';
import { projectToRow } from '@/lib/ui/format';
import { chalkColors } from '@kortix/shared';
import type { KortixProject } from '@/lib/projects/projects-client';

/** Muted tint for pull-to-refresh spinners — matches the original's `subtle` token. */
const REFRESH_TINT_COLOR = '#9A9A9A';

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
  const toast = useToast();
  const { user, signOut, isSigningOut } = useAuthContext();

  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [query, setQuery] = React.useState('');
  const [accountSheetOpen, setAccountSheetOpen] = React.useState(false);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const accountsQuery = useAccounts(!!user);
  const archive = useArchiveProject();

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
  const showSearch = total > 3;

  const openProject = React.useCallback(
    (p: KortixProject) => router.push(`/projects/${p.project_id}`),
    [router],
  );

  const canCreate =
    activeAccount?.account_role === 'owner' || activeAccount?.account_role === 'admin';
  const accountCount = accountsQuery.data?.length ?? 0;

  const confirmArchive = React.useCallback(
    (p: KortixProject) => {
      Alert.alert('Archive project', `Archive "${p.name}"?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            try {
              haptics.medium();
              await archive.mutateAsync(p.project_id);
              haptics.success();
              toast.success('Project archived');
            } catch (e: any) {
              haptics.warning();
              toast.error(e?.message || 'Failed to archive project');
            }
          },
        },
      ]);
    },
    [archive, toast],
  );

  // Row overflow menu — replaces the old long-press gesture (which doesn't
  // compose cleanly with the shared ListRow's own Pressable) with a tap
  // target that opens the same Open/Archive/Cancel action sheet.
  const onRowMenu = React.useCallback(
    (p: KortixProject) => {
      const canManage = p.effective_project_role === 'editor' || !p.effective_project_role;
      const buttons: any[] = [{ text: 'Open', onPress: () => openProject(p) }];
      if (canManage) buttons.push({ text: 'Archive', style: 'destructive', onPress: () => confirmArchive(p) });
      buttons.push({ text: 'Cancel', style: 'cancel' });
      haptics.selection();
      Alert.alert(p.name, undefined, buttons);
    },
    [openProject, confirmArchive],
  );

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

  const handleSignOut = React.useCallback(() => {
    Alert.alert('Sign out', 'Sign out of Kortix?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          setAccountMenuOpen(false);
          await signOut();
        },
      },
    ]);
  }, [signOut]);

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
        <View className="flex-row items-center justify-between px-4 py-3.5">
          <View className="min-w-0 flex-1 flex-row items-center">
            <KortixLogo variant="logomark" size={18} color={isDark ? 'dark' : 'light'} />
          </View>

          <View className="flex-row items-center gap-2">
            {canCreate && (
              <Button
                variant="default"
                size="sm"
                onPress={() => {
                  haptics.selection();
                  setNewProjectOpen(true);
                }}>
                <Icon as={Plus} size={15} className="text-primary-foreground" strokeWidth={2.4} />
                <Text className="font-medium text-sm">New</Text>
              </Button>
            )}
            <TouchableOpacity
              onPress={() => {
                haptics.selection();
                setAccountMenuOpen(true);
              }}
              activeOpacity={0.85}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              className="h-8 w-8 items-center justify-center rounded-full bg-foreground/10">
              <Text className="font-semibold text-sm text-foreground">
                {(user?.email?.trim()?.[0] || '?').toUpperCase()}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {showSearch && (
        <View className="mx-4 mt-3 h-11 flex-row items-center rounded-md bg-foreground/[0.06] px-3">
          <Icon as={Search} size={16} className="text-muted-foreground" strokeWidth={2.2} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search projects"
            placeholderTextColor="hsl(var(--muted-foreground) / 0.6)"
            className="ml-2 flex-1 text-foreground"
            style={{ fontSize: 15 }}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Icon as={X} size={16} className="text-muted-foreground" strokeWidth={2.2} />
            </Pressable>
          )}
        </View>
      )}

      {loading ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={REFRESH_TINT_COLOR} />}>
          <View className="flex-1 px-4 pt-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </View>
        </ScrollView>
      ) : projectsQuery.isError ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={REFRESH_TINT_COLOR} />}>
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
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={REFRESH_TINT_COLOR} />}>
          <View className="flex-1 px-4 pt-4">
            <EmptyState
              icon={FolderPlus}
              title="No projects yet"
              description="A project is a dedicated space for one company, product, or idea."
              actionLabel={canCreate ? 'Create your first project' : undefined}
              onActionPress={
                canCreate
                  ? () => {
                      haptics.selection();
                      setNewProjectOpen(true);
                    }
                  : undefined
              }
            />
          </View>
        </ScrollView>
      ) : showNoResults ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={REFRESH_TINT_COLOR} />}>
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
          contentContainerStyle={{ paddingTop: 12, paddingBottom: Platform.OS === 'android' ? 110 : 28 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={REFRESH_TINT_COLOR} />}
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

      {newProjectOpen ? (
        <NewProjectSheet
          open
          accountId={activeAccountId}
          onClose={() => setNewProjectOpen(false)}
          onCreated={handleCreated}
        />
      ) : null}

      {accountMenuOpen ? (
        <AccountMenuSheet
          open
          name={(user?.user_metadata?.full_name as string | undefined) ?? undefined}
          email={user?.email}
          accountName={activeAccount?.name}
          accountId={activeAccountId}
          isSigningOut={isSigningOut}
          onSignOut={handleSignOut}
          onClose={() => setAccountMenuOpen(false)}
        />
      ) : null}
    </View>
  );
}
