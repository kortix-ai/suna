/**
 * Project detail — ported from web's /projects/[id] ProjectHome.
 *
 * Shows the project header and recent sessions. Starting or opening a session
 * hands off into the app's existing chat runtime (rendered in app/home.tsx via
 * the tab store's active session), since that's where the live session UI lives.
 *
 * Note: the repo-first project (project_id from /projects) and the sandbox
 * session runtime are not yet linked on the backend, so "Recent sessions"
 * reflects the workspace's sessions, not project-scoped ones.
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
import { useProject } from '@/lib/projects/hooks';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSessions, useCreateSession } from '@/lib/platform/hooks';
import { useTabStore } from '@/stores/tab-store';
import { useThemeColors } from '@/lib/theme-colors';
import { getAuthToken } from '@/api/config';
import { haptics } from '@/lib/haptics';

function ago(ms?: number) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = typeof id === 'string' ? id : '';
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const projectQuery = useProject(projectId || null);
  const project = projectQuery.data;
  const { sandboxUrl } = useSandboxContext();
  const sessionsQuery = useSessions(sandboxUrl);
  const sessions = sessionsQuery.data ?? [];
  const createSession = useCreateSession(sandboxUrl);
  const theme = useThemeColors();
  const toast = useToast();
  const [prompt, setPrompt] = React.useState('');
  const [starting, setStarting] = React.useState(false);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  const openSession = React.useCallback(
    (sessionId: string) => {
      haptics.selection();
      useTabStore.getState().navigateToSession(sessionId);
      router.replace('/home');
    },
    [router],
  );

  const handleStart = React.useCallback(async () => {
    const text = prompt.trim();
    if (!text || !sandboxUrl || starting) return;
    setStarting(true);
    try {
      haptics.medium();
      const session = await createSession.mutateAsync({ title: project?.name });
      useTabStore.getState().navigateToSession(session.id);
      const token = await getAuthToken();
      await fetch(`${sandboxUrl}/session/${session.id}/prompt_async`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      });
      router.replace('/home');
    } catch (err: any) {
      haptics.warning();
      toast.error(err?.message || 'Failed to start session');
      setStarting(false);
    }
  }, [prompt, sandboxUrl, starting, createSession, project?.name, router, toast]);

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
            editable={!starting}
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
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: faint }}>
              {sandboxUrl ? '' : 'Preparing workspace…'}
            </Text>
            <Pressable
              onPress={handleStart}
              disabled={starting || !sandboxUrl || !prompt.trim()}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.primary,
                opacity: starting || !sandboxUrl || !prompt.trim() ? 0.4 : 1,
              }}
            >
              {starting ? (
                <ActivityIndicator size="small" color={theme.primaryForeground} />
              ) : (
                <ArrowUp size={18} color={theme.primaryForeground} />
              )}
            </Pressable>
          </View>
        </View>

        {/* Recent sessions */}
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
          Recent sessions
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
              Start a session to begin working.
            </Text>
          </View>
        )}

        {sessions.map((session) => (
          <Pressable
            key={session.id}
            onPress={() => openSession(session.id)}
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
            <MessageSquare size={16} color={faint} style={{ marginRight: 12 }} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>
                {session.title || 'Untitled session'}
              </Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: faint, marginTop: 2 }}>
                {ago(session.time?.updated)}
              </Text>
            </View>
            <ChevronRight size={16} color={faint} />
          </Pressable>
        ))}
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
