/**
 * ProjectsPage — Lists all Kortix projects.
 * Ported from web's /workspace page project list.
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
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
import { Search, X, FolderGit2, Clock, MessageSquare, ChevronRight } from 'lucide-react-native';

import { useSandboxContext } from '@/contexts/SandboxContext';
import { useKortixProjects, type KortixProject } from '@/lib/kortix';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';

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
  const theme = useThemeColors();
  const { sandboxUrl } = useSandboxContext();

  const { data: projects, isLoading, refetch } = useKortixProjects(sandboxUrl);
  const [searchQuery, setSearchQuery] = useState('');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';
  const faint = isDark ? '#52525b' : '#a1a1aa';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
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
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={subtle} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
      >
        {isLoading && filtered.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={subtle} />
          </View>
        )}

        {!isLoading && filtered.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <FolderGit2 size={40} color={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'} style={{ marginBottom: 12 }} />
            <RNText style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: subtle, marginBottom: 4 }}>
              {searchQuery ? 'No projects found' : 'No projects yet'}
            </RNText>
            <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: faint, textAlign: 'center' }}>
              {searchQuery ? 'Try a different search term' : 'Projects will appear here when created by the agent'}
            </RNText>
          </View>
        )}

        {filtered.map((project) => {
          const hasPath = !!project.path && project.path !== '/';
          const sessions = project.sessionCount ?? 0;
          return (
            <Pressable
              key={project.id}
              onPress={() => handleProjectPress(project)}
              style={({ pressed }) => ({
                backgroundColor: cardBg,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: border,
                paddingVertical: 14,
                paddingHorizontal: 14,
                marginBottom: 10,
                opacity: pressed ? 0.7 : 1,
                transform: [{ scale: pressed ? 0.995 : 1 }],
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                {/* Icon badge */}
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: theme.primaryLight,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                  }}
                >
                  <FolderGit2 size={18} color={theme.primary} />
                </View>

                {/* Content */}
                <View style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
                  {/* Title + chevron row */}
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <RNText
                      numberOfLines={1}
                      style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}
                    >
                      {project.name}
                    </RNText>
                    <ChevronRight size={16} color={faint} style={{ marginLeft: 8 }} />
                  </View>

                  {/* Path */}
                  {hasPath && (
                    <RNText
                      numberOfLines={1}
                      style={{
                        fontSize: 12,
                        fontFamily: 'Menlo',
                        color: faint,
                        marginTop: 2,
                      }}
                    >
                      {project.path}
                    </RNText>
                  )}

                  {/* Description */}
                  {!!project.description && (
                    <RNText
                      numberOfLines={2}
                      style={{
                        fontSize: 13,
                        fontFamily: 'Roobert',
                        color: subtle,
                        lineHeight: 18,
                        marginTop: hasPath ? 6 : 4,
                      }}
                    >
                      {project.description}
                    </RNText>
                  )}

                  {/* Meta row */}
                  {(sessions > 0 || !!project.created_at) && (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginTop: project.description ? 10 : 6,
                      }}
                    >
                      {sessions > 0 && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                          <MessageSquare size={11} color={faint} />
                          <RNText style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: subtle }}>
                            {sessions} {sessions === 1 ? 'session' : 'sessions'}
                          </RNText>
                        </View>
                      )}
                      {sessions > 0 && !!project.created_at && (
                        <View
                          style={{
                            width: 3,
                            height: 3,
                            borderRadius: 2,
                            backgroundColor: faint,
                            marginHorizontal: 8,
                            opacity: 0.6,
                          }}
                        />
                      )}
                      {!!project.created_at && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                          <Clock size={11} color={faint} />
                          <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: subtle }}>
                            {ago(project.created_at)}
                          </RNText>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      </PageContent>
    </View>
  );
}
