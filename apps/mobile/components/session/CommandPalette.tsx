/**
 * CommandPalette — mobile command palette / search modal.
 *
 * Adapted from the frontend's command-palette.tsx.
 * Full-screen modal with:
 * - Search input (auto-focused)
 * - Suggestions: quick actions + navigation
 * - Recent sessions (last 5)
 * - Fuzzy search across everything
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Modal,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  Text as RNText,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Fuse from 'fuse.js';
import * as Haptics from 'expo-haptics';

import type { Session } from '@/lib/opencode/types';
import { searchFiles } from '@/lib/utils/file-search';
import { getAuthToken } from '@/api/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandItem {
  id: string;
  label: string;
  icon: string; // Ionicons name
  group: 'action' | 'navigation';
  /** Called when this item is selected */
  onSelect: () => void;
}

interface CommandPaletteProps {
  visible: boolean;
  onClose: () => void;
  /** All sessions (for recent + search) */
  sessions: Session[];
  /** Create new session */
  onNewSession: () => void;
  /** Navigate to a session */
  onSessionSelect: (sessionId: string) => void;
  /** Navigate to a page tab */
  onPageSelect: (pageId: string) => void;
  /** Navigate to settings */
  onSettings: () => void;
  /** Sandbox URL for file search */
  sandboxUrl?: string;
  /** Called when a file is selected */
  onFileSelect?: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
  visible,
  onClose,
  sessions,
  onNewSession,
  onSessionSelect,
  onPageSelect,
  onSettings,
  sandboxUrl,
  onFileSelect,
}: CommandPaletteProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');

  // File search mode — separated from fast search (like web)
  const [fileSearchMode, setFileSearchMode] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout>>();
  const fileSearchSeq = useRef(0);

  // Auto-focus and reset on open
  useEffect(() => {
    if (visible) {
      setQuery('');
      setFileSearchMode(false);
      setFileResults([]);
      setFileSearchLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  // File search — only runs when in file search mode
  useEffect(() => {
    clearTimeout(fileSearchTimer.current);

    if (!fileSearchMode || !query.trim() || !sandboxUrl || !visible) {
      if (fileSearchMode && !query.trim()) {
        setFileResults([]);
        setFileSearchLoading(false);
      }
      return;
    }

    setFileSearchLoading(true);
    const seq = ++fileSearchSeq.current;

    fileSearchTimer.current = setTimeout(async () => {
      try {
        const results = await searchFiles(sandboxUrl, query.trim());
        if (seq === fileSearchSeq.current) {
          setFileResults(results);
          setFileSearchLoading(false);
        }
      } catch {
        if (seq === fileSearchSeq.current) {
          setFileResults([]);
          setFileSearchLoading(false);
        }
      }
    }, 250);

    return () => clearTimeout(fileSearchTimer.current);
  }, [query, sandboxUrl, visible, fileSearchMode]);

  const enterFileSearchMode = useCallback(() => {
    setFileSearchMode(true);
    setQuery('');
    setFileResults([]);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const exitFileSearchMode = useCallback(() => {
    setFileSearchMode(false);
    setQuery('');
    setFileResults([]);
    setFileSearchLoading(false);
  }, []);

  // ── Command items ───────────────────────────────────────────────────────

  // Runtime reload handler
  const handleRuntimeReload = useCallback(async (mode: 'dispose-only' | 'full') => {
    if (!sandboxUrl) return;
    onClose();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const doReload = async () => {
      try {
        const token = await getAuthToken();
        const res = await fetch(`${sandboxUrl}/kortix/services/system/reload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ mode }),
        });
        if (res.ok) {
          Alert.alert(
            'Success',
            mode === 'full'
              ? 'Full restart initiated — all managed services will come back up.'
              : 'Config reloaded — agents, skills, and commands refreshed.',
          );
        } else {
          Alert.alert('Error', 'Restart failed');
        }
      } catch {
        Alert.alert('Error', 'Restart failed');
      }
    };

    if (mode === 'full') {
      Alert.alert(
        'Full Restart',
        'This will kill and restart every service (OpenCode, static server, kortix-master). Active sessions will be interrupted.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Restart', style: 'destructive', onPress: doReload },
        ],
      );
    } else {
      doReload();
    }
  }, [sandboxUrl, onClose]);

  const commandItems: CommandItem[] = useMemo(
    () => [
      // ── Actions (matching web order) ──
      {
        id: 'newSession',
        label: 'New Session',
        icon: 'add-outline',
        group: 'action',
        onSelect: () => { onNewSession(); onClose(); },
      },
      {
        id: 'page:terminal',
        label: 'Open Terminal',
        icon: 'terminal-outline',
        group: 'action',
        onSelect: () => { onPageSelect('page:terminal'); onClose(); },
      },
      {
        id: 'restart-config',
        label: 'Restart: Config Only',
        icon: 'refresh-outline',
        group: 'action',
        onSelect: () => handleRuntimeReload('dispose-only'),
      },
      {
        id: 'restart-full',
        label: 'Restart: Full',
        icon: 'refresh-outline',
        group: 'action',
        onSelect: () => handleRuntimeReload('full'),
      },
      // ── Navigation (matching web order) ──
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: 'grid-outline',
        group: 'navigation',
        onSelect: () => { onSessionSelect(''); onClose(); },
      },
      {
        id: 'page:projects',
        label: 'Projects',
        icon: 'folder-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:projects'); onClose(); },
      },
      {
        id: 'page:triggers',
        label: 'Scheduled Tasks',
        icon: 'calendar-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:triggers'); onClose(); },
      },
      {
        id: 'page:channels',
        label: 'Channels',
        icon: 'chatbox-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:channels'); onClose(); },
      },
      {
        id: 'page:integrations',
        label: 'Connectors',
        icon: 'git-branch-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:integrations'); onClose(); },
      },
      {
        id: 'page:files',
        label: 'Files',
        icon: 'folder-open-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:files'); onClose(); },
      },
      {
        id: 'page:browser',
        label: 'Browser',
        icon: 'compass-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:browser'); onClose(); },
      },
      {
        id: 'page:memory',
        label: 'Memory',
        icon: 'hardware-chip-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:memory'); onClose(); },
      },
      {
        id: 'page:marketplace',
        label: 'Marketplace',
        icon: 'sparkles-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:marketplace'); onClose(); },
      },
      {
        id: 'page:llm-providers',
        label: 'LLM Providers',
        icon: 'cube-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:llm-providers'); onClose(); },
      },
      {
        id: 'page:secrets',
        label: 'Secrets Manager',
        icon: 'key-outline',
        group: 'navigation',
        onSelect: () => { onPageSelect('page:secrets'); onClose(); },
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings-outline',
        group: 'navigation',
        onSelect: () => { onSettings(); onClose(); },
      },
    ],
    [onNewSession, onSessionSelect, onPageSelect, onSettings, onClose, handleRuntimeReload],
  );

  // ── Recent sessions (last 5, non-archived) ─────────────────────────────

  const recentSessions = useMemo(() => {
    const active = sessions.filter((s) => !(s.time as any).archived);
    return active.slice(0, 5);
  }, [sessions]);

  // ── Search ──────────────────────────────────────────────────────────────

  const hasQuery = query.trim().length > 0;

  // Fuse instances
  const commandFuse = useMemo(
    () =>
      new Fuse(commandItems, {
        keys: ['label'],
        threshold: 0.4,
        includeScore: true,
      }),
    [commandItems],
  );

  const sessionFuse = useMemo(
    () =>
      new Fuse(
        sessions.filter((s) => !(s.time as any).archived),
        {
          keys: ['title'],
          threshold: 0.4,
          includeScore: true,
        },
      ),
    [sessions],
  );

  const filteredCommands = useMemo(() => {
    if (!hasQuery) return [];
    return commandFuse.search(query).map((r) => r.item);
  }, [query, hasQuery, commandFuse]);

  const filteredSessions = useMemo(() => {
    if (!hasQuery) return [];
    return sessionFuse.search(query).map((r) => r.item);
  }, [query, hasQuery, sessionFuse]);

  // ── Helpers ─────────────────────────────────────────────────────────────

  const handleSessionPress = useCallback(
    (sessionId: string) => {
      onSessionSelect(sessionId);
      onClose();
    },
    [onSessionSelect, onClose],
  );

  const formatTime = useCallback((session: Session) => {
    const created = (session.time as any)?.created;
    if (!created) return '';
    const date = typeof created === 'number'
      ? new Date(created < 1e12 ? created * 1000 : created)
      : new Date(created);
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }, []);

  // ── Colors ──────────────────────────────────────────────────────────────

  const bgColor = isDark ? '#121215' : '#FFFFFF';
  const cardBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#999';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const hoverBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const sectionColor = isDark ? '#666' : '#999';

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Backdrop */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'flex-start',
        }}
      >
        {/* Content card — tap doesn't propagate to backdrop */}
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={{
            marginTop: insets.top + 12,
            marginHorizontal: 16,
            borderRadius: 16,
            backgroundColor: bgColor,
            borderWidth: 1,
            borderColor,
            maxHeight: '70%',
            overflow: 'hidden',
            // Shadow
            ...Platform.select({
              ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.25,
                shadowRadius: 24,
              },
              android: { elevation: 16 },
            }),
          }}
        >
          {/* Search input */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: borderColor,
            }}
          >
            {fileSearchMode ? (
              <TouchableOpacity onPress={exitFileSearchMode} hitSlop={8} style={{ marginRight: 8 }}>
                <Ionicons name="arrow-back" size={18} color={mutedColor} />
              </TouchableOpacity>
            ) : (
              <Ionicons
                name="search-outline"
                size={18}
                color={mutedColor}
                style={{ marginRight: 10 }}
              />
            )}
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder={fileSearchMode ? "Search files..." : "Search commands, sessions..."}
              placeholderTextColor={mutedColor}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (fileSearchMode) return; // file search handles its own results
                // Select first result if available
                if (filteredCommands.length > 0) {
                  filteredCommands[0].onSelect();
                } else if (filteredSessions.length > 0) {
                  handleSessionPress(filteredSessions[0].id);
                }
              }}
              style={{
                flex: 1,
                fontSize: 16,
                color: fgColor,
                paddingVertical: 0,
              }}
            />
            {hasQuery && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={mutedColor} />
              </TouchableOpacity>
            )}
          </View>

          {/* Results */}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {fileSearchMode ? (
              /* ── File Search Mode ── */
              <>
                {!hasQuery && (
                  <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                    <Ionicons name="folder-open-outline" size={28} color={mutedColor} style={{ marginBottom: 8, opacity: 0.5 }} />
                    <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: mutedColor }}>
                      Type to search files
                    </RNText>
                  </View>
                )}

                {fileResults.length > 0 && (
                  <>
                    <SectionHeader label="FILES" color={sectionColor} />
                    {fileResults.slice(0, 20).map((filePath) => (
                      <FileRow
                        key={filePath}
                        filePath={filePath}
                        onPress={() => {
                          onFileSelect?.(filePath);
                          onClose();
                        }}
                        fgColor={fgColor}
                        mutedColor={mutedColor}
                      />
                    ))}
                  </>
                )}

                {fileSearchLoading && fileResults.length === 0 && hasQuery && (
                  <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={mutedColor} />
                    <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 8 }}>
                      Searching files...
                    </RNText>
                  </View>
                )}

                {!fileSearchLoading && hasQuery && fileResults.length === 0 && (
                  <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                    <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: mutedColor }}>
                      No files found
                    </RNText>
                  </View>
                )}
              </>
            ) : !hasQuery ? (
              /* ── Default: Suggestions ── */
              <>
                <SectionHeader label="SUGGESTIONS" color={sectionColor} />

                {/* Search Files — top entry, before other commands */}
                {sandboxUrl && (
                  <CommandRow
                    icon="document-text-outline"
                    label="Search Files..."
                    onPress={enterFileSearchMode}
                    fgColor={fgColor}
                    mutedColor={mutedColor}
                    hoverBg={hoverBg}
                  />
                )}

                {commandItems.map((item) => (
                  <CommandRow
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    onPress={item.onSelect}
                    fgColor={fgColor}
                    mutedColor={mutedColor}
                    hoverBg={hoverBg}
                  />
                ))}

                {recentSessions.length > 0 && (
                  <>
                    <SectionHeader label="RECENT" color={sectionColor} />
                    {recentSessions.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        timeLabel={formatTime(s)}
                        onPress={() => handleSessionPress(s.id)}
                        fgColor={fgColor}
                        mutedColor={mutedColor}
                        hoverBg={hoverBg}
                      />
                    ))}
                  </>
                )}
              </>
            ) : (
              /* ── Filtered results (commands + sessions only, no files) ── */
              <>
                {filteredCommands.length > 0 && (
                  <>
                    <SectionHeader label="COMMANDS" color={sectionColor} />
                    {filteredCommands.map((item) => (
                      <CommandRow
                        key={item.id}
                        icon={item.icon}
                        label={item.label}
                        onPress={item.onSelect}
                        fgColor={fgColor}
                        mutedColor={mutedColor}
                        hoverBg={hoverBg}
                      />
                    ))}
                  </>
                )}

                {filteredSessions.length > 0 && (
                  <>
                    <SectionHeader label="SESSIONS" color={sectionColor} />
                    {filteredSessions.slice(0, 10).map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        timeLabel={formatTime(s)}
                        onPress={() => handleSessionPress(s.id)}
                        fgColor={fgColor}
                        mutedColor={mutedColor}
                        hoverBg={hoverBg}
                      />
                    ))}
                  </>
                )}

                {/* Quick link to file search from filtered view */}
                {sandboxUrl && (
                  <>
                    <SectionHeader label="FILES" color={sectionColor} />
                    <CommandRow
                      icon="search-outline"
                      label={`Search files for "${query}"`}
                      onPress={() => {
                        setFileSearchMode(true);
                        // Keep query, trigger file search
                      }}
                      fgColor={fgColor}
                      mutedColor={mutedColor}
                      hoverBg={hoverBg}
                    />
                  </>
                )}

                {filteredCommands.length === 0 && filteredSessions.length === 0 && (
                  <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                    <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: mutedColor }}>
                      No commands or sessions found
                    </RNText>
                    {sandboxUrl && (
                      <TouchableOpacity
                        onPress={() => setFileSearchMode(true)}
                        style={{ marginTop: 8 }}
                      >
                        <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isDark ? '#60a5fa' : '#2563eb' }}>
                          Search files instead →
                        </RNText>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <RNText
      style={{
        fontSize: 11,
        fontFamily: 'Roobert-SemiBold',
        color,
        letterSpacing: 0.8,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 6,
      }}
    >
      {label}
    </RNText>
  );
}

function CommandRow({
  icon,
  label,
  onPress,
  fgColor,
  mutedColor,
  hoverBg,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  fgColor: string;
  mutedColor: string;
  hoverBg: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
        marginHorizontal: 6,
        borderRadius: 10,
      }}
    >
      <Ionicons
        name={icon as any}
        size={18}
        color={mutedColor}
        style={{ marginRight: 12, width: 22, textAlign: 'center' }}
      />
      <RNText
        style={{
          flex: 1,
          fontSize: 15,
          fontFamily: 'Roobert',
          color: fgColor,
        }}
      >
        {label}
      </RNText>
    </TouchableOpacity>
  );
}

function SessionRow({
  session,
  timeLabel,
  onPress,
  fgColor,
  mutedColor,
  hoverBg,
}: {
  session: Session;
  timeLabel: string;
  onPress: () => void;
  fgColor: string;
  mutedColor: string;
  hoverBg: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
        marginHorizontal: 6,
        borderRadius: 10,
      }}
    >
      <Ionicons
        name="chatbubble-outline"
        size={16}
        color={mutedColor}
        style={{ marginRight: 12, width: 22, textAlign: 'center' }}
      />
      <RNText
        numberOfLines={1}
        style={{
          flex: 1,
          fontSize: 15,
          fontFamily: 'Roobert',
          color: fgColor,
        }}
      >
        {session.title || 'New Session'}
      </RNText>
      {timeLabel ? (
        <RNText
          style={{
            fontSize: 12,
            fontFamily: 'Roobert',
            color: mutedColor,
            marginLeft: 8,
          }}
        >
          {timeLabel}
        </RNText>
      ) : null}
    </TouchableOpacity>
  );
}

function FileRow({
  filePath,
  onPress,
  fgColor,
  mutedColor,
}: {
  filePath: string;
  onPress: () => void;
  fgColor: string;
  mutedColor: string;
}) {
  const fileName = filePath.split('/').pop() || filePath;
  // Show parent directory for context
  const parts = filePath.split('/');
  const dirPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
        marginHorizontal: 6,
        borderRadius: 10,
      }}
    >
      <Ionicons
        name="document-outline"
        size={16}
        color={mutedColor}
        style={{ marginRight: 12, width: 22, textAlign: 'center' }}
      />
      <View style={{ flex: 1 }}>
        <RNText
          numberOfLines={1}
          style={{
            fontSize: 15,
            fontFamily: 'Roobert',
            color: fgColor,
          }}
        >
          {fileName}
        </RNText>
        {dirPath ? (
          <RNText
            numberOfLines={1}
            style={{
              fontSize: 11,
              fontFamily: 'Roobert',
              color: mutedColor,
              marginTop: 1,
            }}
          >
            {dirPath}
          </RNText>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}
