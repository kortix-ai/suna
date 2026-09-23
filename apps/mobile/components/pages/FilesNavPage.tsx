/**
 * FilesNavPage — the project's repo files (web parity: features/project-files).
 * A READ-ONLY git-repo browser: the `/files` endpoint returns a FLAT recursive
 * file list, so folders are derived client-side from the paths. Browse by
 * version (branch), open a file, see its history, and download a file or a
 * folder as a zip. No write, rename or delete: project files come from git.
 *
 * Layout (Jay, 2026-09-22):
 * - `PageHeader` with the large title and the `···`; no controls beside it.
 * - Search, then the breadcrumb (chips, never clipped). Inside a folder the
 *   hamburger stays (Jay, 2026-09-22: no Go back in its place, on any page);
 *   a crumb, or Android back, goes up one folder, never to home.
 * - List: sections titled "Folders" and "Files", rows of `SettingsRow` in
 *   `SettingsGroupItem`s. Grid: 2-up tiles. Both are one virtualised
 *   `FlatList` (`buildFilesListItems`, COR-155).
 * - Search covers the whole tree, not the open folder (`searchFileTree`,
 *   COR-155); each result shows its folder under its name.
 * - The pinned bar (`PinnedBar`, the project drawer's bottom bar): version ·
 *   sort · list/grid `Tabs` · download, floating over a fade of the page.
 *   Refresh is a pull on the list; there is no button.
 * - No scale, no opacity, no spring on a press: rows use `SettingsRow`'s
 *   pressed fill; tiles use `active:bg-accent`.
 *
 * A file opens in `FileSheet`, a `KortixBottomSheetModal` at full height: the
 * file name as the title, `FilePreview` as the body (the recent-files sheet's
 * layout), and a pinned bar with Download · History. History pushes in
 * (`sheet-push`) and a checkpoint pushes its diff in after it.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, Pressable, RefreshControl, ScrollView, View, type ListRenderItem } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getAuthToken } from '@/api/config';
import type { SandboxFile } from '@/api/types';
import { PatchDiffView } from '@/components/diff/PatchDiffView';
import { FilePreview, FilePreviewBottomInsetContext, getFilePreviewType } from '@/components/files/FilePreviewRenderers';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { TopFade, useScrollFade } from '@/components/kortix/scroll-fade';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SettingsGroup, SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { CopyContentButton, KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { FileGlyph } from '@/components/files/file-icons';
import { downloadFailureMessage } from '@/lib/files/download-status';
import { displayNames } from '@/lib/files/file-icon';
import { buildFilesListItems, type FilesListItem } from '@/lib/files/files-list-items';
import { searchFileTree, searchResultLocation } from '@/lib/files/tree-search';
import { folderTone } from '@/lib/files/folder-tone';
import { haptics } from '@/lib/haptics';
import {
  ArrowsDownUpIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  ListIcon,
  SquaresFourIcon,
} from '@/lib/icons';
import {
  useProjectBranches,
  useProjectCommitDiff,
  useProjectFileContent,
  useProjectFileHistory,
  useProjectFiles,
} from '@/lib/projects/hooks';
import { projectArchiveUrl } from '@/lib/projects/projects-client';
import type { ProjectBranch, ProjectCommit, ProjectFileEntry } from '@/lib/projects/projects-client';
import { relativeTime } from '@/lib/projects/triggers-format';
import { THEME } from '@/lib/utils/theme';

interface FilesNavPageProps {
  page: { id: string; label: string };
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

/** Pinned config dirs: always first (web parity). */
const ELEVATED = new Set(['.kortix', '.opencode']);

type SortBy = 'name' | 'type';
type SortOrder = 'asc' | 'desc';
type ViewMode = 'list' | 'grid';

/** A row or tile of the list. `parent` is set on a search result: its folder. */
type FileRow = SandboxFile & { parent?: string };

/** Space between the Folders and Files sections. */
const SECTION_GAP = 18;
const EMPTY_ITEMS: FilesListItem<FileRow>[] = [];

/** The pinned bar's controls are 40pt `icon` buttons. */
const BAR_CONTROL_HEIGHT = 40;
const SHEET_SNAP_POINTS = ['100%'];

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

/**
 * `downloadAsync` writes the body whatever the status: a 401 or 404 body used
 * to be shared as `name.zip` (COR-155). A non-2xx status deletes the temp
 * file and throws the message; the caller toasts it.
 */
async function downloadAndShare(url: string, filename: string, withAuth: boolean) {
  const target = `${FileSystem.cacheDirectory}${filename}`;
  let status: number | undefined;
  try {
    const headers: Record<string, string> = {};
    if (withAuth) {
      const token = await getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    status = (await FileSystem.downloadAsync(url, target, { headers })).status;
  } catch (error) {
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
    throw error;
  }
  const failure = downloadFailureMessage(status);
  if (failure) {
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
    throw new Error(failure);
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target);
}

async function saveTextAndShare(content: string, filename: string) {
  const target = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(target, content);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target);
}

/**
 * A folder is a filled folder glyph in the folder's own tone. A file is its
 * type's glyph (`FileGlyph`: one per web language, the Kortix symbol on the
 * Kortix files, git on git's dotfiles), filled, in the muted foreground.
 */
function EntryIcon({ file, size }: { file: SandboxFile; size: number }) {
  if (file.type === 'directory') {
    return <FolderIcon size={size} weight="fill" color={THEME.accent[folderTone(file.name)]} />;
  }
  return <FileGlyph name={file.name} size={size} />;
}

function fileSizeLabel(size: number | undefined): string | undefined {
  if (size == null) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Version sheet ────────────────────────────────────────────────────────────

function VersionSheet({
  branches,
  defaultBranch,
  value,
  isLoading,
  onSelect,
}: {
  branches: ProjectBranch[];
  defaultBranch: string;
  value: string;
  isLoading: boolean;
  onSelect: (ref: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const sorted = useMemo(
    () =>
      [...branches].sort((a, b) => {
        if (a.name === defaultBranch) return -1;
        if (b.name === defaultBranch) return 1;
        return (b.committed_at ?? '').localeCompare(a.committed_at ?? '');
      }),
    [branches, defaultBranch],
  );
  return (
    <BottomSheetScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
      {isLoading && sorted.length === 0 ? (
        <View className="gap-3">
          <Skeleton className="h-12 w-full rounded-2xl" />
          <Skeleton className="h-12 w-full rounded-2xl" />
        </View>
      ) : sorted.length === 0 ? (
        <Text variant="muted" className="px-2 py-6">
          No versions yet
        </Text>
      ) : (
        <SettingsGroup>
          {sorted.map((b) => (
            <SettingsRow
              key={b.name}
              icon={GitBranchIcon}
              label={shortRef(b.name)}
              value={b.name === defaultBranch ? 'Default' : b.committed_at ? relativeTime(b.committed_at) : undefined}
              checked={b.name === value}
              right={null}
              onPress={() => {
                haptics.selection();
                onSelect(b.name);
              }}
            />
          ))}
        </SettingsGroup>
      )}
    </BottomSheetScrollView>
  );
}

// ─── File sheet: preview · history · checkpoint diff ─────────────────────────

type FileSheetView = { kind: 'preview' } | { kind: 'history' } | { kind: 'commit'; commit: ProjectCommit };

function FileSheetBody({
  projectId,
  ref_,
  file,
  onCopyTextChange,
}: {
  projectId: string;
  ref_: string;
  file: { name: string; path: string };
  /** The file's text once it has loaded, else ''. */
  onCopyTextChange: (text: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pageBackground = THEME[isDark ? 'dark' : 'light'].background;
  const contentInset = usePinnedBarInset(BAR_CONTROL_HEIGHT);
  const toast = useToast();
  const [view, setView] = useState<FileSheetView>({ kind: 'preview' });
  const [returning, setReturning] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const content = useProjectFileContent(projectId, file.path, ref_);
  const copyText = !content.isError && typeof content.data?.content === 'string' ? content.data.content : '';
  useEffect(() => {
    onCopyTextChange(copyText);
  }, [copyText, onCopyTextChange]);
  const history = useProjectFileHistory(projectId, view.kind === 'preview' ? null : file.path, ref_);

  const goTo = useCallback((next: FileSheetView, back: boolean) => {
    haptics.tap();
    setReturning(back);
    setView(next);
  }, []);

  const download = async () => {
    if (downloading) return;
    haptics.tap();
    setDownloading(true);
    try {
      await saveTextAndShare(content.data?.content ?? '', basename(file.name));
    } catch (e: any) {
      haptics.warning();
      toast.error(e?.message || 'Unable to download the file. Try again.');
    } finally {
      setDownloading(false);
    }
  };

  if (view.kind === 'commit') {
    return (
      <Animated.View key={view.commit.hash} entering={PUSH_IN} style={{ flex: 1 }}>
        <SheetTitleRow title={view.commit.short_hash} leading={<SheetBackButton onPress={() => goTo({ kind: 'history' }, true)} />} />
        <BottomSheetScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: contentInset, gap: 12 }}
          showsVerticalScrollIndicator={false}>
          <View className="gap-1 px-2">
            <Text numberOfLines={3}>{view.commit.subject || '(no message)'}</Text>
            <Text variant="muted" numberOfLines={1}>
              {view.commit.author_name || 'Unknown'} · {relativeTime(view.commit.committed_at || view.commit.authored_at)}
            </Text>
          </View>
          <CommitDiff projectId={projectId} sha={view.commit.hash} path={file.path} isDark={isDark} />
        </BottomSheetScrollView>
      </Animated.View>
    );
  }

  if (view.kind === 'history') {
    const commits = history.data?.commits ?? [];
    return (
      <Animated.View key="history" entering={returning ? POP_IN : PUSH_IN} style={{ flex: 1 }}>
        <SheetTitleRow title="History" leading={<SheetBackButton onPress={() => goTo({ kind: 'preview' }, true)} />} />
        <BottomSheetScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: contentInset }}
          showsVerticalScrollIndicator={false}>
          {history.isLoading ? (
            <View className="gap-3">
              <Skeleton className="h-12 w-full rounded-2xl" />
              <Skeleton className="h-12 w-full rounded-2xl" />
              <Skeleton className="h-12 w-full rounded-2xl" />
            </View>
          ) : history.isError ? (
            <Text variant="muted" className="px-2 py-6 text-center">
              Unable to load the history
            </Text>
          ) : commits.length === 0 ? (
            <Text variant="muted" className="px-2 py-6 text-center">
              No checkpoints for this file yet
            </Text>
          ) : (
            <SettingsGroup>
              {commits.map((c) => (
                <SettingsRow
                  key={c.hash}
                  icon={GitCommitIcon}
                  label={c.subject || '(no message)'}
                  value={relativeTime(c.committed_at || c.authored_at)}
                  onPress={() => goTo({ kind: 'commit', commit: c }, false)}
                />
              ))}
            </SettingsGroup>
          )}
        </BottomSheetScrollView>
      </Animated.View>
    );
  }

  const previewType = getFilePreviewType(file.name);
  return (
    <Animated.View key="preview" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>
      {/* The document fills the sheet and scrolls under the pinned bar; the
          renderers end their content `contentInset` above the edge. */}
      <FilePreviewBottomInsetContext.Provider value={contentInset}>
        {content.isLoading ? (
          <View className="flex-1 items-center justify-center" style={{ paddingBottom: contentInset }}>
            <KortixLoader size="large" />
          </View>
        ) : content.isError ? (
          <View className="flex-1 items-center justify-center gap-3 px-8" style={{ paddingBottom: contentInset }}>
            <Text variant="muted" className="text-center">
              This file cannot be shown as text. Download it to view.
            </Text>
          </View>
        ) : (
          <FilePreview content={content.data?.content ?? ''} fileName={file.name} previewType={previewType} filePath={file.path} />
        )}
      </FilePreviewBottomInsetContext.Provider>

      {/* The project drawer's pinned bar: Download · History, over a fade. */}
      <PinnedBar controlHeight={BAR_CONTROL_HEIGHT} background={pageBackground} className="gap-2 px-4">
        <Button variant="secondary" className="flex-1 rounded-full" onPress={download} disabled={downloading || content.isLoading}>
          <Icon as={DownloadSimpleIcon} size={18} className="text-foreground" />
          <Text>{downloading ? 'Downloading…' : 'Download'}</Text>
        </Button>
        <Button variant="secondary" className="flex-1 rounded-full" onPress={() => goTo({ kind: 'history' }, false)}>
          <Icon as={ClockCounterClockwiseIcon} size={18} className="text-foreground" />
          <Text>History</Text>
        </Button>
      </PinnedBar>
    </Animated.View>
  );
}

function CommitDiff({ projectId, sha, path, isDark }: { projectId: string; sha: string; path: string; isDark: boolean }) {
  const diff = useProjectCommitDiff(projectId, sha, path);
  if (diff.isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (diff.isError || !diff.data) {
    return (
      <Text variant="muted" className="px-2">
        Unable to load this checkpoint's changes
      </Text>
    );
  }
  return <PatchDiffView patch={diff.data.patch} isDark={isDark} />;
}

// ─── Grid tile ────────────────────────────────────────────────────────────────

function FileTile({
  file,
  label,
  detail,
  onPress,
}: {
  file: SandboxFile;
  label: string;
  /** The second line: a search result's folder; else a file's size. */
  detail?: string;
  onPress: (file: SandboxFile) => void;
}) {
  const second = detail ?? (file.type === 'file' ? fileSizeLabel(file.size) : undefined);
  return (
    <Pressable
      onPress={() => onPress(file)}
      accessibilityRole="button"
      accessibilityLabel={file.name}
      className="gap-3 overflow-hidden rounded-2xl bg-card p-4 active:bg-accent">
      {/* The glyph's visible left edge sits ~3pt inside its box: pull it back so it
          lines up with the name below. */}
      <View style={{ marginLeft: -3 }}>
        <EntryIcon file={file} size={36} />
      </View>
      <View className="gap-0.5">
        {/* `small` is `leading-none`: a 14pt line clips g/p/y once
            `numberOfLines` clips to the line box. `leading-5` = text-sm's 20pt. */}
        <Text variant="small" className="leading-5" numberOfLines={1}>
          {label}
        </Text>
        {second ? (
          <Text variant="muted" className="text-xs" numberOfLines={1}>
            {second}
          </Text>
        ) : null}
      </View>
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
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pageBackground = THEME[isDark ? 'dark' : 'light'].background;
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const scrollFade = useScrollFade();
  const contentInset = usePinnedBarInset(BAR_CONTROL_HEIGHT);

  const [ref_, setRef] = useState('');
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [viewMode, setViewMode] = useState<ViewMode>('grid'); // the grid is the default (Jay, 2026-09-22)
  const [openFile, setOpenFile] = useState<{ name: string; path: string } | null>(null);
  const [copyText, setCopyText] = useState('');
  const [downloadingDir, setDownloadingDir] = useState(false);
  const versionSheetRef = React.useRef<BottomSheetModal>(null);
  const fileSheetRef = React.useRef<BottomSheetModal>(null);

  const branchesQuery = useProjectBranches(projectId);
  const defaultBranch = branchesQuery.data?.default_branch ?? '';
  useEffect(() => {
    if (!ref_ && defaultBranch) setRef(defaultBranch);
  }, [defaultBranch, ref_]);

  const filesQuery = useProjectFiles(projectId, ref_);
  const entries = filesQuery.data ?? [];

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
    const elevated = dirs.filter((d) => ELEVATED.has(d)).sort();
    const otherDirs = dirs.filter((d) => !ELEVATED.has(d)).sort(cmp);
    const fileNodes = [...files].sort((a, b) => cmp(basename(a.path), basename(b.path)));
    const mk = (name: string, full: string, type: 'directory' | 'file', size?: number | null): SandboxFile => ({
      name,
      path: full,
      type,
      size: size ?? undefined,
    });
    return [
      ...elevated.map((d) => mk(d, path ? `${path}/${d}` : d, 'directory')),
      ...otherDirs.map((d) => mk(d, path ? `${path}/${d}` : d, 'directory')),
      ...fileNodes.map((f) => mk(basename(f.path), f.path, 'file', f.size)),
    ];
  }, [entries, path, sortBy, sortOrder]);

  // Search covers the whole tree, not only this folder (COR-155): the files
  // query already holds every path. A result shows its folder.
  const searching = search.trim().length > 0;
  const visible = useMemo<FileRow[]>(() => {
    if (!searching) return rows;
    return searchFileTree(entries, search).map((r) => ({
      name: r.name,
      path: r.path,
      type: r.type,
      size: r.size,
      parent: r.parent,
    }));
  }, [entries, rows, search, searching]);
  const folders = useMemo(() => visible.filter((r) => r.type === 'directory'), [visible]);
  // Extensions dropped, unless two names in this folder would then collide.
  const labels = useMemo(() => displayNames(visible.map((r) => r.name)), [visible]);
  const files = useMemo(() => visible.filter((r) => r.type === 'file'), [visible]);
  const listItems = useMemo(() => buildFilesListItems(folders, files, viewMode), [folders, files, viewMode]);
  const segments = path ? path.split('/').filter(Boolean) : [];

  const listLoading = filesQuery.isLoading || (!ref_ && branchesQuery.isLoading);

  // Back inside a folder goes up one folder, not to project home (Jay,
  // 2026-09-22). Registered after ProjectScreen's handler, so it runs first.
  const goUp = useCallback(() => {
    haptics.tap();
    setPath((current) => current.split('/').filter(Boolean).slice(0, -1).join('/'));
    setSearch('');
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'android' || !path) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      goUp();
      return true;
    });
    return () => subscription.remove();
  }, [path, goUp]);

  const onRowPress = useCallback((file: SandboxFile) => {
    haptics.tap();
    if (file.type === 'directory') {
      setPath(file.path);
      setSearch('');
      return;
    }
    setOpenFile({ name: file.name, path: file.path });
    fileSheetRef.current?.present();
  }, []);

  // One FlatList item: a section title, a list row, or a grid line of tiles
  // (`buildFilesListItems`). Virtualised, so a folder of thousands of files
  // mounts only what is on screen (COR-155).
  const renderItem = useCallback<ListRenderItem<FilesListItem<FileRow>>>(
    ({ item }) => {
      const gap = item.first ? { marginTop: SECTION_GAP } : undefined;
      if (item.kind === 'title') {
        return (
          <Text variant="muted" className="mb-2 px-4" style={gap}>
            {item.label}
          </Text>
        );
      }
      if (item.kind === 'row') {
        const file = item.entry;
        return (
          <View style={gap}>
            <SettingsGroupItem index={item.index} count={item.count}>
              <SettingsRow
                leading={<EntryIcon file={file} size={22} />}
                label={labels[file.name]}
                description={searching ? searchResultLocation(file) : undefined}
                value={file.type === 'file' ? fileSizeLabel(file.size) : undefined}
                onPress={() => onRowPress(file)}
              />
            </SettingsGroupItem>
          </View>
        );
      }
      return (
        <View className="flex-row" style={[{ marginHorizontal: -4 }, gap]}>
          {item.entries.map((file) => (
            <View key={file.path} style={{ width: '50%', paddingHorizontal: 4, marginBottom: 8 }}>
              <FileTile
                file={file}
                label={labels[file.name]}
                detail={searching ? searchResultLocation(file) : undefined}
                onPress={onRowPress}
              />
            </View>
          ))}
        </View>
      );
    },
    [labels, onRowPress, searching],
  );

  const cycleSort = () => {
    haptics.selection();
    if (sortBy === 'name' && sortOrder === 'asc') setSortOrder('desc');
    else if (sortBy === 'name') {
      setSortBy('type');
      setSortOrder('asc');
    } else if (sortOrder === 'asc') setSortOrder('desc');
    else {
      setSortBy('name');
      setSortOrder('asc');
    }
  };
  const sortLabel = `Sorted by ${sortBy}, ${sortOrder === 'asc' ? 'ascending' : 'descending'}`;

  const downloadDir = async () => {
    if (downloadingDir || !ref_) return;
    haptics.tap();
    setDownloadingDir(true);
    try {
      const name = (path ? basename(path) : 'workspace') || 'workspace';
      await downloadAndShare(projectArchiveUrl(projectId, ref_, path || undefined), `${name}.zip`, true);
    } catch (e: any) {
      haptics.warning();
      toast.error(e?.message || 'Unable to download the folder. Try again.');
    } finally {
      setDownloadingDir(false);
    }
  };

  const [pulling, setPulling] = useState(false);
  const refresh = () => {
    setPulling(true);
    void Promise.all([filesQuery.refetch(), branchesQuery.refetch()]).finally(() => setPulling(false));
  };

  const emptyLabel = listLoading
    ? null
    : filesQuery.isError
      ? ((filesQuery.error as Error)?.message ?? 'Unable to load the files')
      : visible.length === 0
        ? search
          ? 'No matching files'
          : path
            ? 'This folder is empty'
            : 'No files in this version'
        : null;

  return (
    <View className="flex-1 bg-background">
      {/* Inside a folder, Go back takes the hamburger's place and goes up one
          folder; the title is the folder's name. */}
      <PageHeader
        title={path ? basename(path) : page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
        <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search files" />

        {/* Breadcrumb: chips on one 40pt line, never clipped. The current
            folder is the last chip; every earlier chip goes back to it. */}
        {segments.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 4, minHeight: 40 }}>
            <Pressable
              onPress={() => {
                haptics.tap();
                setPath('');
              }}
              className="flex-row items-center gap-1.5 rounded-full px-2 py-1.5 active:bg-accent">
              <Text variant="muted">Files</Text>
            </Pressable>
            {segments.map((seg, i) => {
              const segPath = segments.slice(0, i + 1).join('/');
              const last = i === segments.length - 1;
              return (
                <React.Fragment key={segPath}>
                  <Icon as={CaretRightIcon} size={14} className="text-muted-foreground/60" />
                  <Pressable
                    disabled={last}
                    onPress={() => {
                      haptics.tap();
                      setPath(segPath);
                    }}
                    className="rounded-full px-2 py-1.5 active:bg-accent">
                    <Text variant={last ? 'default' : 'muted'} numberOfLines={1}>
                      {seg}
                    </Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </ScrollView>
        ) : null}

        <View className="flex-1">
          <Animated.FlatList
            style={{ flex: 1 }}
            data={listLoading || emptyLabel ? EMPTY_ITEMS : listItems}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            initialNumToRender={16}
            windowSize={11}
            onScroll={scrollFade.onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: contentInset }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={pulling}
                onRefresh={refresh}
                tintColor={THEME[isDark ? 'dark' : 'light'].mutedForeground}
              />
            }
            ListHeaderComponent={
              listLoading ? (
                <View className="gap-3 pt-3">
                  <Skeleton className="h-12 w-full rounded-2xl" />
                  <Skeleton className="h-12 w-full rounded-2xl" />
                  <Skeleton className="h-12 w-full rounded-2xl" />
                </View>
              ) : emptyLabel ? (
                <View className="items-center gap-4 px-6 pt-16">
                  <Text variant="muted" className="text-center">
                    {emptyLabel}
                  </Text>
                  {filesQuery.isError ? (
                    <Button variant="secondary" size="lg" className="rounded-full" onPress={refresh}>
                      <Text>Try again</Text>
                    </Button>
                  ) : null}
                </View>
              ) : null
            }
          />
          <TopFade style={scrollFade.topFadeStyle} />

          {/* The project drawer's pinned bar: version · sort · view · refresh ·
              download, floating over a fade of the page. */}
          <PinnedBar controlHeight={BAR_CONTROL_HEIGHT} background={pageBackground} className="gap-2 px-4">
            <Button
              variant="secondary"
              className="shrink rounded-full"
              onPress={() => {
                haptics.tap();
                versionSheetRef.current?.present();
              }}
              accessibilityLabel={`Version, ${ref_ ? shortRef(ref_) : 'none'}`}>
              <Icon as={GitBranchIcon} size={16} className="text-foreground" />
              <Text numberOfLines={1}>{ref_ ? shortRef(ref_) : '…'}</Text>
            </Button>
            <View className="flex-1" />
            <Button variant="secondary" size="icon" className="rounded-full" onPress={cycleSort} accessibilityLabel={sortLabel}>
              <Icon as={ArrowsDownUpIcon} size={18} className="text-foreground" />
            </Button>
            {/* The list / grid toggle: the app's Tabs, as a 40pt pill. */}
            <Tabs
              value={viewMode}
              onValueChange={(value) => {
                haptics.selection();
                setViewMode(value as ViewMode);
              }}>
              <TabsList className="h-10 rounded-full bg-secondary p-1">
                <TabsTrigger value="list" className="h-8 w-9 rounded-full px-0" accessibilityLabel="Show as list">
                  <Icon as={ListIcon} size={16} className="text-foreground" />
                </TabsTrigger>
                <TabsTrigger value="grid" className="h-8 w-9 rounded-full px-0" accessibilityLabel="Show as grid">
                  <Icon as={SquaresFourIcon} size={16} className="text-foreground" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="secondary"
              size="icon"
              className="rounded-full"
              onPress={downloadDir}
              disabled={downloadingDir || !ref_}
              accessibilityLabel={path ? 'Download this folder' : 'Download the project'}>
              <Icon as={DownloadSimpleIcon} size={18} className="text-foreground" />
            </Button>
          </PinnedBar>
        </View>
      </PageContent>

      {/* Version picker */}
      <KortixBottomSheetModal ref={versionSheetRef} title="Version" enableDynamicSizing maxDynamicContentSize={Math.floor(insets.top + 600)} enablePanDownToClose>
        <VersionSheet
          branches={branchesQuery.data?.branches ?? []}
          defaultBranch={defaultBranch}
          value={ref_}
          isLoading={branchesQuery.isLoading || branchesQuery.isFetching}
          onSelect={(r) => {
            setRef(r);
            setPath('');
            versionSheetRef.current?.dismiss();
          }}
        />
      </KortixBottomSheetModal>

      {/* File: preview, history, checkpoint diff. The recent-files sheet's layout. */}
      <KortixBottomSheetModal
        ref={fileSheetRef}
        title={openFile?.name}
        titleTrailing={copyText ? <CopyContentButton text={copyText} /> : undefined}
        snapPoints={SHEET_SNAP_POINTS}
        enableDynamicSizing={false}
        topInset={insets.top}
        enablePanDownToClose
        enableContentPanningGesture={false}
        backgroundStyle={{ backgroundColor: pageBackground }}
        onDismiss={() => {
          setOpenFile(null);
          setCopyText('');
        }}>
        {openFile ? <FileSheetBody projectId={projectId} ref_={ref_} file={openFile} onCopyTextChange={setCopyText} /> : null}
      </KortixBottomSheetModal>
    </View>
  );
}
