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

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
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
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import { getFileIconComponent } from '@/components/files/FileItem';
import { FilePreview, getFilePreviewType } from '@/components/files/FilePreviewRenderers';
import { relativeTime } from '@/lib/projects/triggers-format';
import {
  useProjectBranches,
  useProjectFiles,
  useProjectFileContent,
  useProjectFileHistory,
} from '@/lib/projects/hooks';
import { projectArchiveUrl } from '@/lib/projects/projects-client';
import type { ProjectFileEntry, ProjectBranch } from '@/lib/projects/projects-client';
import type { SandboxFile } from '@/api/types';
import { getAuthToken } from '@/api/config';
import { haptics } from '@/lib/haptics';

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
  isDark,
}: {
  branches: ProjectBranch[];
  defaultBranch: string;
  value: string;
  onSelect: (ref: string) => void;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  const sorted = useMemo(() => {
    const def = branches.filter((b) => b.is_default);
    const rest = branches.filter((b) => !b.is_default);
    return [...def, ...rest];
  }, [branches]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Version</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6 }} showsVerticalScrollIndicator={false}>
        {sorted.map((b) => {
          const on = b.name === value;
          return (
            <TouchableOpacity
              key={b.name}
              onPress={() => { haptics.selection(); onSelect(b.name); }}
              activeOpacity={0.6}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}
            >
              <GitBranch size={18} color={on ? theme.primary : muted} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ fontSize: 14.5, fontFamily: 'Menlo', color: on ? theme.primary : fg }} numberOfLines={1}>{shortRef(b.name)}</Text>
                  {b.is_default && <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: muted }}>MAIN</Text>}
                </View>
                <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }} numberOfLines={1}>
                  {b.subject || 'No commits'}{b.committed_at ? ` · ${relativeTime(b.committed_at)}` : ''}
                </Text>
              </View>
              {on && <Check size={17} color={theme.primary} />}
            </TouchableOpacity>
          );
        })}
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
  const [busy, setBusy] = useState(false);

  const content = useProjectFileContent(projectId, file?.path ?? null, ref_);
  const history = useProjectFileHistory(projectId, view === 'history' ? (file?.path ?? null) : null, ref_);

  const bg = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const chipBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  // Reset to content when navigating files.
  useEffect(() => { setView('content'); }, [file?.path]);

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
          <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ padding: 6 }}>
            <ChevronLeft size={22} color={fg} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{file.name}</Text>
          {files.length > 1 && <Text style={{ fontSize: 12, color: muted }}>{index + 1}/{files.length}</Text>}
          <TouchableOpacity onPress={() => { haptics.tap(); setView(view === 'history' ? 'content' : 'history'); }} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: view === 'history' ? theme.primaryLight : chipBg, alignItems: 'center', justifyContent: 'center' }}>
            <History size={16} color={view === 'history' ? theme.primary : muted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={download} disabled={busy} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: chipBg, alignItems: 'center', justifyContent: 'center' }}>
            {busy ? <ActivityIndicator size="small" color={muted} /> : <Download size={16} color={muted} />}
          </TouchableOpacity>
        </View>

        {/* Body */}
        {view === 'history' ? (
          <FileHistoryView projectId={projectId} path={file.path} historyQuery={history} isDark={isDark} />
        ) : content.isLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
        ) : content.isError ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
            <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>This file can't be shown as text. Download it to view.</Text>
            <TouchableOpacity onPress={download} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 9999, borderWidth: 1, borderColor: border }}>
              <Download size={15} color={fg} />
              <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: fg }}>Download</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <FilePreview content={content.data?.content ?? ''} fileName={file.name} previewType={previewType} filePath={file.path} />
          </View>
        )}

        {/* Prev / next */}
        {view === 'content' && files.length > 1 && (
          <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: border, paddingBottom: insets.bottom }}>
            <TouchableOpacity disabled={index === 0} onPress={() => onNavigate(index - 1)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, opacity: index === 0 ? 0.4 : 1 }}>
              <ChevronLeft size={18} color={fg} /><Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: fg }}>Previous</Text>
            </TouchableOpacity>
            <View style={{ width: 1, backgroundColor: border }} />
            <TouchableOpacity disabled={index === files.length - 1} onPress={() => onNavigate(index + 1)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, opacity: index === files.length - 1 ? 0.4 : 1 }}>
              <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: fg }}>Next</Text><ChevronRight size={18} color={fg} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

function FileHistoryView({
  projectId,
  path,
  historyQuery,
  isDark,
}: {
  projectId: string;
  path: string;
  historyQuery: ReturnType<typeof useProjectFileHistory>;
  isDark: boolean;
}) {
  const insets = useSafeAreaInsets();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
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
        {commits.length} {commits.length === 1 ? 'checkpoint' : 'checkpoints'}
      </Text>
      {commits.map((c, i) => (
        <View key={c.hash} style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}>
          <GitCommitHorizontal size={18} color={muted} style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={2}>{c.subject || '(no message)'}</Text>
            <Text style={{ fontSize: 12.5, color: muted, marginTop: 3 }} numberOfLines={1}>
              {c.author_name || 'Unknown'} · {relativeTime(c.committed_at || c.authored_at)} · <Text style={{ fontFamily: 'Menlo' }}>{c.short_hash}</Text>
            </Text>
          </View>
        </View>
      ))}
      {historyQuery.data?.hasMore && (
        <Text style={{ fontSize: 12, color: muted, textAlign: 'center', marginTop: 12 }}>Showing the most recent {commits.length} checkpoints.</Text>
      )}
    </ScrollView>
  );
}

// ─── File row ─────────────────────────────────────────────────────────────────

function FileRow({
  file,
  subtitle,
  onPress,
  isDark,
}: {
  file: SandboxFile;
  subtitle?: string;
  onPress: (f: SandboxFile) => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const Icon = getFileIconComponent(file);
  const isDir = file.type === 'directory';
  return (
    <TouchableOpacity onPress={() => onPress(file)} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 9, gap: 12 }}>
      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: isDir ? theme.primaryLight : iconBg, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={19} color={isDir ? theme.primary : muted} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{file.name}</Text>
        {subtitle ? <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {isDir && <ChevronRight size={18} color={muted} />}
    </TouchableOpacity>
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
  const versionSheetRef = React.useRef<BottomSheetModal>(null);

  const branchesQuery = useProjectBranches(projectId);
  const defaultBranch = branchesQuery.data?.default_branch ?? '';

  // Default to the project's default branch once branches resolve.
  useEffect(() => {
    if (!ref_ && defaultBranch) setRef(defaultBranch);
  }, [defaultBranch, ref_]);

  const filesQuery = useProjectFiles(projectId, ref_);
  const entries = filesQuery.data ?? [];

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const chipBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

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
  const folderCount = rows.length - fileRows.length;
  const countLabel = [
    folderCount > 0 ? `${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}` : '',
    fileRows.length > 0 ? `${fileRows.length} ${fileRows.length === 1 ? 'file' : 'files'}` : '',
  ].filter(Boolean).join('  ·  ');

  const segments = path ? path.split('/').filter(Boolean) : [];

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
          <TouchableOpacity onPress={() => filesQuery.refetch()} className="p-1 mr-1" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            {filesQuery.isFetching ? <ActivityIndicator size="small" color={muted} /> : <RefreshCw size={18} color={isDark ? '#F8F8F8' : '#121215'} />}
          </TouchableOpacity>
        }
      />

      <PageContent>
        {/* Toolbar: version · sort · download */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10 }}>
          <TouchableOpacity
            onPress={() => { haptics.tap(); versionSheetRef.current?.present(); }}
            activeOpacity={0.7}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9999, borderWidth: 1, borderColor: border }}
          >
            <GitBranch size={14} color={muted} />
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg, maxWidth: 120 }} numberOfLines={1}>{ref_ ? shortRef(ref_) : '—'}</Text>
            {ref_ === defaultBranch && defaultBranch ? <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: muted }}>MAIN</Text> : null}
            <ChevronDown size={14} color={muted} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={cycleSort} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9999, borderWidth: 1, borderColor: border }}>
            <ArrowDownUp size={13} color={muted} />
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: muted }}>{sortLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={downloadDir} disabled={downloadingDir} hitSlop={6} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: chipBg, alignItems: 'center', justifyContent: 'center', opacity: downloadingDir ? 0.6 : 1 }}>
            {downloadingDir ? <ActivityIndicator size="small" color={muted} /> : <Download size={16} color={muted} />}
          </TouchableOpacity>
        </View>

        {/* Breadcrumb */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, maxHeight: 40 }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, gap: 2 }}>
          <TouchableOpacity onPress={() => { if (path) { haptics.tap(); setPath(''); } }} disabled={!path} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingRight: 4 }}>
            <Folder size={15} color={path ? muted : fg} />
            <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: path ? muted : fg }}>Files</Text>
          </TouchableOpacity>
          {segments.map((seg, i) => {
            const segPath = segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={segPath}>
                <ChevronRight size={14} color={muted} />
                <TouchableOpacity onPress={() => { if (!last) { haptics.tap(); setPath(segPath); } }} disabled={last} style={{ paddingVertical: 4, paddingHorizontal: 2 }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: last ? fg : muted }} numberOfLines={1}>{seg}</Text>
                </TouchableOpacity>
              </React.Fragment>
            );
          })}
        </ScrollView>

        {/* File list */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40, paddingTop: 4 }} showsVerticalScrollIndicator={false}>
          {(filesQuery.isLoading || (!ref_ && branchesQuery.isLoading)) ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : filesQuery.isError ? (
            <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(filesQuery.error as Error)?.message ?? 'Failed to load files'}</Text>
              <TouchableOpacity onPress={() => filesQuery.refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : rows.length === 0 ? (
            <View style={{ padding: 48, alignItems: 'center', gap: 10 }}>
              <FolderOpen size={28} color={muted} />
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{path ? 'This folder is empty.' : 'No files in this version.'}</Text>
            </View>
          ) : (
            <>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 6 }}>
                {countLabel}
              </Text>
              {rows.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  subtitle={!path && file.type === 'directory' && file.name in ELEVATED ? ELEVATED[file.name] : undefined}
                  onPress={onRowPress}
                  isDark={isDark}
                />
              ))}
            </>
          )}
        </ScrollView>
      </PageContent>

      {/* Version selector */}
      <BottomSheetModal
        ref={versionSheetRef}
        snapPoints={['65%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <VersionSheet
          branches={branchesQuery.data?.branches ?? []}
          defaultBranch={defaultBranch}
          value={ref_}
          onSelect={(r) => { setRef(r); setPath(''); versionSheetRef.current?.dismiss(); }}
          onClose={() => versionSheetRef.current?.dismiss()}
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
