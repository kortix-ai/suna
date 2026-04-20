/**
 * ProjectsPage — Lists all Kortix projects.
 * Ported from web's /workspace page project list.
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  TextInput,
  Pressable,
  ActivityIndicator,
  Text as RNText,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Search, X, FolderGit2, Clock, MessageSquare } from 'lucide-react-native';

import { useSandboxContext } from '@/contexts/SandboxContext';
import { useKortixProjects, type KortixProject } from '@/lib/kortix';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
// import { useThemeColors } from '@/lib/theme-colors';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ago(t?: string | number) {
  if (!t) return '';
  const ms = Date.now() - (typeof t === 'string' ? +new Date(t) : t);
  const m = ms / 60000 | 0;
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = m / 60 | 0;
  if (h < 24) return h + 'h ago';
  const d = h / 24 | 0;
  return d < 30 ? d + 'd ago' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectsPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ProjectsPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: ProjectsPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { sandboxUrl } = useSandboxContext();

  const { data: projects, isLoading, refetch } = useKortixProjects(sandboxUrl);
  const [searchQuery, setSearchQuery] = useState('');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const cardBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  const filtered: KortixProject[] = useMemo(() => {
    if (!projects) return [];
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter(
      (p: KortixProject) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q),
    );
  }, [projects, searchQuery]);

  const handleProjectPress = useCallback((project: KortixProject) => {
    const pageId = `page:project:${project.id}`;
    // Store project name for tab title display
    useTabStore.getState().setTabState(pageId, { projectName: project.name });
    useTabStore.getState().navigateToPage(pageId);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#F8F8F8' }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
      {/* Search */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 8, gap: 10 }}>
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: inputBg,
            borderRadius: 9999,
            paddingHorizontal: 16,
            height: 42,
          }}
        >
          <Search size={16} color={isDark ? '#71717a' : '#a1a1aa'} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search projects..."
            placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
            style={{ flex: 1, marginLeft: 8, fontSize: 15, fontFamily: 'Roobert', color: fg }}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
              <X size={16} color={isDark ? '#71717a' : '#a1a1aa'} />
            </Pressable>
          )}
        </View>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={muted} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
      >
        {isLoading && filtered.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={muted} />
          </View>
        )}

        {!isLoading && filtered.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <FolderGit2 size={40} color={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'} style={{ marginBottom: 12 }} />
            <RNText style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 4 }}>
              {searchQuery ? 'No projects found' : 'No projects yet'}
            </RNText>
            <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)', textAlign: 'center' }}>
              {searchQuery ? 'Try a different search term' : 'Projects will appear here when created by the agent'}
            </RNText>
          </View>
        )}

        {filtered.map((project) => (
          <TouchableOpacity
            key={project.id}
            onPress={() => handleProjectPress(project)}
            activeOpacity={0.7}
            style={{
              backgroundColor: cardBg,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: border,
              padding: 14,
              marginBottom: 10,
            }}
          >
            {/* Title row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <FolderGit2 size={16} color={isDark ? '#71717a' : '#a1a1aa'} />
              <RNText
                numberOfLines={1}
                style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}
              >
                {project.name}
              </RNText>
            </View>

            {/* Path */}
            {project.path && project.path !== '/' && (
              <RNText
                numberOfLines={1}
                style={{ fontSize: 12, fontFamily: 'Menlo', color: isDark ? '#52525b' : '#a1a1aa', marginBottom: 4, marginLeft: 24 }}
              >
                {project.path}
              </RNText>
            )}

            {/* Description */}
            {!!project.description && (
              <RNText
                numberOfLines={2}
                style={{ fontSize: 13, fontFamily: 'Roobert', color: isDark ? '#71717a' : '#a1a1aa', lineHeight: 18, marginBottom: 6, marginLeft: 24 }}
              >
                {project.description}
              </RNText>
            )}

            {/* Meta row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginLeft: 24 }}>
              {(project.sessionCount ?? 0) > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <MessageSquare size={11} color={isDark ? '#52525b' : '#d4d4d8'} />
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? '#52525b' : '#a1a1aa' }}>
                    {project.sessionCount}
                  </RNText>
                </View>
              )}
              {!!project.created_at && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} color={isDark ? '#52525b' : '#d4d4d8'} />
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? '#52525b' : '#a1a1aa' }}>
                    {ago(project.created_at)}
                  </RNText>
                </View>
              )}
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
      </PageContent>
    </View>
  );
}
