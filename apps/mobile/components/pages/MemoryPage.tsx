/**
 * MemoryPage — View and manage agent memories (LTM + Observations).
 *
 * Uses the OpenCode memory API:
 *   GET  {sandboxUrl}/memory/entries?limit=200&source={ltm|observation}
 *   GET  {sandboxUrl}/memory/stats
 *   GET  {sandboxUrl}/memory/search?q={query}&source={source}
 *   DELETE {sandboxUrl}/memory/entries/{source}/{id}
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  RefreshControl,
  ActivityIndicator,
  Platform,
  LayoutAnimation,
} from 'react-native';
import { Text } from '@/components/ui/text';
import {
  Brain,
  BookOpen,
  Wrench,
  Eye,
  FileText,
  Search as SearchIcon,
  Trash2,
  Clock,
  Tag,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import { SearchBar } from '@/components/ui/SearchBar';
import type { PageTab } from '@/stores/tab-store';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MemoryEntry {
  id: number;
  source: 'ltm' | 'observation';
  type: string;
  content: string;
  title?: string;
  narrative?: string;
  sessionId?: string | null;
  tags: string[];
  files: string[];
  facts?: string[];
  toolName?: string;
  createdAt: string;
  updatedAt?: string | null;
}

interface MemoryStats {
  ltm: { total: number; byType: Record<string, number> };
  observations: { total: number; byType: Record<string, number> };
  sessions: number;
}

// ─── Type config ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<string, { icon: LucideIcon; color: string; label: string }> = {
  episodic: { icon: BookOpen, label: 'Episodic', color: '#8b5cf6' },
  semantic: { icon: Brain, label: 'Semantic', color: '#3b82f6' },
  procedural: { icon: Wrench, label: 'Procedural', color: '#f59e0b' },
  observation: { icon: Eye, label: 'Observation', color: '#10b981' },
  file_read: { icon: FileText, label: 'File Read', color: '#6366f1' },
  file_edit: { icon: FileText, label: 'File Edit', color: '#ec4899' },
  command: { icon: Wrench, label: 'Command', color: '#71717a' },
  code_search: { icon: SearchIcon, label: 'Code Search', color: '#0ea5e9' },
  web: { icon: SearchIcon, label: 'Web', color: '#14b8a6' },
};

function getTypeConfig(type: string) {
  return TYPE_CONFIG[type] || { icon: Brain, label: type.replace(/_/g, ' '), color: '#71717a' };
}

// ─── API ─────────────────────────────────────────────────────────────────────

type SourceFilter = 'all' | 'ltm' | 'observation';

function useMemory(sandboxUrl: string | undefined) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async (source: SourceFilter = 'all', query?: string) => {
    if (!sandboxUrl) return;
    setIsLoading(true);
    setError(null);
    try {
      const token = await getAuthToken();
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

      let url: string;
      if (query?.trim()) {
        url = `${sandboxUrl}/memory/search?q=${encodeURIComponent(query.trim())}`;
        if (source !== 'all') url += `&source=${source}`;
      } else {
        url = `${sandboxUrl}/memory/entries?limit=200`;
        if (source !== 'all') url += `&source=${source}`;
      }

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Failed to fetch memories: ${res.status}`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch (err: any) {
      log.error('Failed to fetch memories:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [sandboxUrl]);

  const fetchStats = useCallback(async () => {
    if (!sandboxUrl) return;
    try {
      const token = await getAuthToken();
      const res = await fetch(`${sandboxUrl}/memory/stats`, {
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) return;
      const data = await res.json();
      setStats(data);
    } catch {
      // Stats are non-critical
    }
  }, [sandboxUrl]);

  const deleteEntry = useCallback(async (source: string, id: number) => {
    if (!sandboxUrl) return;
    const token = await getAuthToken();
    const res = await fetch(`${sandboxUrl}/memory/entries/${source}/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`Failed to delete memory: ${res.status}`);
  }, [sandboxUrl]);

  return { entries, stats, isLoading, error, fetchEntries, fetchStats, deleteEntry };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

// ─── MemoryCard ──────────────────────────────────────────────────────────────

function MemoryCard({
  entry,
  isDark,
  onDelete,
}: {
  entry: MemoryEntry;
  isDark: boolean;
  onDelete: (entry: MemoryEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const config = getTypeConfig(entry.type);
  const IconComp = config.icon;

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const cardBg = isDark ? 'rgba(255,255,255,0.02)' : '#FFFFFF';

  const title = entry.title || entry.content.slice(0, 80);
  const preview = entry.content.slice(0, 200);

  const handlePress = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setExpanded((prev) => !prev);
  }, []);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      style={{
        backgroundColor: cardBg,
        borderBottomWidth: 1,
        borderBottomColor: borderColor,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      {/* Header row */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
        <IconComp size={14} color={config.color} style={{ marginRight: 8 }} />

        {/* Type badge */}
        <View style={{
          backgroundColor: config.color + '15',
          borderRadius: 6,
          paddingHorizontal: 6,
          paddingVertical: 1,
          marginRight: 6,
        }}>
          <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: config.color }}>
            {config.label}
          </Text>
        </View>

        {/* Source badge */}
        <View style={{
          backgroundColor: entry.source === 'ltm'
            ? (isDark ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.08)')
            : (isDark ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.08)'),
          borderRadius: 6,
          paddingHorizontal: 6,
          paddingVertical: 1,
        }}>
          <Text style={{
            fontSize: 9, fontFamily: 'Roobert-Medium',
            color: entry.source === 'ltm' ? '#3b82f6' : '#10b981',
          }}>
            {entry.source === 'ltm' ? 'LTM' : 'OBS'}
          </Text>
        </View>

        {/* Timestamp */}
        <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' }}>
          <Clock size={10} color={mutedColor} style={{ marginRight: 3 }} />
          <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedColor }}>
            {formatDate(entry.createdAt)}
          </Text>
        </View>
      </View>

      {/* Title */}
      <Text numberOfLines={expanded ? undefined : 1} style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fgColor, marginBottom: 4 }}>
        {title}
      </Text>

      {/* Preview / Full content */}
      {!expanded ? (
        <Text numberOfLines={2} style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, lineHeight: 17 }}>
          {preview}
        </Text>
      ) : (
        <View>
          {/* Full content */}
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: isDark ? '#d4d4d8' : '#3f3f46', lineHeight: 18, marginBottom: 8 }}>
            {entry.content}
          </Text>

          {/* Facts */}
          {entry.facts && entry.facts.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: mutedColor, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Facts</Text>
              {entry.facts.map((fact, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 2 }}>
                  <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: '#10b981', marginTop: 5, marginRight: 6 }} />
                  <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fgColor, lineHeight: 17, flex: 1 }}>{fact}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Tags */}
          {entry.tags.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              <Tag size={11} color={mutedColor} style={{ marginRight: 2, marginTop: 2 }} />
              {entry.tags.map((tag, i) => (
                <View key={i} style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedColor }}>{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Files */}
          {entry.files.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {entry.files.slice(0, 5).map((file, i) => (
                <Text key={i} style={{ fontSize: 10, fontFamily: monoFont, color: mutedColor }}>{file}</Text>
              ))}
              {entry.files.length > 5 && (
                <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedColor }}>+{entry.files.length - 5} more</Text>
              )}
            </View>
          )}

          {/* Metadata row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {entry.toolName && (
              <Text style={{ fontSize: 9, fontFamily: monoFont, color: mutedColor, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 }}>
                {entry.toolName}
              </Text>
            )}
            {entry.sessionId && (
              <Text numberOfLines={1} style={{ fontSize: 9, fontFamily: monoFont, color: mutedColor, maxWidth: 120 }}>
                {entry.sessionId}
              </Text>
            )}
            <Text style={{ fontSize: 9, fontFamily: monoFont, color: mutedColor }}>#{entry.id}</Text>
          </View>

          {/* Delete button */}
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); onDelete(entry); }}
            style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, alignSelf: 'flex-end' }}
          >
            <Trash2 size={13} color={isDark ? '#f87171' : '#dc2626'} style={{ marginRight: 4 }} />
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isDark ? '#f87171' : '#dc2626' }}>Delete</Text>
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── MemoryPage ──────────────────────────────────────────────────────────────

interface MemoryPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
}

export function MemoryPage({ page, onOpenDrawer, onOpenRightDrawer }: MemoryPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const { sandboxUrl } = useSandboxContext();

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const bgColor = isDark ? '#121215' : '#F8F8F8';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const sheetBg = isDark ? '#161618' : '#FFFFFF';

  const { entries, stats, isLoading, error, fetchEntries, fetchStats, deleteEntry } = useMemory(sandboxUrl);

  // Filters
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntry | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Delete sheet
  const deleteSheetRef = useRef<BottomSheetModal>(null);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} pressBehavior="close" />
    ),
    [],
  );

  // Initial fetch
  useEffect(() => {
    fetchEntries(sourceFilter);
    fetchStats();
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      fetchEntries(sourceFilter, searchQuery);
    }, 350);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [searchQuery, sourceFilter, fetchEntries]);

  const handleRefresh = useCallback(() => {
    fetchEntries(sourceFilter, searchQuery);
    fetchStats();
  }, [fetchEntries, fetchStats, sourceFilter, searchQuery]);

  const handleSourceChange = useCallback((source: SourceFilter) => {
    setSourceFilter(source);
  }, []);

  const openDelete = useCallback((entry: MemoryEntry) => {
    setDeleteTarget(entry);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    deleteSheetRef.current?.present();
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteEntry(deleteTarget.source, deleteTarget.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      deleteSheetRef.current?.dismiss();
      fetchEntries(sourceFilter, searchQuery);
      fetchStats();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, deleteEntry, fetchEntries, fetchStats, sourceFilter, searchQuery]);

  // Stats display
  const statsText = useMemo(() => {
    if (!stats) return '';
    const parts: string[] = [];
    if (stats.ltm?.total) parts.push(`${stats.ltm.total} long-term`);
    if (stats.observations?.total) parts.push(`${stats.observations.total} observations`);
    if (stats.sessions) parts.push(`${stats.sessions} sessions`);
    return parts.join(' \u00B7 ');
  }, [stats]);

  // Filter button component
  const FilterButton = ({ label, value, count }: { label: string; value: SourceFilter; count?: number }) => {
    const active = sourceFilter === value;
    return (
      <TouchableOpacity
        onPress={() => handleSourceChange(value)}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 8,
          backgroundColor: active ? fgColor : 'transparent',
          borderWidth: active ? 0 : 1,
          borderColor: borderColor,
        }}
      >
        <Text style={{
          fontSize: 12, fontFamily: 'Roobert-Medium',
          color: active ? bgColor : mutedColor,
        }}>
          {label}{count !== undefined ? ` (${count})` : ''}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      {/* Header */}
      <View style={{ paddingTop: insets.top + 8, paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: borderColor }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {onOpenDrawer && (
              <TouchableOpacity onPress={onOpenDrawer} style={{ marginRight: 12 }}>
                <Ionicons name="menu" size={24} color={fgColor} />
              </TouchableOpacity>
            )}
            <View>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }} numberOfLines={1}>{page.label}</Text>
              {!!statsText && (
                <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor, marginTop: 1, includeFontPadding: false }}>{statsText}</Text>
              )}
            </View>
          </View>
          {onOpenRightDrawer && (
            <TouchableOpacity onPress={onOpenRightDrawer}>
              <Ionicons name="apps-outline" size={20} color={fgColor} />
            </TouchableOpacity>
          )}
        </View>

        {/* Search */}
        <View style={{ marginTop: 12 }}>
          <SearchBar
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search memories"
            onClear={() => setSearchQuery('')}
          />
        </View>

        {/* Filter tabs */}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <FilterButton label="All" value="all" count={stats ? (stats.ltm?.total || 0) + (stats.observations?.total || 0) : undefined} />
          <FilterButton label="LTM" value="ltm" count={stats?.ltm?.total} />
          <FilterButton label="Observations" value="observation" count={stats?.observations?.total} />
        </View>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} tintColor={mutedColor} />}
      >
        {isLoading && entries.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={mutedColor} />
          </View>
        )}
        {error && (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: isDark ? '#f87171' : '#dc2626', textAlign: 'center' }}>{error}</Text>
          </View>
        )}
        {!isLoading && !error && entries.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Brain size={32} color={mutedColor} style={{ marginBottom: 12, opacity: 0.5 }} />
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 4 }}>
              {searchQuery ? 'No memories match your search' : 'No memories yet'}
            </Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center', opacity: 0.7 }}>
              {searchQuery ? 'Try a different search term' : 'Memories are created by the agent during sessions'}
            </Text>
          </View>
        )}
        {entries.map((entry) => (
          <MemoryCard key={`${entry.source}-${entry.id}`} entry={entry} isDark={isDark} onDelete={openDelete} />
        ))}
        <View style={{ height: insets.bottom + 80 }} />
      </ScrollView>

      {/* Delete Sheet */}
      <BottomSheetModal
        ref={deleteSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setDeleteTarget(null)}
        backgroundStyle={{ backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Trash2 size={20} color={isDark ? '#f87171' : '#dc2626'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Delete Memory</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 2 }} numberOfLines={1}>
                {deleteTarget?.source === 'ltm' ? 'LTM' : 'Observation'} #{deleteTarget?.id}
              </Text>
            </View>
          </View>

          {deleteTarget && (
            <View style={{
              padding: 12, borderRadius: 12, marginBottom: 20,
              backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
              borderWidth: 1, borderColor: borderColor,
            }}>
              <Text numberOfLines={3} style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, lineHeight: 17 }}>
                {deleteTarget.content.slice(0, 200)}
              </Text>
            </View>
          )}

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <BottomSheetTouchable
              onPress={() => deleteSheetRef.current?.dismiss()}
              style={{ flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Cancel</Text>
            </BottomSheetTouchable>
            <BottomSheetTouchable
              onPress={handleDelete}
              disabled={isDeleting}
              style={{ flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center', backgroundColor: isDark ? '#dc2626' : '#ef4444', opacity: isDeleting ? 0.5 : 1 }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: '#FFFFFF' }}>
                {isDeleting ? 'Deleting...' : 'Delete'}
              </Text>
            </BottomSheetTouchable>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
    </View>
  );
}
