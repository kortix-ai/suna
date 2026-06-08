/**
 * Projects screen — post-login landing, ported from web's /projects page.
 *
 * Repo-first model: lists projects for the current account (GET /accounts +
 * GET /projects?account_id=). A compact header (account switcher + New + the
 * account menu) stays fixed; the title, search and list scroll together.
 */

import * as React from 'react';
import { View, ScrollView, RefreshControl, TextInput, Pressable, Alert } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, X, FolderPlus, ChevronDown, Plus, AlertCircle, ChevronRight } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { useToast } from '@/components/ui/toast-provider';
import { AccountSwitcherSheet } from '@/components/projects/AccountSwitcherSheet';
import { NewProjectSheet } from '@/components/projects/NewProjectSheet';
import { AccountMenuSheet } from '@/components/projects/AccountMenuSheet';
import { useAuthContext } from '@/contexts';
import { useAccounts, useArchiveProject, useProjects } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import type { KortixProject } from '@/lib/projects/projects-client';

function relativeTime(input?: string) {
  if (!input) return '';
  const seconds = Math.floor((Date.now() - new Date(input).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function ProjectsScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const toast = useToast();
  const { user, signOut, isSigningOut } = useAuthContext();

  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [query, setQuery] = React.useState('');
  const [accountSheetOpen, setAccountSheetOpen] = React.useState(false);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);

  const accountsQuery = useAccounts(!!user);
  const archive = useArchiveProject();

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

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.04)' : '#FFFFFF';
  const cardBorder = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)';
  const skeletonBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.055)';

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

  const onCardLongPress = React.useCallback(
    (p: KortixProject) => {
      const canManage = p.effective_project_role === 'manager' || !p.effective_project_role;
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

  const [refreshing, setRefreshing] = React.useState(false);
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

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Fixed header */}
      <View
        className="flex-row items-center justify-between"
        style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 10 }}
      >
        <View className="min-w-0 flex-1 flex-row items-center" style={{ gap: 12 }}>
          <KortixLogo variant="symbol" size={28} color={isDark ? 'dark' : 'light'} />
          {!!activeAccount && (
            <Pressable
              onPress={() => {
                haptics.selection();
                setAccountSheetOpen(true);
              }}
              disabled={accountCount < 2}
              className="shrink flex-row items-center"
              style={{ gap: 4 }}
            >
              <Text numberOfLines={1} className="font-roobert-medium text-[13px] text-muted-foreground" style={{ maxWidth: 150 }}>
                {activeAccount.name}
              </Text>
              {accountCount > 1 && <Icon as={ChevronDown} size={14} className="text-muted-foreground" strokeWidth={2.2} />}
            </Pressable>
          )}
        </View>

        <View className="flex-row items-center" style={{ gap: 8 }}>
          {canCreate && (
            <Pressable
              onPress={() => {
                haptics.selection();
                setNewProjectOpen(true);
              }}
              className="flex-row items-center rounded-full active:opacity-90"
              style={{ gap: 6, paddingHorizontal: 14, height: 36, backgroundColor: theme.primary }}
            >
              <Icon as={Plus} size={16} color={theme.primaryForeground} strokeWidth={2.4} />
              <Text className="font-roobert-medium text-[13px]" style={{ color: theme.primaryForeground }}>
                New
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => {
              haptics.selection();
              setAccountMenuOpen(true);
            }}
            className="items-center justify-center rounded-full active:opacity-85"
            style={{ width: 34, height: 34, backgroundColor: isDark ? '#1f1f22' : '#ECECEC' }}
          >
            <Text className="font-roobert-semibold text-[14px] text-foreground">
              {(user?.email?.trim()?.[0] || '?').toUpperCase()}
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        alwaysBounceVertical
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={subtle} />}
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 48 }}
      >
        {/* Title */}
        <Text className="font-roobert-semibold text-foreground" style={{ fontSize: 28, lineHeight: 36 }}>
          Projects
        </Text>
        <Text className="mt-1 font-roobert text-[14px] text-muted-foreground">
          Your workspaces in one place. Pick up where you left off.
        </Text>

        {/* Search — only once there's enough to search */}
        {showSearch && (
          <View
            className="mt-4 flex-row items-center rounded-2xl"
            style={{ height: 44, paddingHorizontal: 14, backgroundColor: inputBg, borderWidth: 1, borderColor: cardBorder }}
          >
            <Icon as={Search} size={16} className="text-muted-foreground" strokeWidth={2.2} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search projects"
              placeholderTextColor={faint}
              className="ml-2 flex-1"
              style={{ fontSize: 15, fontFamily: 'Roobert', color: fg }}
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

        <View className="mt-5">
          {/* Loading skeletons */}
          {loading && (
            <View className="overflow-hidden rounded-2xl border" style={{ backgroundColor: cardBg, borderColor: cardBorder }}>
              {[0, 1, 2, 3].map((i) => (
                <View
                  key={i}
                  className="flex-row items-center"
                  style={{ paddingHorizontal: 14, paddingVertical: 14, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: cardBorder }}
                >
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: skeletonBg }} />
                  <View className="ml-3 flex-1">
                    <View style={{ height: 13, width: '55%', borderRadius: 6, backgroundColor: skeletonBg }} />
                    <View style={{ height: 11, width: '32%', borderRadius: 6, backgroundColor: skeletonBg, marginTop: 9 }} />
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Error */}
          {projectsQuery.isError && !loading && (
            <View
              className="items-center rounded-2xl border"
              style={{ padding: 20, borderColor: isDark ? 'rgba(248,113,113,0.25)' : 'rgba(220,38,38,0.25)' }}
            >
              <Icon as={AlertCircle} size={22} color={isDark ? '#f87171' : '#dc2626'} />
              <Text className="mt-2 font-roobert-medium text-[15px] text-foreground">Couldn't load projects</Text>
              <Text className="mt-1 text-center font-roobert text-[13px] text-muted-foreground">
                {(projectsQuery.error as Error)?.message ?? 'Check your connection and try again.'}
              </Text>
              <Pressable
                onPress={() => onRefresh()}
                className="mt-3 rounded-full border active:opacity-80"
                style={{ paddingHorizontal: 18, paddingVertical: 9, borderColor: cardBorder }}
              >
                <Text className="font-roobert-medium text-[13px] text-foreground">Retry</Text>
              </Pressable>
            </View>
          )}

          {/* Empty */}
          {showEmpty && (
            <View className="items-center" style={{ paddingVertical: 56 }}>
              <View
                className="items-center justify-center rounded-2xl"
                style={{ width: 56, height: 56, backgroundColor: inputBg, marginBottom: 16 }}
              >
                <Icon as={FolderPlus} size={26} className="text-muted-foreground" strokeWidth={1.8} />
              </View>
              <Text className="font-roobert-semibold text-[17px] text-foreground">No projects yet</Text>
              <Text className="mt-1.5 text-center font-roobert text-[13px] text-muted-foreground" style={{ maxWidth: 260 }}>
                A project is a dedicated space for one company, product, or idea.
              </Text>
              {canCreate && (
                <Pressable
                  onPress={() => {
                    haptics.selection();
                    setNewProjectOpen(true);
                  }}
                  className="mt-5 flex-row items-center rounded-full active:opacity-90"
                  style={{ gap: 6, paddingHorizontal: 18, height: 44, backgroundColor: theme.primary }}
                >
                  <Icon as={Plus} size={16} color={theme.primaryForeground} strokeWidth={2.4} />
                  <Text className="font-roobert-medium text-[14px]" style={{ color: theme.primaryForeground }}>
                    Create your first project
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* No results */}
          {showNoResults && (
            <View className="items-center" style={{ paddingVertical: 48 }}>
              <Icon as={Search} size={28} className="text-muted-foreground/40" strokeWidth={1.8} />
              <Text className="mt-3 font-roobert-medium text-[15px] text-foreground">
                No matches for “{query.trim()}”
              </Text>
              <Text className="mt-1 font-roobert text-[13px] text-muted-foreground">Try a different search term</Text>
            </View>
          )}

          {/* Cards — flat grouped list (no shadows) */}
          {filtered.length > 0 && (
            <View className="overflow-hidden rounded-2xl border" style={{ backgroundColor: cardBg, borderColor: cardBorder }}>
              {filtered.map((project, i) => (
                <Pressable
                  key={project.project_id}
                  onPress={() => openProject(project)}
                  onLongPress={() => onCardLongPress(project)}
                  delayLongPress={300}
                  className="flex-row items-center active:bg-black/[0.03] dark:active:bg-white/[0.03]"
                  style={{ paddingHorizontal: 14, paddingVertical: 13, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: cardBorder }}
                >
                  <Avatar variant="custom" size={38} fallbackText={project.name} />
                  <View className="ml-3 flex-1">
                    <Text numberOfLines={1} className="font-roobert-semibold text-[15px] text-foreground">
                      {project.name}
                    </Text>
                    <Text numberOfLines={1} className="mt-0.5 font-roobert text-[12.5px] text-muted-foreground">
                      Updated {relativeTime(project.updated_at)}
                    </Text>
                  </View>
                  <Icon as={ChevronRight} size={18} className="text-muted-foreground/40" />
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <AccountSwitcherSheet
        open={accountSheetOpen}
        accounts={accountsQuery.data ?? []}
        selectedAccountId={activeAccountId}
        onSelect={(id) => setSelectedAccountId(id)}
        onClose={() => setAccountSheetOpen(false)}
      />

      <NewProjectSheet
        open={newProjectOpen}
        accountId={activeAccountId}
        onClose={() => setNewProjectOpen(false)}
        onCreated={handleCreated}
      />

      <AccountMenuSheet
        open={accountMenuOpen}
        name={(user?.user_metadata?.full_name as string | undefined) ?? undefined}
        email={user?.email}
        accountName={activeAccount?.name}
        accountId={activeAccountId}
        isSigningOut={isSigningOut}
        onSignOut={handleSignOut}
        onClose={() => setAccountMenuOpen(false)}
      />
    </View>
  );
}
