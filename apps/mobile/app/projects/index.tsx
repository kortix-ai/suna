/**
 * Projects screen — post-login landing, ported from web's /projects page.
 *
 * Repo-first model: lists projects for the current account (GET /accounts +
 * GET /projects?account_id=). Mirrors the web layout (title, subtitle, search,
 * cards, loading/empty/no-results/error states).
 */

import * as React from 'react';
import {
  View,
  ScrollView,
  RefreshControl,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, X, FolderPlus, ChevronRight, ChevronDown, Plus, AlertCircle } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/ui/Avatar';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { useToast } from '@/components/ui/toast-provider';
import { AccountSwitcherSheet } from '@/components/projects/AccountSwitcherSheet';
import { NewProjectSheet } from '@/components/projects/NewProjectSheet';
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
  const { user } = useAuthContext();

  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [query, setQuery] = React.useState('');
  const [accountSheetOpen, setAccountSheetOpen] = React.useState(false);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);

  const accountsQuery = useAccounts(!!user);
  const archive = useArchiveProject();

  // Reconcile the persisted account against what the user actually has access
  // to; fall back to the first account (mirrors web).
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

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

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

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 20,
          paddingBottom: 8,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
          <KortixLogo variant="symbol" size={28} color={isDark ? 'dark' : 'light'} />
          {!!activeAccount && (
            <Pressable
              onPress={() => {
                haptics.selection();
                setAccountSheetOpen(true);
              }}
              disabled={accountCount < 2}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}
            >
              <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: subtle, maxWidth: 160 }}>
                {activeAccount.name}
              </Text>
              {accountCount > 1 && <ChevronDown size={14} color={subtle} />}
            </Pressable>
          )}
        </View>
        {canCreate && (
          <Pressable
            onPress={() => {
              haptics.selection();
              setNewProjectOpen(true);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 14,
              height: 36,
              borderRadius: 9999,
              backgroundColor: theme.primary,
            }}
          >
            <Plus size={16} color={theme.primaryForeground} />
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>New</Text>
          </Pressable>
        )}
      </View>

      {/* Title + subtitle */}
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6 }}>
        <Text style={{ fontSize: 28, fontFamily: 'Roobert-SemiBold', color: fg }}>Projects</Text>
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: subtle, marginTop: 4 }}>
          Your workspaces in one place. Pick up where you left off.
        </Text>
      </View>

      {/* Search */}
      <View style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 4 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: inputBg,
            borderRadius: 9999,
            paddingHorizontal: 16,
            height: 42,
          }}
        >
          <Search size={16} color={faint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search projects"
            placeholderTextColor={faint}
            style={{ flex: 1, marginLeft: 8, fontSize: 15, fontFamily: 'Roobert', color: fg }}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <X size={16} color={faint} />
            </Pressable>
          )}
        </View>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={projectsQuery.isRefetching}
            onRefresh={() => projectsQuery.refetch()}
            tintColor={subtle}
          />
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 }}
      >
        {loading && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={subtle} />
          </View>
        )}

        {projectsQuery.isError && !loading && (
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(248,113,113,0.25)' : 'rgba(220,38,38,0.25)',
              padding: 16,
              alignItems: 'center',
            }}
          >
            <AlertCircle size={20} color={isDark ? '#f87171' : '#dc2626'} style={{ marginBottom: 8 }} />
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 4 }}>
              Failed to load projects
            </Text>
            <Text
              style={{ fontSize: 13, fontFamily: 'Roobert', color: subtle, textAlign: 'center', marginBottom: 12 }}
            >
              {(projectsQuery.error as Error)?.message ?? 'Something went wrong'}
            </Text>
            <Pressable
              onPress={() => projectsQuery.refetch()}
              style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 9999, borderWidth: 1, borderColor: border }}
            >
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
            </Pressable>
          </View>
        )}

        {showEmpty && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <FolderPlus
              size={40}
              color={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}
              style={{ marginBottom: 12 }}
            />
            <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: subtle, marginBottom: 4 }}>
              No projects yet
            </Text>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, textAlign: 'center' }}>
              A project is a dedicated space for one company, product, or idea.
            </Text>
            {canCreate && (
              <Pressable
                onPress={() => {
                  haptics.selection();
                  setNewProjectOpen(true);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 16,
                  paddingHorizontal: 16,
                  height: 40,
                  borderRadius: 9999,
                  backgroundColor: theme.primary,
                }}
              >
                <Plus size={16} color={theme.primaryForeground} />
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>
                  Create your first project
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {showNoResults && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Search size={32} color={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'} style={{ marginBottom: 12 }} />
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: subtle, marginBottom: 4 }}>
              No matches for "{query.trim()}"
            </Text>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, textAlign: 'center' }}>
              Try a different search term
            </Text>
          </View>
        )}

        {filtered.map((project) => (
          <Pressable
            key={project.project_id}
            onPress={() => openProject(project)}
            onLongPress={() => onCardLongPress(project)}
            delayLongPress={300}
            style={({ pressed }) => ({
              backgroundColor: cardBg,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: border,
              padding: 14,
              marginBottom: 10,
              flexDirection: 'row',
              alignItems: 'center',
              opacity: pressed ? 0.7 : 1,
              transform: [{ scale: pressed ? 0.995 : 1 }],
            })}
          >
            <Avatar variant="custom" size={44} fallbackText={project.name} />
            <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>
                {project.name}
              </Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: faint, marginTop: 2 }}>
                Updated {relativeTime(project.updated_at)}
              </Text>
            </View>
            <ChevronRight size={16} color={faint} />
          </Pressable>
        ))}
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
    </View>
  );
}
