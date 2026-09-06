/**
 * FilesNavPage — the project's repo files (web parity: features/project-files).
 * A READ-ONLY git-repo browser: the `/files` endpoint returns a FLAT recursive
 * file list, so folders are derived client-side from the paths. Browse by
 * version (branch), view file content, see a file's history, and download a
 * file or a subtree zip. No write/rename/delete (project files come from git).
 *
 * Mobile branding: reuses the old files page's FileItem rows + preview
 * renderers, with PageHeader + PageContent chrome.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  Dimensions,
  Animated,
  Easing,
  RefreshControl,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import {
  GitBranch,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowDownUp,
  Download,
  RefreshCw,
  Folder,
  FolderOpen,
  Check,
  X,
  History,
  GitCommitHorizontal,
  LayoutGrid,
  List,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { FileItem, getFileIconComponent, getMutedIconColor } from '@/components/files/FileItem';
import { FilePreview, getFilePreviewType } from '@/components/files/FilePreviewRenderers';
import { PatchDiffView } from '@/components/diff/PatchDiffView';
import { relativeTime } from '@/lib/projects/triggers-format';
import {
  useProjectBranches,
  useProjectFiles,
  useProjectFileContent,
  useProjectFileHistory,
  useProjectCommitDiff,
} from '@/lib/projects/hooks';
import { projectArchiveUrl } from '@/lib/projects/projects-client';
import type { ProjectFileEntry, ProjectBranch, ProjectCommit } from '@/lib/projects/projects-client';
import type { SandboxFile } from '@/api/types';
import { getAuthToken } from '@/api/config';
import { haptics } from '@/lib/haptics';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface FilesNavPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortRef = (ref: string) => (UUID_RE.test(ref) ? ref.slice(0, 8) : ref);
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const ext = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

// Pinned, described config dirs (web parity).
const ELEVATED: Record<string, string> = {
  '.kortix': 'Project config, tasks, context',
  '.opencode': 'Agents, skills, commands',
};

type SortBy = 'name' | 'type';
type SortOrder = 'asc' | 'desc';

/** Immediate children of `dir` derived from the flat file list. */
function childrenOf(entries: ProjectFileEntry[], dir: string): { dirs: string[]; files: ProjectFileEntry[] } {
  const prefix = dir ? `${dir}/` : '';
  const dirSet = new Set<string>();
  const files: ProjectFileEntry[] = [];
  for (const e of entries) {
    if (dir && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) files.push(e);
    else dirSet.add(rest.slice(0, slash));
  }
  return { dirs: [...dirSet], files };
}

async function downloadAndShare(url: string, filename: string, withAuth: boolean) {
  const target = `${FileSystem.cacheDirectory}${filename}`;
  if (withAuth) {
    const token = await getAuthToken();
    const res = await FileSystem.downloadAsync(url, target, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status >= 400) throw new Error(`Download failed (${res.status})`);
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target);
}

async function saveTextAndShare(content: string, filename: string) {
  const target = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(target, content);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target);
}

// ─── Version selector sheet ───────────────────────────────────────────────────

function VersionSheet({
  branches,
  defaultBranch,
  value,
  onSelect,
  onClose,
  onRetry,
  isLoading,
  isDark,
}: {
  branches: ProjectBranch[];
  defaultBranch: string;
  value: string;
  onSelect: (ref: string) => void;
  onClose: () => void;
  onRetry?: () => void;
  isLoading?: boolean;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);
  const closeBg = withAlpha(fg, isDark ? 0.05 : 0.04);

  const sorted = useMemo(() => {
    const def = branches.filter((b) => b.is_default);
    const rest = branches.filter((b) => !b.is_default);
    return [...def, ...rest];
  }, [branches]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Version</Text>
        <Button variant="ghost" size="icon" className="h-[30px] w-[30px] rounded-full" onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ backgroundColor: closeBg }}>
          <Icon as={X} size={17} color={muted} />
        </Button>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6, flexGrow: 1 }} showsVerticalScrollIndicator={false}>
        {sorted.length > 0 ? (
          sorted.map((b) => {
            const on = b.name === value;
            return (
              <Pressable
                key={b.name}
                onPress={() => { haptics.selection(); onSelect(b.name); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}
              >
                <Icon as={GitBranch} size={18} color={on ? theme.primary : muted} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 14.5, fontFamily: 'Menlo', color: on ? theme.primary : fg }} numberOfLines={1}>{shortRef(b.name)}</Text>
                    {b.is_default && <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: muted }}>MAIN</Text>}
                  </View>
                  <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }} numberOfLines={1}>
                    {b.subject || 'No commits'}{b.committed_at ? ` · ${relativeTime(b.committed_at)}` : ''}
                  </Text>
                </View>
                {on && <Icon as={Check} size={17} color={theme.primary} />}
              </Pressable>
            );
          })
        ) : isLoading ? (
          <View style={{ paddingVertical: 48, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={muted} />
          </View>
        ) : (
          // Branch listing came back empty (the repo's git mirror is unavailable —
          // the API returns the default branch but no list). Never show a blank
          // sheet: keep the current version as a normal list row up top, then a
          // proper empty state for the rest.
          <View style={{ flex: 1 }}>
            {value ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
                  <Icon as={GitBranch} size={18} color={theme.primary} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 14.5, fontFamily: 'Menlo', color: theme.primary }} numberOfLines={1}>{shortRef(value)}</Text>
                      {value === defaultBranch && <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: muted }}>MAIN</Text>}
                    </View>
                    <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }}>Current version</Text>
                  </View>
                  <Icon as={Check} size={17} color={theme.primary} />
                </View>
                <View style={{ height: 1, backgroundColor: border, marginHorizontal: 16 }} />
              </>
            ) : null}
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, paddingVertical: 32, gap: 6 }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 10,
                  backgroundColor: withAlpha(fg, isDark ? 0.05 : 0.04),
                }}
              >
                <Icon
                  as={GitBranch}
                  size={26}
                  strokeWidth={1.5}
                  color={withAlpha(fg, 0.25)}
                />
              </View>
              <Text style={{ fontSize: 15.5, fontFamily: 'Roobert-Medium', color: fg, textAlign: 'center' }}>
                No other versions yet
              </Text>
              <Text style={{ fontSize: 13, color: muted, textAlign: 'center', lineHeight: 19 }}>
                Branches couldn’t be loaded — the repository may still be preparing.
              </Text>
              {onRetry ? (
                <Button
                  onPress={() => { haptics.tap(); onRetry(); }}
                  className="mt-3.5 rounded-full px-[22px] py-[11px]"
                  style={{ backgroundColor: fg }}
                >
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: isDark ? THEME.light.foreground : THEME.dark.foreground }}>
                    Try again
                  </Text>
                </Button>
              ) : null}
            </View>
          </View>
        )}
      </BottomSheetScrollView>
    </View>
  );
}

// ─── File viewer (full-screen modal) ──────────────────────────────────────────

function FileViewerModal({
  projectId,
  ref_,
  files,
  index,
  onNavigate,
  onClose,
  isDark,
}: {
  projectId: string;
  ref_: string;
  files: { name: string; path: string }[];
  index: number;
  onNavigate: (i: number) => void;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const file = files[index];
  const [view, setView] = useState<'content' | 'history'>('content');
  const [historyCommit, setHistoryCommit] = useState<ProjectCommit | null>(null);
  const [busy, setBusy] = useState(false);

  const content = useProjectFileContent(projectId, file?.path ?? null, ref_);
  const history = useProjectFileHistory(projectId, view === 'history' ? (file?.path ?? null) : null, ref_);

  const bg = isDark ? THEME.dark.background : THEME.light.background;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);
  const chipBg = withAlpha(fg, isDark ? 0.06 : 0.04);

  // Reset to content when navigating files.
  useEffect(() => { setView('content'); setHistoryCommit(null); }, [file?.path]);

  if (!file) return null;
  const previewType = getFilePreviewType(file.name);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const text = content.data?.content ?? '';
      await saveTextAndShare(text, basename(file.name));
      haptics.tap();
    } catch (e: any) {
      Alert.alert('Download failed', e?.message || 'Could not download the file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: border }}>
          <Button variant="ghost" size="icon" className="h-9 w-9" onPress={() => { haptics.tap(); onClose(); }} hitSlop={8}>
            <Icon as={ChevronLeft} size={22} color={fg} />
          </Button>
          <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{file.name}</Text>
          {files.length > 1 && view === 'content' && (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onPress={() => onNavigate(index - 1)} hitSlop={6} style={{ opacity: index === 0 ? 0.35 : 1 }}>
                <Icon as={ChevronLeft} size={18} color={fg} />
              </Button>
              <Text style={{ fontSize: 12, color: muted, minWidth: 30, textAlign: 'center' }}>{index + 1}/{files.length}</Text>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === files.length - 1} onPress={() => onNavigate(index + 1)} hitSlop={6} style={{ opacity: index === files.length - 1 ? 0.35 : 1 }}>
                <Icon as={ChevronRight} size={18} color={fg} />
              </Button>
            </View>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onPress={() => { haptics.tap(); setHistoryCommit(null); setView(view === 'history' ? 'content' : 'history'); }} hitSlop={8} style={{ backgroundColor: view === 'history' ? theme.primaryLight : chipBg }}>
            <Icon as={History} size={16} color={view === 'history' ? theme.primary : muted} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onPress={download} disabled={busy} hitSlop={8} style={{ backgroundColor: chipBg }}>
            {busy ? <ActivityIndicator size="small" color={muted} /> : <Icon as={Download} size={16} color={muted} />}
          </Button>
        </View>

        {/* Body */}
        {view === 'history' ? (
          <FileHistoryView historyQuery={history} onSelectCommit={setHistoryCommit} isDark={isDark} />
        ) : content.isLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
        ) : content.isError ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
            <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>This file can't be shown as text. Download it to view.</Text>
            <Button variant="outline" size="sm" className="rounded-full gap-1.5" onPress={download} style={{ borderColor: border }}>
              <Icon as={Download} size={15} color={fg} />
              <Text style={{ fontFamily: 'Roobert-Medium', color: fg }}>Download</Text>
            </Button>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <FilePreview content={content.data?.content ?? ''} fileName={file.name} previewType={previewType} filePath={file.path} />
          </View>
        )}

        {/* Checkpoint changes — animated bottom sheet */}
        <CheckpointSheet commit={historyCommit} projectId={projectId} path={file.path} isDark={isDark} onClose={() => setHistoryCommit(null)} />
      </View>
    </Modal>
  );
}

function CheckpointSheet({
  commit,
  projectId,
  path,
  isDark,
  onClose,
}: {
  commit: ProjectCommit | null;
  projectId: string;
  path: string;
  isDark: boolean;
  onClose: () => void;
}) {
  const sheetBg = useSheetBackground();
  const insets = useSafeAreaInsets();
  const H = Dimensions.get('window').height;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);
  const chipBg = withAlpha(fg, isDark ? 0.06 : 0.04);

  // Keep the last commit rendered while the close animation plays out.
  const [rendered, setRendered] = useState<ProjectCommit | null>(commit);
  const translateY = useRef(new Animated.Value(H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (commit) {
      setRendered(commit);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 24, stiffness: 260, mass: 0.9 }),
        Animated.timing(backdrop, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: H, duration: 220, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => { if (finished) setRendered(null); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit]);

  if (!rendered) return null;

  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' }} pointerEvents="box-none">
      <Animated.View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' /* hex-allowlist: fixed modal scrim, matches gorhom's own SheetBackdrop default (opacity 0.5 black), not a themed surface */, opacity: backdrop }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateY }], backgroundColor: sheetBg, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', paddingBottom: insets.bottom }}>
        <View style={{ alignItems: 'center', paddingTop: 8 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: withAlpha(fg, 0.2) }} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>Checkpoint changes</Text>
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={2}>{rendered.subject || '(no message)'}</Text>
            <Text style={{ fontSize: 12, color: muted, marginTop: 2 }} numberOfLines={1}>
              {rendered.author_name || 'Unknown'} · {relativeTime(rendered.committed_at || rendered.authored_at)} · <Text style={{ fontFamily: 'Menlo' }}>{rendered.short_hash}</Text>
            </Text>
          </View>
          <Button variant="ghost" size="icon" className="h-[30px] w-[30px] rounded-full" onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ backgroundColor: chipBg }}>
            <Icon as={X} size={17} color={muted} />
          </Button>
        </View>
        <ScrollView style={{ maxHeight: H * 0.58 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
          <CommitDiff projectId={projectId} sha={rendered.hash} path={path} isDark={isDark} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function FileHistoryView({
  historyQuery,
  onSelectCommit,
  isDark,
}: {
  historyQuery: ReturnType<typeof useProjectFileHistory>;
  onSelectCommit: (c: ProjectCommit) => void;
  isDark: boolean;
}) {
  const insets = useSafeAreaInsets();
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);
  const commits = historyQuery.data?.commits ?? [];

  if (historyQuery.isLoading) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="small" color={muted} /></View>;
  }
  if (historyQuery.isError || commits.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{historyQuery.isError ? "Couldn't load history." : 'No checkpoints for this file yet.'}</Text>
      </View>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 20 }} showsVerticalScrollIndicator={false}>
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 }}>
        {commits.length} {commits.length === 1 ? 'checkpoint' : 'checkpoints'} · tap to see changes
      </Text>
      {commits.map((c, i) => (
        <Pressable
          key={c.hash}
          onPress={() => { haptics.tap(); onSelectCommit(c); }}
          style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}
        >
          <Icon as={GitCommitHorizontal} size={18} color={muted} style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={2}>{c.subject || '(no message)'}</Text>
            <Text style={{ fontSize: 12.5, color: muted, marginTop: 3 }} numberOfLines={1}>
              {c.author_name || 'Unknown'} · {relativeTime(c.committed_at || c.authored_at)} · <Text style={{ fontFamily: 'Menlo' }}>{c.short_hash}</Text>
            </Text>
          </View>
          <Icon as={ChevronRight} size={18} color={muted} style={{ marginTop: 1 }} />
        </Pressable>
      ))}
      {historyQuery.data?.hasMore && (
        <Text style={{ fontSize: 12, color: muted, textAlign: 'center', marginTop: 12 }}>Showing the most recent {commits.length} checkpoints.</Text>
      )}
    </ScrollView>
  );
}

function CommitDiff({ projectId, sha, path, isDark }: { projectId: string; sha: string; path: string; isDark: boolean }) {
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const diff = useProjectCommitDiff(projectId, sha, path);
  if (diff.isLoading) {
    return <View style={{ paddingVertical: 18, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>;
  }
  if (diff.isError || !diff.data) {
    return <Text style={{ fontSize: 13, color: muted, paddingVertical: 8 }}>Couldn't load this checkpoint's diff.</Text>;
  }
  return <PatchDiffView patch={diff.data.patch} isDark={isDark} />;
}

// ─── File row ─────────────────────────────────────────────────────────────────

// Grid card — identical chrome to the old Files page's FileRowCard (bordered
// rounded card, monochrome icon, 2-up wrap) so both Files surfaces look alike.
function FileCard({
  file,
  isDark,
  onPress,
}: {
  file: SandboxFile;
  isDark: boolean;
  onPress: (f: SandboxFile) => void;
}) {
  const FileIcon = getFileIconComponent(file);
  const iconColor = getMutedIconColor(isDark);
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  return (
    <Pressable
      onPress={() => { haptics.tap(); onPress(file); }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: 12,
          borderWidth: 1,
          borderColor: withAlpha(fg, 0.1),
          backgroundColor: isDark ? THEME.dark.surface : THEME.light.background,
          paddingHorizontal: 12,
          paddingVertical: 10,
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      <FileIcon size={18} color={iconColor} strokeWidth={2} style={{ marginRight: 8 }} />
      <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
        {file.name}
      </Text>
    </Pressable>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function FilesNavPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: FilesNavPageProps) {
  const sheetBg = useSheetBackground();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const [ref_, setRef] = useState<string>('');
  const [path, setPath] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [downloadingDir, setDownloadingDir] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const versionSheetRef = React.useRef<BottomSheetModal>(null);

  const branchesQuery = useProjectBranches(projectId);
  const defaultBranch = branchesQuery.data?.default_branch ?? '';

  // Default to the project's default branch once branches resolve.
  useEffect(() => {
    if (!ref_ && defaultBranch) setRef(defaultBranch);
  }, [defaultBranch, ref_]);

  const filesQuery = useProjectFiles(projectId, ref_);
  const entries = filesQuery.data ?? [];

  const bgColor = isDark ? THEME.dark.background : THEME.light.background;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);
  const chipBg = withAlpha(fg, isDark ? 0.05 : 0.04);

  // Build the current directory's rows.
  const rows = useMemo<SandboxFile[]>(() => {
    const { dirs, files } = childrenOf(entries, path);
    const cmp = (a: string, b: string) => {
      if (sortBy === 'type') {
        const t = ext(a).localeCompare(ext(b));
        if (t !== 0) return sortOrder === 'asc' ? t : -t;
      }
      const n = a.toLowerCase().localeCompare(b.toLowerCase());
      return sortOrder === 'asc' ? n : -n;
    };
    const elevated = dirs.filter((d) => d in ELEVATED).sort();
    const otherDirs = dirs.filter((d) => !(d in ELEVATED)).sort(cmp);
    const fileNodes = [...files].sort((a, b) => cmp(basename(a.path), basename(b.path)));
    const mk = (name: string, full: string, type: 'directory' | 'file', size?: number | null): SandboxFile => ({
      name, path: full, type, size: size ?? undefined,
    });
    return [
      ...elevated.map((d) => mk(d, path ? `${path}/${d}` : d, 'directory')),
      ...otherDirs.map((d) => mk(d, path ? `${path}/${d}` : d, 'directory')),
      ...fileNodes.map((f) => mk(basename(f.path), f.path, 'file', f.size)),
    ];
  }, [entries, path, sortBy, sortOrder]);

  const fileRows = useMemo(() => rows.filter((r) => r.type === 'file').map((r) => ({ name: r.name, path: r.path })), [rows]);
  // FOLDERS / FILES sections, same as the sandbox Files page.
  const folderEntries = useMemo(() => rows.filter((r) => r.type === 'directory'), [rows]);
  const fileEntries = useMemo(() => rows.filter((r) => r.type === 'file'), [rows]);

  const segments = path ? path.split('/').filter(Boolean) : [];

  // Loading/empty/error all render a single centered block — give the scroll
  // content flexGrow so it sits in the middle instead of clipped at the top.
  const listLoading = filesQuery.isLoading || (!ref_ && branchesQuery.isLoading);
  const listEmpty = !listLoading && !filesQuery.isError && rows.length === 0;
  const centerContent = listLoading || filesQuery.isError || listEmpty;

  const openFile = (file: SandboxFile) => {
    const idx = fileRows.findIndex((f) => f.path === file.path);
    if (idx >= 0) { haptics.tap(); setViewerIndex(idx); }
  };

  const onRowPress = (file: SandboxFile) => {
    if (file.type === 'directory') { haptics.tap(); setPath(file.path); }
    else openFile(file);
  };

  const cycleSort = () => {
    haptics.selection();
    if (sortBy === 'name' && sortOrder === 'asc') { setSortOrder('desc'); }
    else if (sortBy === 'name' && sortOrder === 'desc') { setSortBy('type'); setSortOrder('asc'); }
    else if (sortBy === 'type' && sortOrder === 'asc') { setSortOrder('desc'); }
    else { setSortBy('name'); setSortOrder('asc'); }
  };
  const sortLabel = `${sortBy === 'name' ? 'Name' : 'Type'} ${sortOrder === 'asc' ? '↑' : '↓'}`;

  const downloadDir = async () => {
    if (downloadingDir || !ref_) return;
    setDownloadingDir(true);
    try {
      const name = (path ? basename(path) : (projectId ? 'workspace' : 'repo')) || 'workspace';
      await downloadAndShare(projectArchiveUrl(projectId, ref_, path || undefined), `${name}.zip`, true);
      haptics.tap();
    } catch (e: any) {
      Alert.alert('Download failed', e?.message || 'Could not download the archive.');
    } finally {
      setDownloadingDir(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onPress={() => { haptics.selection(); setViewMode((v) => (v === 'list' ? 'grid' : 'list')); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon as={viewMode === 'list' ? LayoutGrid : List} size={18} color={fg} strokeWidth={2} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onPress={() => filesQuery.refetch()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              {filesQuery.isFetching ? <ActivityIndicator size="small" color={muted} /> : <Icon as={RefreshCw} size={18} color={fg} />}
            </Button>
          </View>
        }
      />

      <PageContent>
        {/* Toolbar: version · sort · download */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10 }}>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full gap-1.5"
            onPress={() => { haptics.tap(); versionSheetRef.current?.present(); }}
            style={{ borderColor: border }}
          >
            <Icon as={GitBranch} size={14} color={muted} />
            <Text style={{ color: fg, maxWidth: 120 }} numberOfLines={1}>{ref_ ? shortRef(ref_) : '—'}</Text>
            {ref_ === defaultBranch && defaultBranch ? <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: muted }}>MAIN</Text> : null}
            <Icon as={ChevronDown} size={14} color={muted} />
          </Button>
          <View style={{ flex: 1 }} />
          <Button variant="outline" size="sm" className="rounded-full gap-1" onPress={cycleSort} style={{ borderColor: border }}>
            <Icon as={ArrowDownUp} size={13} color={muted} />
            <Text style={{ color: muted }}>{sortLabel}</Text>
          </Button>
          <Button variant="ghost" size="icon" className="h-[34px] w-[34px] rounded-full" onPress={downloadDir} disabled={downloadingDir} hitSlop={6} style={{ backgroundColor: chipBg, opacity: downloadingDir ? 0.6 : 1 }}>
            {downloadingDir ? <ActivityIndicator size="small" color={muted} /> : <Icon as={Download} size={16} color={muted} />}
          </Button>
        </View>

        {/* Breadcrumb */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, maxHeight: 40 }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, gap: 2 }}>
          <Pressable onPress={() => { if (path) { haptics.tap(); setPath(''); } }} disabled={!path} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingRight: 4 }}>
            <Icon as={Folder} size={15} color={path ? muted : fg} />
            <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: path ? muted : fg }}>Files</Text>
          </Pressable>
          {segments.map((seg, i) => {
            const segPath = segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={segPath}>
                <Icon as={ChevronRight} size={14} color={muted} />
                <Pressable onPress={() => { if (!last) { haptics.tap(); setPath(segPath); } }} disabled={last} style={{ paddingVertical: 4, paddingHorizontal: 2 }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: last ? fg : muted }} numberOfLines={1}>{seg}</Text>
                </Pressable>
              </React.Fragment>
            );
          })}
        </ScrollView>

        {/* File list */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40, paddingTop: 4, ...(centerContent ? { flexGrow: 1, justifyContent: 'center' } : null) }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={filesQuery.isRefetching} onRefresh={() => filesQuery.refetch()} />
          }
        >
          {listLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : filesQuery.isError ? (
            <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(filesQuery.error as Error)?.message ?? 'Failed to load files'}</Text>
              <Button variant="outline" size="sm" className="rounded-full" onPress={() => filesQuery.refetch()} style={{ borderColor: border }}>
                <Text style={{ fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </Button>
            </View>
          ) : listEmpty ? (
            <View style={{ paddingHorizontal: 36, paddingVertical: 40, alignItems: 'center', gap: 10 }}>
              <Icon as={FolderOpen} size={30} color={muted} />
              <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, textAlign: 'center' }}>{path ? 'This folder is empty' : 'No files in this version'}</Text>
              {!path && (
                <Text style={{ fontSize: 13, color: muted, textAlign: 'center', lineHeight: 19 }}>
                  These are the project’s git files — they’re read-only here. To add or edit files, ask the agent in a session, or open a different version.
                </Text>
              )}
              <Button variant="outline" size="sm" className="mt-1 rounded-full" onPress={() => { haptics.tap(); filesQuery.refetch(); branchesQuery.refetch(); }} style={{ borderColor: border }}>
                <Text style={{ fontFamily: 'Roobert-Medium', color: fg }}>Refresh</Text>
              </Button>
            </View>
          ) : viewMode === 'grid' ? (
            /* ── Grid view — FOLDERS / FILES sections of 2-up cards (old Files page UI) ── */
            <>
              {folderEntries.length > 0 && (
                <View className="px-4 pt-3">
                  <Text
                    className="text-xs font-roobert-medium mb-3 uppercase tracking-wider"
                    style={{ color: withAlpha(fg, 0.4) }}
                  >
                    Folders
                  </Text>
                  <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
                    {folderEntries.map((file) => (
                      <View key={file.path} style={{ width: '50%', paddingHorizontal: 4, marginBottom: 8 }}>
                        <FileCard file={file} isDark={isDark} onPress={onRowPress} />
                      </View>
                    ))}
                  </View>
                </View>
              )}
              {fileEntries.length > 0 && (
                <View className="px-4 pt-2">
                  <Text
                    className="text-xs font-roobert-medium mb-3 uppercase tracking-wider"
                    style={{ color: withAlpha(fg, 0.4) }}
                  >
                    Files
                  </Text>
                  <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
                    {fileEntries.map((file) => (
                      <View key={file.path} style={{ width: '50%', paddingHorizontal: 4, marginBottom: 8 }}>
                        <FileCard file={file} isDark={isDark} onPress={onRowPress} />
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </>
          ) : (
            /* ── List view — FOLDERS / FILES sections of FileItem rows (old Files page UI) ── */
            <View className="px-4 pt-2">
              {folderEntries.length > 0 && (
                <View className="mb-2">
                  <Text
                    className="text-xs font-roobert-medium mb-2 uppercase tracking-wider px-1"
                    style={{ color: withAlpha(fg, 0.4) }}
                  >
                    Folders
                  </Text>
                  {folderEntries.map((file) => (
                    <FileItem key={file.path} file={file} onPress={onRowPress} />
                  ))}
                </View>
              )}
              {fileEntries.length > 0 && (
                <View>
                  <Text
                    className="text-xs font-roobert-medium mb-2 uppercase tracking-wider px-1"
                    style={{ color: withAlpha(fg, 0.4) }}
                  >
                    Files
                  </Text>
                  {fileEntries.map((file) => (
                    <FileItem key={file.path} file={file} onPress={onRowPress} />
                  ))}
                </View>
              )}
            </View>
          )}
        </ScrollView>
      </PageContent>

      {/* Version selector */}
      <BottomSheetModal
        ref={versionSheetRef}
        snapPoints={['65%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: sheetBg }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
        backdropComponent={SheetBackdrop}
      >
        <VersionSheet
          branches={branchesQuery.data?.branches ?? []}
          defaultBranch={defaultBranch}
          value={ref_}
          onSelect={(r) => { setRef(r); setPath(''); versionSheetRef.current?.dismiss(); }}
          onClose={() => versionSheetRef.current?.dismiss()}
          onRetry={() => branchesQuery.refetch()}
          isLoading={branchesQuery.isLoading || branchesQuery.isFetching}
          isDark={isDark}
        />
      </BottomSheetModal>

      {/* File viewer */}
      {viewerIndex != null && (
        <FileViewerModal
          projectId={projectId}
          ref_={ref_}
          files={fileRows}
          index={viewerIndex}
          onNavigate={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          isDark={isDark}
        />
      )}
    </View>
  );
}
