/**
 * Project detail — ported from web's /projects/[id].
 *
 * Uses the repo-first project-session backend (GET/POST /projects/{id}/sessions),
 * the same connection the web uses: each session is its own branch + sandbox.
 * Opening a running session switches the app's runtime to that session's sandbox
 * (reusing SandboxContext.switchSandbox) and hands off to the chat in app/home.tsx.
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
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, MessageSquare, ChevronRight, GitBranch, ArrowUp } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast-provider';
import { useProject, useProjectSessions, useCreateProjectSession } from '@/lib/projects/hooks';
import type { ProjectSession, ProjectSessionStatus } from '@/lib/projects/projects-client';
import { useSandboxContext } from '@/contexts/SandboxContext';
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
  const { switchSandbox } = useSandboxContext();
  const sessionsQuery = useProjectSessions(projectId || null);
  const sessions = sessionsQuery.data ?? [];
  const createSession = useCreateProjectSession(projectId || null);

  const [prompt, setPrompt] = React.useState('');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

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

  const handleStart = React.useCallback(async () => {
    const text = prompt.trim();
    if (!text || createSession.isPending) return;
    try {
      haptics.medium();
      await createSession.mutateAsync({ initial_prompt: text, name: text.slice(0, 60) });
      setPrompt('');
      haptics.success();
      toast.success('Session starting…');
    } catch (err: any) {
      haptics.warning();
      toast.error(err?.message || 'Failed to start session');
    }
  }, [prompt, createSession, toast]);

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        {/* Header */}
        <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', height: 36, alignSelf: 'flex-start' }}
          >
            <ChevronLeft size={22} color={fg} />
            <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg, marginLeft: 2 }}>Projects</Text>
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={sessionsQuery.isRefetching}
              onRefresh={() => sessionsQuery.refetch()}
              tintColor={subtle}
            />
          }
        >
          {/* Title + meta */}
          <Text style={{ fontSize: 26, fontFamily: 'Roobert-SemiBold', color: fg }} numberOfLines={2}>
            {project?.name ?? (projectQuery.isLoading ? 'Loading…' : 'Project')}
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

          {/* Composer — start a session */}
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

          {/* Sessions */}
          <Text
            style={{
              fontSize: 12,
              fontFamily: 'Roobert-Medium',
              color: faint,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginTop: 28,
              marginBottom: 12,
            }}
          >
            Sessions
          </Text>

          {sessionsQuery.isLoading && (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <ActivityIndicator color={subtle} />
            </View>
          )}

          {!sessionsQuery.isLoading && sessions.length === 0 && (
            <View style={{ paddingVertical: 28, alignItems: 'center' }}>
              <MessageSquare size={28} color={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'} style={{ marginBottom: 10 }} />
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: subtle, marginBottom: 4 }}>
                No sessions yet
              </Text>
              <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, textAlign: 'center' }}>
                Describe a task above to start one.
              </Text>
            </View>
          )}

          {sessions.map((session) => {
            const meta = statusMeta(session.status);
            return (
              <Pressable
                key={session.session_id}
                onPress={() => openSession(session)}
                style={({ pressed }) => ({
                  backgroundColor: cardBg,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: border,
                  padding: 14,
                  marginBottom: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>
                    {session.name || 'Untitled session'}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: meta.color }} />
                    <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: faint }}>
                      {meta.label} · {ago(session.updated_at)}
                    </Text>
                  </View>
                </View>
                {session.status === 'running' && <ChevronRight size={16} color={faint} />}
              </Pressable>
            );
          })}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
