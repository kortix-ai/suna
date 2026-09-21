/**
 * The Files screen (SPEC §5.5): the session sandbox's workspace tree on the
 * left, one file in a `<code>` viewer on the right.
 *
 * Two halves in one file, the split `features/sidebar` uses:
 *
 * - `FilesScreen` is the data half. It builds the two loaders from
 *   `kortix().session(projectId, sessionId).files` (SPEC §7) and gates on the
 *   session's own runtime phase.
 * - `FilesView` is pixels and keys. Every read arrives through the injected
 *   `FileLoaders`, so `files-screen.test.tsx` drives the real component with
 *   fake loaders and no mocked module.
 *
 * Readiness: the sandbox file endpoints live on the session's own runtime, and
 * `session(...).files.*` calls `ensureReady()` first — on a cold session that
 * awaits a full provision, which is minutes. So when the host passes its
 * `useSession` result, this screen renders that phase and stops, instead of
 * hanging on a promise nobody can see. Without a `session` prop it reads
 * immediately and lets the loader wait; the host is then responsible for only
 * opening this screen on a started session.
 */

import type { useSession } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import {
  type FileTree,
  type TreeNode,
  type TreeRow,
  collapse,
  createTree,
  expand,
  filterRows,
  flatten,
  forgetLoads,
  hideDotfiles,
  loadStateOf,
  markLoading,
  parentOf,
  setChildren,
  setError,
} from './file-tree.ts';
import {
  FileViewer,
  type ReadResult,
  type ViewerState,
  toViewerState,
  viewerLines,
} from './file-viewer.tsx';
import { matchesFilesBinding } from './keys.ts';

/** The whole session, exactly as `useSession` returns it. */
export type SessionState = ReturnType<typeof useSession>;

/** The sandbox root every Kortix session's workspace lives under. */
export const WORKSPACE_ROOT = '/workspace';

/** The two reads the screen makes. Injected so a test needs no SDK. */
export interface FileLoaders {
  listDirectory(path: string): Promise<TreeNode[]>;
  readFile(path: string): Promise<ReadResult>;
}

export interface FilesScreenProps {
  projectId: string;
  sessionId: string;
  focused: boolean;
  width: number;
  height: number;
  onBack(): void;
  /** The host's `useSession` result. Gates the reads on the runtime phase. */
  session?: SessionState;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export function FilesScreen({
  projectId,
  sessionId,
  focused,
  width,
  height,
  onBack,
  session,
  onToast,
}: FilesScreenProps) {
  const loaders = useMemo<FileLoaders>(
    () => ({
      listDirectory: (path: string) => kortix().session(projectId, sessionId).files.list(path),
      readFile: (path: string) => kortix().session(projectId, sessionId).files.read(path),
    }),
    [projectId, sessionId],
  );

  useKeyboard((key) => {
    if (!focused) return;
    if (session && session.phase !== 'ready' && matchesFilesBinding(key, 'files.back')) onBack();
  });

  if (session && session.phase !== 'ready') {
    const stage = session.stage ?? 'starting';
    const detail = session.startError
      ? errorText(session.startError)
      : (session.reason ?? (session.activelyStarting ? 'the provider is starting the box' : null));
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>Sandbox files</text>
        <text fg={session.phase === 'error' ? theme.danger : theme.dim}>
          {`runtime ${stage}${detail ? ` · ${detail}` : ''}`}
        </text>
        <text fg={theme.faint}>
          {session.phase === 'error'
            ? 'The session runtime failed. Open the session and retry, then come back.'
            : 'Files read from the session sandbox. Open the session to start it, then come back.'}
        </text>
        <text fg={theme.faint}>Esc back</text>
      </box>
    );
  }

  return (
    <FilesView
      loaders={loaders}
      focused={focused}
      width={width}
      height={height}
      onBack={onBack}
      onToast={onToast}
    />
  );
}

export interface FilesViewProps {
  loaders: FileLoaders;
  focused: boolean;
  width: number;
  height: number;
  onBack(): void;
  root?: string;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

/** Tree column width: a third of the screen, inside a readable band. */
export function treeWidth(width: number): number {
  return Math.min(Math.max(Math.floor(width / 3), 20), 44);
}

export function FilesView({
  loaders,
  focused,
  width,
  height,
  onBack,
  root = WORKSPACE_ROOT,
  onToast,
}: FilesViewProps) {
  const [tree, setTree] = useState<FileTree>(() => createTree(root));
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [mode, setMode] = useState<'browse' | 'filter'>('browse');
  const [filter, setFilter] = useState('');
  const [viewer, setViewer] = useState<ViewerState>({ kind: 'empty' });
  const [viewerOffset, setViewerOffset] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  /** The path of the read the viewer is waiting on. A slower earlier read that
   *  lands after it must not overwrite the newer file. */
  const pendingRead = useRef<string | null>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      setTree((current) => markLoading(current, path));
      try {
        const nodes = await loaders.listDirectory(path);
        setTree((current) => setChildren(current, path, nodes));
      } catch (error) {
        setTree((current) => setError(current, path, errorText(error)));
      }
    },
    [loaders],
  );

  // The root list is the screen's first read. `loadDirectory` is stable per
  // loaders object, so this runs once per session.
  useEffect(() => {
    void loadDirectory(root);
  }, [loadDirectory, root]);

  const openFile = useCallback(
    async (path: string) => {
      pendingRead.current = path;
      setViewer({ kind: 'loading', path });
      setViewerOffset(0);
      try {
        const result = await loaders.readFile(path);
        if (pendingRead.current !== path) return;
        setViewer(toViewerState(path, result));
      } catch (error) {
        if (pendingRead.current !== path) return;
        setViewer({ kind: 'error', path, message: errorText(error) });
      }
    },
    [loaders],
  );

  const allRows = useMemo(() => flatten(tree), [tree]);
  const visibleRows = useMemo(
    () => (showHidden ? allRows : hideDotfiles(allRows)),
    [allRows, showHidden],
  );
  const rows = useMemo(() => filterRows(visibleRows, filter), [visibleRows, filter]);

  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [rows, cursorId]);
  const current: TreeRow | undefined = rows[cursorIndex];

  const moveTo = useCallback(
    (index: number) => {
      if (rows.length === 0) return;
      const clamped = Math.min(Math.max(index, 0), rows.length - 1);
      const row = rows[clamped];
      if (row) setCursorId(row.id);
    },
    [rows],
  );

  const expandRow = useCallback(
    (row: TreeRow) => {
      setTree((currentTree) => expand(currentTree, row.path));
      if (!loadStateOf(tree, row.path)) void loadDirectory(row.path);
    },
    [tree, loadDirectory],
  );

  const openCurrent = useCallback(() => {
    if (!current) return;
    if (current.type === 'file') {
      void openFile(current.path);
      return;
    }
    if (current.expanded) setTree((currentTree) => collapse(currentTree, current.path));
    else expandRow(current);
  }, [current, openFile, expandRow]);

  const refresh = useCallback(() => {
    const open = [root, ...allRows.filter((row) => row.expanded).map((row) => row.path)];
    setTree((currentTree) => forgetLoads(currentTree));
    for (const path of open) void loadDirectory(path);
    onToast?.(`Re-reading ${open.length} ${open.length === 1 ? 'directory' : 'directories'}…`);
  }, [root, allRows, loadDirectory, onToast]);

  const copyPath = useCallback(() => {
    const path = current?.path;
    if (!path) return;
    void copyToClipboard(path).then((result) => {
      if (result.ok) onToast?.(`Copied ${path}`);
      else onToast?.(`Copy failed: ${result.error ?? 'no clipboard tool'}`, 'error');
    });
  }, [current, onToast]);

  const clearFilter = useCallback(() => {
    setMode('browse');
    setFilter('');
  }, []);

  const viewerRows = Math.max(height - 3, 1);
  // The last page keeps a full screen of text instead of stranding one line at
  // the top — verified live: a 10-line file paged to `10-10/10` before this.
  const maxViewerOffset = Math.max(viewerLines(viewer).length - viewerRows, 0);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'filter') {
      // The `<input>` owns every other key while it is open.
      if (matchesFilesBinding(key, 'files.back')) clearFilter();
      return;
    }

    if (matchesFilesBinding(key, 'files.viewerDown'))
      return setViewerOffset((offset) => Math.min(offset + viewerRows, maxViewerOffset));
    if (matchesFilesBinding(key, 'files.viewerUp'))
      return setViewerOffset((offset) => Math.max(offset - viewerRows, 0));
    if (matchesFilesBinding(key, 'files.down')) return moveTo(cursorIndex + 1);
    if (matchesFilesBinding(key, 'files.up')) return moveTo(cursorIndex - 1);
    if (matchesFilesBinding(key, 'files.first')) return moveTo(0);
    if (matchesFilesBinding(key, 'files.last')) return moveTo(rows.length - 1);
    if (matchesFilesBinding(key, 'files.open')) return openCurrent();
    if (matchesFilesBinding(key, 'files.expand')) {
      if (current?.type === 'directory' && !current.expanded) expandRow(current);
      return;
    }
    if (matchesFilesBinding(key, 'files.collapse')) {
      if (!current) return;
      if (current.type === 'directory' && current.expanded) {
        setTree((currentTree) => collapse(currentTree, current.path));
        return;
      }
      const parent = parentOf(tree, current.path);
      if (parent && parent !== root) setCursorId(parent);
      return;
    }
    if (matchesFilesBinding(key, 'files.filter')) return setMode('filter');
    if (matchesFilesBinding(key, 'files.toggleHidden')) return setShowHidden((value) => !value);
    if (matchesFilesBinding(key, 'files.refresh')) return refresh();
    if (matchesFilesBinding(key, 'files.copyPath')) return copyPath();
    if (matchesFilesBinding(key, 'files.back')) {
      if (filter) return clearFilter();
      return onBack();
    }
  });

  const columnWidth = treeWidth(width);
  const viewerWidth = Math.max(width - columnWidth - 1, 10);
  const bodyWidth = Math.max(columnWidth - 1, 0);
  // Header + two hint rows, plus the filter input when it is open.
  const listRows = Math.max(height - (mode === 'filter' ? 4 : 3), 1);
  const start = windowStart(cursorIndex, rows.length, listRows);
  const visible = rows.slice(start, start + listRows);
  const rootLoad = loadStateOf(tree, root);

  return (
    <box flexDirection="row" width={width} height={height}>
      <box flexDirection="column" width={columnWidth}>
        <text fg={focused ? theme.fg : theme.dim}>
          {layoutRow(root, rows.length ? `${rows.length}` : '', bodyWidth)}
        </text>

        {mode === 'filter' ? (
          <box flexDirection="row" width={columnWidth}>
            <text fg={theme.accent}>/</text>
            <input
              focused
              flexGrow={1}
              value={filter}
              placeholder="filter loaded rows"
              onInput={(value: string) => setFilter(value)}
              onSubmit={() => setMode('browse')}
            />
          </box>
        ) : null}

        {visible.map((row) => {
          const isCursor = row.id === current?.id;
          const indent = '  '.repeat(row.depth);
          const mark =
            row.type === 'directory' ? (row.expanded ? GLYPH.expanded : GLYPH.collapsed) : ' ';
          const right = row.loading ? '…' : row.error ? '!' : '';
          const body = layoutRow(`${indent}${mark} ${row.name}`, right, bodyWidth);
          const fg = row.error
            ? theme.danger
            : isCursor
              ? theme.fg
              : row.ignored
                ? theme.faint
                : theme.dim;
          return (
            <text key={row.id} fg={fg} bg={isCursor ? theme.surface : undefined}>
              <span fg={theme.accent}>{isCursor && focused ? GLYPH.selected : ' '}</span>
              {body}
            </text>
          );
        })}

        {rootLoad?.state === 'loading' && rows.length === 0 ? (
          <Spinner label="reading /workspace" />
        ) : null}
        {rootLoad?.state === 'error' ? (
          <text fg={theme.danger}>{layoutRow(rootLoad.message, '', bodyWidth)}</text>
        ) : null}
        {rootLoad?.state === 'loaded' && rows.length === 0 ? (
          <text fg={theme.faint}>{filter ? 'No match in loaded rows.' : 'Empty directory.'}</text>
        ) : null}

        {/* Two lines, not one: the tree column is ~30 columns at a 90-column
            terminal and a single hint row truncated to `r re…`. */}
        <text fg={theme.faint}>{layoutRow('Enter open · / filter', '', bodyWidth)}</text>
        <text fg={theme.faint}>
          {layoutRow(`r reload · . ${showHidden ? 'hide' : 'show'} dotfiles`, '', bodyWidth)}
        </text>
      </box>

      {/* The column rule, as ONE text whose content carries the newlines. A
          `<text>` per row would be an array keyed by index, and the rule has no
          identity per row to key on. */}
      <text fg={theme.border} width={1} flexShrink={0}>
        {Array(Math.max(height, 1)).fill('│').join('\n')}
      </text>

      <box flexDirection="column" flexGrow={1}>
        <FileViewer
          state={viewer}
          offset={viewerOffset}
          width={viewerWidth}
          height={Math.max(height - 1, 1)}
          focused={focused}
        />
        <text fg={theme.faint}>J/K scroll · y copy path · Esc back</text>
      </box>
    </box>
  );
}
