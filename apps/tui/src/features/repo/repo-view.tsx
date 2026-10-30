/**
 * The Repo screen, as pixels and keys.
 *
 * The project's git repository: a file tree on the left, the file (or the
 * commit history) on the right. It is the read-only twin of the web's
 * `/projects/<id>/files` page.
 *
 * Like `features/files/files-screen.tsx`, the view takes async `loaders` and
 * keeps the tree in local state; `repo-screen.tsx` builds the loaders from the
 * one `kortix()` client. The tree, the viewer and the row layout are the Files
 * feature's own helpers, imported, not copied.
 *
 * Overlays are drawn IN the column, never as `ui/Modal` (see `apps-view.tsx`).
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import {
  FileViewer,
  type FileTree,
  type ReadResult,
  type TreeNode,
  type TreeRow,
  type ViewerState,
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
  toViewerState,
  viewerLines,
} from '../files/index.ts';
import { matchesRepoBinding } from './keys.ts';
import {
  type BranchRow,
  type CommitRow,
  REPO_ROOT,
  filterBranches,
  historyLabel,
  repoPath,
  sortBranches,
} from './repo-model.ts';

export interface DirectoryResult {
  nodes: TreeNode[];
  /** The folder has more entries than one response carries. */
  truncated: boolean;
}

export interface BranchList {
  defaultBranch: string;
  branches: BranchRow[];
}

/** Everything the view reads. `ref` is `undefined` for the default branch. */
export interface RepoLoaders {
  /** `path` is a tree path (`/src`); the loader converts it. */
  listDirectory(path: string, ref: string | undefined): Promise<DirectoryResult>;
  readFile(path: string, ref: string | undefined): Promise<ReadResult>;
  /** `path` null = the whole repository. */
  history(path: string | null, ref: string | undefined): Promise<CommitRow[]>;
  branches(): Promise<BranchList>;
}

export interface RepoViewProps {
  loaders: RepoLoaders;
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. Defaults to `Date.now()`. */
  now?: number;
  onBack(): void;
  onOpenWeb(): void;
  onCopy(text: string, what: string): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

type Mode = 'browse' | 'filter' | 'branch';

type HistoryState =
  | { state: 'closed' }
  | { state: 'loading'; target: string | null }
  | { state: 'error'; target: string | null; message: string }
  | { state: 'ready'; target: string | null; rows: CommitRow[] };

type BranchState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; defaultBranch: string; rows: BranchRow[] };

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? `${status} ${error.message}` : error.message;
  }
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

/** Tree column width: a third of the screen, inside a readable band. */
export function treeWidth(width: number): number {
  return Math.min(Math.max(Math.floor(width / 3), 20), 44);
}

export function RepoView({
  loaders,
  focused,
  width,
  height,
  now,
  onBack,
  onOpenWeb,
  onCopy,
  onToast,
}: RepoViewProps) {
  const [ref, setRef] = useState<string | undefined>(undefined);
  const [tree, setTree] = useState<FileTree>(() => createTree(REPO_ROOT));
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('browse');
  const [filter, setFilter] = useState('');
  const [viewer, setViewer] = useState<ViewerState>({ kind: 'empty' });
  const [viewerOffset, setViewerOffset] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ state: 'closed' });
  const [historyCursor, setHistoryCursor] = useState(0);
  const [branches, setBranches] = useState<BranchState>({ state: 'loading' });
  const [branchFilter, setBranchFilter] = useState('');
  const [branchCursor, setBranchCursor] = useState(0);
  /** Bumped when the ref changes. A read that lands after a bump is dropped. */
  const generation = useRef(0);
  const pendingRead = useRef<string | null>(null);

  const loadDirectory = useCallback(
    async (path: string, forRef: string | undefined, gen: number) => {
      setTree((current) => markLoading(current, path));
      try {
        const result = await loaders.listDirectory(path, forRef);
        if (gen !== generation.current) return;
        setTree((current) => setChildren(current, path, result.nodes));
        if (result.truncated) onToast?.(`${path} has more entries than one page.`);
      } catch (error) {
        if (gen !== generation.current) return;
        setTree((current) => setError(current, path, errorText(error)));
      }
    },
    [loaders, onToast],
  );

  // A new ref (or new loaders) starts a new tree: nothing from the old branch
  // may stay on screen.
  useEffect(() => {
    generation.current += 1;
    pendingRead.current = null;
    setTree(createTree(REPO_ROOT));
    setCursorId(null);
    setViewer({ kind: 'empty' });
    setViewerOffset(0);
    setHistory({ state: 'closed' });
    void loadDirectory(REPO_ROOT, ref, generation.current);
  }, [ref, loadDirectory]);

  const loadBranches = useCallback(() => {
    setBranches({ state: 'loading' });
    loaders
      .branches()
      .then((list) =>
        setBranches({
          state: 'ready',
          defaultBranch: list.defaultBranch,
          rows: sortBranches(list.branches),
        }),
      )
      .catch((error: unknown) => setBranches({ state: 'error', message: errorText(error) }));
  }, [loaders]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  const openFile = useCallback(
    async (path: string) => {
      const gen = generation.current;
      pendingRead.current = path;
      setViewer({ kind: 'loading', path });
      setViewerOffset(0);
      try {
        const result = await loaders.readFile(path, ref);
        if (gen !== generation.current || pendingRead.current !== path) return;
        setViewer(toViewerState(repoPath(path), result));
      } catch (error) {
        if (gen !== generation.current || pendingRead.current !== path) return;
        setViewer({ kind: 'error', path: repoPath(path), message: errorText(error) });
      }
    },
    [loaders, ref],
  );

  const loadHistory = useCallback(
    async (target: string | null) => {
      const gen = generation.current;
      setHistory({ state: 'loading', target });
      setHistoryCursor(0);
      try {
        const rows = await loaders.history(target, ref);
        if (gen !== generation.current) return;
        setHistory({ state: 'ready', target, rows });
      } catch (error) {
        if (gen !== generation.current) return;
        setHistory({ state: 'error', target, message: errorText(error) });
      }
    },
    [loaders, ref],
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
      const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      if (row) setCursorId(row.id);
    },
    [rows],
  );

  const expandRow = useCallback(
    (row: TreeRow) => {
      setTree((currentTree) => expand(currentTree, row.path));
      if (!loadStateOf(tree, row.path)) void loadDirectory(row.path, ref, generation.current);
    },
    [tree, loadDirectory, ref],
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
    const open = [REPO_ROOT, ...allRows.filter((row) => row.expanded).map((row) => row.path)];
    setTree((currentTree) => forgetLoads(currentTree));
    for (const path of open) void loadDirectory(path, ref, generation.current);
    if (history.state !== 'closed') void loadHistory(history.target);
    loadBranches();
    onToast?.(`Re-reading ${open.length} ${open.length === 1 ? 'directory' : 'directories'}…`);
  }, [allRows, loadDirectory, ref, history, loadHistory, loadBranches, onToast]);

  const toggleHistory = useCallback(() => {
    if (history.state !== 'closed') return setHistory({ state: 'closed' });
    // A file reads its own log; a directory its own; nothing selected, the repo.
    const target = current ? repoPath(current.path) : null;
    void loadHistory(target);
  }, [history, current, loadHistory]);

  const branchRows = useMemo(
    () => (branches.state === 'ready' ? filterBranches(branches.rows, branchFilter) : []),
    [branches, branchFilter],
  );
  const defaultBranch = branches.state === 'ready' ? branches.defaultBranch : null;
  const branchLabel = ref ?? defaultBranch ?? 'default branch';

  const closePicker = useCallback(() => {
    setMode('browse');
    setBranchFilter('');
    setBranchCursor(0);
  }, []);

  const pickBranch = useCallback(
    (row: BranchRow) => {
      closePicker();
      const next = row.isDefault ? undefined : row.name;
      if (next === ref) return;
      setRef(next);
    },
    [closePicker, ref],
  );

  const clearFilter = useCallback(() => {
    setMode('browse');
    setFilter('');
  }, []);

  const historyRows = history.state === 'ready' ? history.rows : [];
  const viewerRows = Math.max(height - 3, 1);
  const maxViewerOffset = Math.max(viewerLines(viewer).length - viewerRows, 0);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'filter') {
      // The `<input>` owns every other key while it is open.
      if (matchesRepoBinding(key, 'repo.back')) clearFilter();
      return;
    }

    if (mode === 'branch') {
      if (matchesRepoBinding(key, 'repo.back')) return closePicker();
      if (matchesRepoBinding(key, 'repo.pickDown'))
        return setBranchCursor((index) => Math.min(index + 1, Math.max(branchRows.length - 1, 0)));
      if (matchesRepoBinding(key, 'repo.pickUp'))
        return setBranchCursor((index) => Math.max(index - 1, 0));
      if (matchesRepoBinding(key, 'repo.open')) {
        const row = branchRows[Math.min(branchCursor, branchRows.length - 1)];
        if (row) pickBranch(row);
      }
      return;
    }

    if (matchesRepoBinding(key, 'repo.back')) {
      if (history.state !== 'closed') return setHistory({ state: 'closed' });
      if (filter) return clearFilter();
      return onBack();
    }
    if (matchesRepoBinding(key, 'repo.history')) return toggleHistory();
    if (matchesRepoBinding(key, 'repo.refresh')) return refresh();
    if (matchesRepoBinding(key, 'repo.openWeb')) return onOpenWeb();
    if (matchesRepoBinding(key, 'repo.branch')) {
      setBranchCursor(0);
      return setMode('branch');
    }

    if (history.state !== 'closed') {
      // The tree is frozen while the log is up: the same keys move the log.
      if (matchesRepoBinding(key, 'repo.down'))
        return setHistoryCursor((index) =>
          Math.min(index + 1, Math.max(historyRows.length - 1, 0)),
        );
      if (matchesRepoBinding(key, 'repo.up'))
        return setHistoryCursor((index) => Math.max(index - 1, 0));
      if (matchesRepoBinding(key, 'repo.first')) return setHistoryCursor(0);
      if (matchesRepoBinding(key, 'repo.last'))
        return setHistoryCursor(Math.max(historyRows.length - 1, 0));
      if (matchesRepoBinding(key, 'repo.copy')) {
        const commit = historyRows[historyCursor];
        if (commit) onCopy(commit.hash, `commit ${commit.shortHash}`);
      }
      return;
    }

    if (matchesRepoBinding(key, 'repo.viewerDown'))
      return setViewerOffset((offset) => Math.min(offset + viewerRows, maxViewerOffset));
    if (matchesRepoBinding(key, 'repo.viewerUp'))
      return setViewerOffset((offset) => Math.max(offset - viewerRows, 0));
    if (matchesRepoBinding(key, 'repo.down')) return moveTo(cursorIndex + 1);
    if (matchesRepoBinding(key, 'repo.up')) return moveTo(cursorIndex - 1);
    if (matchesRepoBinding(key, 'repo.first')) return moveTo(0);
    if (matchesRepoBinding(key, 'repo.last')) return moveTo(rows.length - 1);
    if (matchesRepoBinding(key, 'repo.open')) return openCurrent();
    if (matchesRepoBinding(key, 'repo.expand')) {
      if (current?.type === 'directory' && !current.expanded) expandRow(current);
      return;
    }
    if (matchesRepoBinding(key, 'repo.collapse')) {
      if (!current) return;
      if (current.type === 'directory' && current.expanded) {
        setTree((currentTree) => collapse(currentTree, current.path));
        return;
      }
      const parent = parentOf(tree, current.path);
      if (parent && parent !== REPO_ROOT) setCursorId(parent);
      return;
    }
    if (matchesRepoBinding(key, 'repo.filter')) return setMode('filter');
    if (matchesRepoBinding(key, 'repo.toggleHidden')) return setShowHidden((value) => !value);
    if (matchesRepoBinding(key, 'repo.copy')) {
      if (current) onCopy(repoPath(current.path), repoPath(current.path));
    }
  });

  const columnWidth = treeWidth(width);
  const rightWidth = Math.max(width - columnWidth - 1, 10);
  const bodyWidth = Math.max(columnWidth - 1, 0);
  const rootLoad = loadStateOf(tree, REPO_ROOT);
  const clock = now ?? Date.now();

  const left =
    mode === 'branch' ? (
      <BranchPicker
        state={branches}
        rows={branchRows}
        cursor={Math.min(branchCursor, Math.max(branchRows.length - 1, 0))}
        current={ref ?? defaultBranch}
        filter={branchFilter}
        onFilter={(value) => {
          setBranchFilter(value);
          setBranchCursor(0);
        }}
        width={columnWidth}
        height={height}
        now={clock}
        focused={focused}
      />
    ) : (
      <TreeColumn
        rows={rows}
        cursorIndex={cursorIndex}
        currentId={current?.id}
        focused={focused}
        filterOpen={mode === 'filter'}
        filter={filter}
        onFilter={setFilter}
        onFilterDone={() => setMode('browse')}
        branchLabel={branchLabel}
        showHidden={showHidden}
        loading={rootLoad?.state === 'loading' && rows.length === 0}
        errorMessage={rootLoad?.state === 'error' ? rootLoad.message : null}
        empty={rootLoad?.state === 'loaded' && rows.length === 0}
        width={columnWidth}
        height={height}
      />
    );

  return (
    <box flexDirection="row" width={width} height={height}>
      {left}
      <text fg={theme.border} width={1} flexShrink={0}>
        {Array(Math.max(height, 1)).fill('│').join('\n')}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {history.state !== 'closed' ? (
          <HistoryPane
            state={history}
            cursor={historyCursor}
            now={clock}
            width={rightWidth}
            height={Math.max(height - 1, 1)}
          />
        ) : (
          <FileViewer
            state={viewer}
            offset={viewerOffset}
            width={rightWidth}
            height={Math.max(height - 1, 1)}
            focused={focused}
          />
        )}
        <text fg={theme.faint}>
          {history.state !== 'closed'
            ? 'j/k move · y copy hash · h or Esc close'
            : 'J/K scroll · h history · y copy path · o web · Esc back'}
        </text>
      </box>
    </box>
  );
}

interface TreeColumnProps {
  rows: TreeRow[];
  cursorIndex: number;
  currentId: string | undefined;
  focused: boolean;
  filterOpen: boolean;
  filter: string;
  onFilter(value: string): void;
  onFilterDone(): void;
  branchLabel: string;
  showHidden: boolean;
  loading: boolean;
  errorMessage: string | null;
  empty: boolean;
  width: number;
  height: number;
}

function TreeColumn(props: TreeColumnProps) {
  const { rows, cursorIndex, currentId, focused, width } = props;
  const bodyWidth = Math.max(width - 1, 0);
  // Header + two hint rows, plus the filter input when it is open.
  const listRows = Math.max(props.height - (props.filterOpen ? 4 : 3), 1);
  const start = windowStart(cursorIndex, rows.length, listRows);
  const visible = rows.slice(start, start + listRows);

  return (
    <box flexDirection="column" width={width}>
      <text fg={focused ? theme.fg : theme.dim}>
        {layoutRow(`branch ${props.branchLabel}`, '', bodyWidth)}
      </text>

      {props.filterOpen ? (
        <box flexDirection="row" width={width}>
          <text fg={theme.accent}>/</text>
          <input
            focused
            flexGrow={1}
            value={props.filter}
            placeholder="filter loaded rows"
            onInput={(value: string) => props.onFilter(value)}
            onSubmit={props.onFilterDone}
          />
        </box>
      ) : null}

      {visible.map((row) => {
        const isCursor = row.id === currentId;
        const indent = '  '.repeat(row.depth);
        const mark =
          row.type === 'directory' ? (row.expanded ? GLYPH.expanded : GLYPH.collapsed) : ' ';
        const right = row.loading ? '…' : row.error ? '!' : '';
        const body = layoutRow(`${indent}${mark} ${row.name}`, right, bodyWidth);
        const fg = row.error ? theme.danger : isCursor ? theme.fg : theme.dim;
        return (
          <text key={row.id} fg={fg} bg={isCursor ? theme.surface : undefined}>
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            {body}
          </text>
        );
      })}

      {props.loading ? <Spinner label="reading repository" /> : null}
      {props.errorMessage ? (
        <text fg={theme.danger}>{layoutRow(props.errorMessage, '', bodyWidth)}</text>
      ) : null}
      {props.empty ? (
        <text fg={theme.faint}>
          {props.filter ? 'No match in loaded rows.' : 'Empty repository.'}
        </text>
      ) : null}

      <text fg={theme.faint}>{layoutRow('Enter open · / filter · b branch', '', bodyWidth)}</text>
      <text fg={theme.faint}>
        {layoutRow(`r reload · . ${props.showHidden ? 'hide' : 'show'} dotfiles`, '', bodyWidth)}
      </text>
    </box>
  );
}

interface BranchPickerProps {
  state: BranchState;
  rows: BranchRow[];
  cursor: number;
  current: string | null;
  filter: string;
  onFilter(value: string): void;
  width: number;
  height: number;
  now: number;
  focused: boolean;
}

function BranchPicker({
  state,
  rows,
  cursor,
  current,
  filter,
  onFilter,
  width,
  height,
  now,
  focused,
}: BranchPickerProps) {
  const bodyWidth = Math.max(width - 1, 0);
  const listRows = Math.max(height - 3, 1);
  const start = windowStart(cursor, rows.length, listRows);
  const visible = rows.slice(start, start + listRows);
  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.fg}>{layoutRow('Branch', `${rows.length}`, bodyWidth)}</text>
      <box flexDirection="row" width={width}>
        <text fg={theme.accent}>/</text>
        <input
          focused={focused}
          flexGrow={1}
          value={filter}
          placeholder="filter branches"
          onInput={(value: string) => onFilter(value)}
        />
      </box>
      {visible.map((row, index) => {
        const isCursor = start + index === cursor;
        const age = relativeAge(row.atMs, now);
        const name = row.sessionTitle ? `${row.name.slice(0, 8)} ${row.sessionTitle}` : row.name;
        const right = row.name === current ? 'current' : age;
        return (
          <text
            key={row.name}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor ? GLYPH.selected : ' '}</span>
            {layoutRow(row.isDefault ? `${name} (default)` : name, right, bodyWidth)}
          </text>
        );
      })}
      {state.state === 'loading' ? <Spinner label="loading branches" /> : null}
      {state.state === 'error' ? (
        <text fg={theme.danger}>{layoutRow(state.message, '', bodyWidth)}</text>
      ) : null}
      {state.state === 'ready' && rows.length === 0 ? (
        <text fg={theme.faint}>No branch matches.</text>
      ) : null}
      <text fg={theme.faint}>{layoutRow('Enter read · Esc cancel', '', bodyWidth)}</text>
    </box>
  );
}

interface HistoryPaneProps {
  state: Exclude<HistoryState, { state: 'closed' }>;
  cursor: number;
  now: number;
  width: number;
  height: number;
}

function HistoryPane({ state, cursor, now, width, height }: HistoryPaneProps) {
  const bodyWidth = Math.max(width - 1, 0);
  const rows = state.state === 'ready' ? state.rows : [];
  const listRows = Math.max(height - 1, 1);
  const at = Math.min(cursor, Math.max(rows.length - 1, 0));
  const start = windowStart(at, rows.length, listRows);
  const visible = rows.slice(start, start + listRows);
  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.fg}>
        {layoutRow(historyLabel(state.target), rows.length ? `${rows.length}` : '', bodyWidth)}
      </text>
      {visible.map((row, index) => {
        const isCursor = start + index === at;
        const age = relativeAge(row.atMs, now);
        const right = age ? `${row.author} · ${age}` : row.author;
        return (
          <text
            key={row.hash}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor ? GLYPH.selected : ' '}</span>
            <span fg={theme.faint}>{row.shortHash}</span>
            {layoutRow(` ${row.subject}`, right, bodyWidth - row.shortHash.length - 1)}
          </text>
        );
      })}
      {state.state === 'loading' ? <Spinner label="loading commits" /> : null}
      {state.state === 'error' ? (
        <text fg={theme.danger}>{layoutRow(state.message, '', bodyWidth)}</text>
      ) : null}
      {state.state === 'ready' && rows.length === 0 ? (
        <text fg={theme.faint}>No commits.</text>
      ) : null}
    </box>
  );
}
