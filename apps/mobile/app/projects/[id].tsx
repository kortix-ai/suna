/**
 * Project detail — three-pane single-project view (web /projects/[id] + the
 * app's existing drawer experience):
 *   LEFT drawer  — project + its sessions (repo-first), New session, Search.
 *   MIDDLE       — a composer to start a session (the session itself opens in
 *                  the home runtime when run).
 *   RIGHT drawer — the existing pages menu (RightDrawerContent), to arrange later.
 *
 * Uses react-native-drawer-layout (same as app/home.tsx). Sessions come from the
 * repo-first backend (GET/POST /projects/{id}/sessions); opening a running one
 * switches the runtime to its sandbox and hands off to the chat in app/home.tsx.
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
} from 'react-native';
import { Drawer } from 'react-native-drawer-layout';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Menu,
  X,
  Plus,
  Search as SearchIcon,
  Folder,
  MessageSquare,
  ChevronRight,
  GitBranch,
  ArrowUp,
  PanelRight,
} from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useToast } from '@/components/ui/toast-provider';
import { CommandPalette } from '@/components/session/CommandPalette';
import { RightDrawerContent } from '@/components/session/RightDrawerContent';
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

const TRANSPARENT_DRAWER = {
  width: '84%' as const,
  backgroundColor: 'transparent',
  shadowColor: 'transparent',
  shadowOpacity: 0,
  shadowRadius: 0,
  shadowOffset: { width: 0, height: 0 },
  elevation: 0,
};

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
  const globalSessions = useSessions(sandboxUrl).data ?? [];

  const [prompt, setPrompt] = React.useState('');
  const [leftOpen, setLeftOpen] = React.useState(false);
  const [rightOpen, setRightOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.04)' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const drawerBg = isDark ? '#0A0A0A' : '#F6F6F6';

  const openSession = React.useCallback(
    (session: ProjectSession) => {
      if (session.status !== 'running') {
        toast.info(`Session is ${statusMeta(session.status).label}`);
        return;
      }
      haptics.selection();
      const externalId = session.sandbox_url?.match(/\/p\/([^/]+)\//)?.[1] || session.sandbox_id;
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

  // ── Left drawer (repo-first project + sessions) ───────────────────────────
  const renderLeftDrawer = React.useCallback(
    () => (
      <View style={{ flex: 1, paddingTop: insets.top + 8, backgroundColor: drawerBg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 }}>
          <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fg }} numberOfLines={1}>
            {project?.name ?? 'Project'}
          </Text>
          <Pressable onPress={() => setLeftOpen(false)} hitSlop={8} style={{ padding: 4 }}>
            <Icon as={X} size={20} className="text-muted-foreground" strokeWidth={2.2} />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 8 }}>
          <DrawerRow icon={Plus} label="New session" color={fg} onPress={() => { setLeftOpen(false); void startSession(); }} />
          <DrawerRow icon={SearchIcon} label="Search" color={fg} onPress={() => { setLeftOpen(false); setPaletteOpen(true); }} />
          <DrawerRow icon={Folder} label="Projects" color={fg} onPress={() => { setLeftOpen(false); router.replace('/projects'); }} />
        </View>

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
            <RefreshControl refreshing={sessionsQuery.isRefetching} onRefresh={() => sessionsQuery.refetch()} tintColor={subtle} />
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
                onPress={() => { setLeftOpen(false); openSession(session); }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Icon as={MessageSquare} size={15} className="text-muted-foreground" strokeWidth={2} style={{ marginRight: 10 }} />
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
                {session.status === 'running' && <Icon as={ChevronRight} size={15} className="text-muted-foreground" />}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    ),
    [insets.top, insets.bottom, drawerBg, fg, faint, subtle, project?.name, sessions, sessionsQuery, startSession, openSession, router],
  );

  // ── Right drawer (existing pages menu — arrange later) ────────────────────
  const renderRightDrawer = React.useCallback(
    () => (
      <View style={{ flex: 1, backgroundColor: drawerBg }}>
        <RightDrawerContent onClose={() => setRightOpen(false)} />
      </View>
    ),
    [drawerBg],
  );

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
      <Stack.Screen options={{ headerShown: false }} />

      <Drawer
        open={leftOpen}
        onOpen={() => setLeftOpen(true)}
        onClose={() => setLeftOpen(false)}
        drawerType="slide"
        drawerStyle={TRANSPARENT_DRAWER}
        overlayStyle={{ backgroundColor: 'rgba(0,0,0,0.35)' }}
        swipeEnabled={!rightOpen}
        swipeEdgeWidth={60}
        renderDrawerContent={renderLeftDrawer}
      >
        <Drawer
          open={rightOpen}
          onOpen={() => setRightOpen(true)}
          onClose={() => setRightOpen(false)}
          drawerPosition="right"
          drawerType="slide"
          drawerStyle={TRANSPARENT_DRAWER}
          overlayStyle={{ backgroundColor: 'rgba(0,0,0,0.35)' }}
          swipeEnabled={!leftOpen}
          swipeEdgeWidth={60}
          renderDrawerContent={renderRightDrawer}
        >
          {/* Middle */}
          <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={insets.top}
            >
              {/* Header */}
              <View
                style={{
                  paddingTop: insets.top + 8,
                  paddingHorizontal: 12,
                  paddingBottom: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Pressable onPress={() => { haptics.selection(); setLeftOpen(true); }} hitSlop={6} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon as={Menu} size={22} color={fg} strokeWidth={2.2} />
                </Pressable>
                <Text style={{ flex: 1, fontSize: 16, fontFamily: 'Roobert-Medium', color: fg, textAlign: 'center' }} numberOfLines={1}>
                  {project?.name ?? (projectQuery.isLoading ? 'Loading…' : 'Project')}
                </Text>
                <Pressable onPress={() => { haptics.selection(); setRightOpen(true); }} hitSlop={6} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon as={PanelRight} size={20} color={fg} strokeWidth={2.2} />
                </Pressable>
              </View>

              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 }}
                keyboardShouldPersistTaps="handled"
              >
                {!!project && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}>
                    <Icon as={GitBranch} size={13} className="text-muted-foreground" />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: subtle }} numberOfLines={1}>
                      {project.default_branch || 'main'}
                      {project.status === 'archived' ? ' · archived' : ''}
                    </Text>
                  </View>
                )}

                {/* Composer — the middle / start a session */}
                <View style={{ borderRadius: 18, borderWidth: 1, borderColor: border, backgroundColor: cardBg, padding: 12 }}>
                  <TextInput
                    value={prompt}
                    onChangeText={setPrompt}
                    placeholder="Describe a task to start a session…"
                    placeholderTextColor={faint}
                    multiline
                    editable={!createSession.isPending}
                    style={{ minHeight: 56, maxHeight: 160, fontSize: 15, fontFamily: 'Roobert', color: fg, paddingHorizontal: 4, paddingTop: 4 }}
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
                        <Icon as={ArrowUp} size={18} color={theme.primaryForeground} strokeWidth={2.4} />
                      )}
                    </Pressable>
                  </View>
                </View>

                <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, marginTop: 16, textAlign: 'center' }}>
                  Open the left menu for this project's sessions.
                </Text>
              </ScrollView>
            </KeyboardAvoidingView>
          </View>
        </Drawer>
      </Drawer>

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
  icon: typeof Plus;
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
      <Icon as={icon} size={18} color={color} strokeWidth={2.2} />
      <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color, marginLeft: 12 }}>{label}</Text>
    </Pressable>
  );
}
