/**
 * Project detail — ported from web's /projects/[id] (ProjectShell + ProjectSidebar).
 *
 * Main area is the "hero": project name + a composer to start a session.
 * A left drawer (menu button / tap-backdrop) mirrors the web sidebar:
 *   New session · Search (the shared CommandPalette) · this project's Sessions.
 *
 * Sessions use the repo-first backend (GET/POST /projects/{id}/sessions); each is
 * its own branch + sandbox. Opening a running session switches the runtime to
 * that session's sandbox (SandboxContext.switchSandbox) and hands off to the
 * chat in app/home.tsx.
 */

import * as React from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Dimensions,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronRight,
  GitBranch,
  ArrowUp,
  Menu,
  X,
  Plus,
  Search as SearchIcon,
  Folder,
  MessageSquare,
} from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast-provider';
import { CommandPalette } from '@/components/session/CommandPalette';
import { useProject, useProjectSessions, useCreateProjectSession } from '@/lib/projects/hooks';
import type { ProjectSession, ProjectSessionStatus } from '@/lib/projects/projects-client';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSessions } from '@/lib/platform/hooks';
import { useTabStore } from '@/stores/tab-store';
import { getSandboxUrl, type SandboxInfo } from '@/lib/platform/client';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';

function ago(iso?: string) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusMeta(status: ProjectSessionStatus): { label: string; color: string } {
  switch (status) {
    case 'running':
      return { label: 'running', color: '#34d399' };
    case 'queued':
    case 'branching':
    case 'provisioning':
      return { label: 'provisioning', color: '#f59e0b' };
    case 'failed':
      return { label: 'failed', color: '#ef4444' };
    default:
      return { label: status, color: '#a1a1aa' };
  }
}

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = typeof id === 'string' ? id : '';
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const toast = useToast();

  const projectQuery = useProject(projectId || null);
  const project = projectQuery.data;
  const { sandboxUrl, switchSandbox } = useSandboxContext();
  const sessionsQuery = useProjectSessions(projectId || null);
  const sessions = sessionsQuery.data ?? [];
  const createSession = useCreateProjectSession(projectId || null);

  // Global runtime sessions — only used to power the shared CommandPalette search.
  const globalSessions = useSessions(sandboxUrl).data ?? [];

  const [prompt, setPrompt] = React.useState('');
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const drawerAnim = React.useRef(new Animated.Value(0)).current;
  const screenW = Dimensions.get('window').width;
  const drawerWidth = Math.min(330, screenW * 0.84);

  React.useEffect(() => {
    Animated.timing(drawerAnim, {
      toValue: drawerOpen ? 1 : 0,
      duration: drawerOpen ? 240 : 200,
      useNativeDriver: true,
    }).start();
  }, [drawerOpen, drawerAnim]);

  const translateX = drawerAnim.interpolate({ inputRange: [0, 1], outputRange: [-drawerWidth, 0] });
  const backdropOpacity = drawerAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] });

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const drawerBg = isDark ? '#0A0A0A' : '#F6F6F6';

  const openSession = React.useCallback(
    (session: ProjectSession) => {
      if (session.status !== 'running') {
        toast.info(`Session is ${statusMeta(session.status).label}`);
        return;
      }
      haptics.selection();
      const externalId =
        session.sandbox_url?.match(/\/p\/([^/]+)\//)?.[1] || session.sandbox_id;
      switchSandbox({
        sandbox_id: session.sandbox_id,
        external_id: externalId,
        name: session.name || 'Session',
        provider: (session.sandbox_provider as any) || 'daytona',
        base_url: session.sandbox_url || getSandboxUrl(externalId),
        status: 'active',
        created_at: session.created_at,
        updated_at: session.updated_at,
      } as SandboxInfo);
      if (session.opencode_session_id) {
        useTabStore.getState().navigateToSession(session.opencode_session_id);
      }
      router.replace('/home');
    },
    [switchSandbox, router, toast],
  );

  const startSession = React.useCallback(
    async (initialPrompt?: string) => {
      if (createSession.isPending) return;
      try {
        haptics.medium();
        await createSession.mutateAsync({
          ...(initialPrompt ? { initial_prompt: initialPrompt, name: initialPrompt.slice(0, 60) } : {}),
        });
        setPrompt('');
        haptics.success();
        toast.success('Session starting…');
      } catch (err: any) {
        haptics.warning();
        toast.error(err?.message || 'Failed to start session');
      }
    },
    [createSession, toast],
  );

  const handleStart = React.useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    void startSession(text);
  }, [prompt, startSession]);

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        {/* Header */}
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            paddingBottom: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Pressable
            onPress={() => {
              haptics.selection();
              setDrawerOpen(true);
            }}
            hitSlop={8}
            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
          >
            <Menu size={22} color={fg} />
          </Pressable>
          <Text style={{ flex: 1, fontSize: 16, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {project?.name ?? (projectQuery.isLoading ? 'Loading…' : 'Project')}
          </Text>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Hero */}
          <Text style={{ fontSize: 26, fontFamily: 'Roobert-SemiBold', color: fg }} numberOfLines={2}>
            {project?.name ?? 'Project'}
          </Text>
          {!!project && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <GitBranch size={13} color={faint} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: subtle }} numberOfLines={1}>
                {project.default_branch || 'main'}
                {project.status === 'archived' ? ' · archived' : ''}
              </Text>
            </View>
          )}

          {/* Composer */}
          <View
            style={{
              marginTop: 20,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: border,
              backgroundColor: cardBg,
              padding: 12,
            }}
          >
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Describe a task to start a session…"
              placeholderTextColor={faint}
              multiline
              editable={!createSession.isPending}
              style={{
                minHeight: 48,
                maxHeight: 140,
                fontSize: 15,
                fontFamily: 'Roobert',
                color: fg,
                paddingHorizontal: 4,
                paddingTop: 4,
              }}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 8 }}>
              <Pressable
                onPress={handleStart}
                disabled={createSession.isPending || !prompt.trim()}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.primary,
                  opacity: createSession.isPending || !prompt.trim() ? 0.4 : 1,
                }}
              >
                {createSession.isPending ? (
                  <ActivityIndicator size="small" color={theme.primaryForeground} />
                ) : (
                  <ArrowUp size={18} color={theme.primaryForeground} />
                )}
              </Pressable>
            </View>
          </View>

          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, marginTop: 16, textAlign: 'center' }}>
            Open the menu to browse this project's sessions.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Left drawer (web ProjectSidebar) ── */}
      <Animated.View
        pointerEvents={drawerOpen ? 'auto' : 'none'}
        style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdropOpacity, zIndex: 40 }]}
      >
        <Pressable style={{ flex: 1 }} onPress={() => setDrawerOpen(false)} />
      </Animated.View>

      <Animated.View
        pointerEvents={drawerOpen ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: drawerWidth,
          backgroundColor: drawerBg,
          zIndex: 41,
          transform: [{ translateX }],
        }}
      >
        <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
          {/* Drawer header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 }}>
            <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fg }} numberOfLines={1}>
              {project?.name ?? 'Project'}
            </Text>
            <Pressable onPress={() => setDrawerOpen(false)} hitSlop={8} style={{ padding: 4 }}>
              <X size={20} color={subtle} />
            </Pressable>
          </View>

          {/* Actions */}
          <View style={{ paddingHorizontal: 8 }}>
            <DrawerRow
              icon={<Plus size={18} color={fg} />}
              label="New session"
              color={fg}
              onPress={() => {
                setDrawerOpen(false);
                void startSession();
              }}
            />
            <DrawerRow
              icon={<SearchIcon size={18} color={fg} />}
              label="Search"
              color={fg}
              onPress={() => {
                setDrawerOpen(false);
                setPaletteOpen(true);
              }}
            />
            <DrawerRow
              icon={<Folder size={18} color={fg} />}
              label="Projects"
              color={fg}
              onPress={() => {
                setDrawerOpen(false);
                router.replace('/projects');
              }}
            />
          </View>

          {/* Sessions */}
          <Text
            style={{
              fontSize: 12,
              fontFamily: 'Roobert-Medium',
              color: faint,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              paddingHorizontal: 20,
              marginTop: 16,
              marginBottom: 8,
            }}
          >
            Sessions
          </Text>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 16 }}
            refreshControl={
              <RefreshControl
                refreshing={sessionsQuery.isRefetching}
                onRefresh={() => sessionsQuery.refetch()}
                tintColor={subtle}
              />
            }
          >
            {sessionsQuery.isLoading && (
              <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                <ActivityIndicator color={subtle} />
              </View>
            )}

            {!sessionsQuery.isLoading && sessions.length === 0 && (
              <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, textAlign: 'center', paddingVertical: 24 }}>
                No sessions yet
              </Text>
            )}

            {sessions.map((session) => {
              const meta = statusMeta(session.status);
              return (
                <Pressable
                  key={session.session_id}
                  onPress={() => {
                    setDrawerOpen(false);
                    openSession(session);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <MessageSquare size={15} color={faint} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>
                      {session.name || 'Untitled session'}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: meta.color }} />
                      <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: faint }}>
                        {meta.label} · {ago(session.updated_at)}
                      </Text>
                    </View>
                  </View>
                  {session.status === 'running' && <ChevronRight size={15} color={faint} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Animated.View>

      {/* Search — shared command palette (web's Cmd+K) */}
      <CommandPalette
        visible={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={globalSessions}
        onNewSession={() => void startSession()}
        onSessionSelect={(sid) => {
          if (sid) {
            useTabStore.getState().navigateToSession(sid);
            router.replace('/home');
          }
        }}
        onPageSelect={(pageId) => {
          useTabStore.getState().navigateToPage(pageId);
          router.replace('/home');
        }}
        onSettings={() => router.replace('/home')}
        sandboxUrl={sandboxUrl}
        onFileSelect={() => {
          useTabStore.getState().navigateToPage('page:files');
          router.replace('/home');
        }}
      />
    </View>
  );
}

function DrawerRow({
  icon,
  label,
  color,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {icon}
      <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color, marginLeft: 12 }}>{label}</Text>
    </Pressable>
  );
}
