/**
 * The Repo screen, as pixels and keys.
 *
 * The project's git repository: a file tree on the left, the file (or the
 * commit history) on the right. It is the read-only twin of the web's
 * `/workspaces/<id>/files` page.
 *
 * Like `features/files/files-screen.tsx`, the view takes async `loaders` and
 * keeps the tree in local state; `repo-screen.tsx` builds the loaders from the
 * one `kortix()` client. The tree, the viewer and the row layout are the Files
 * feature's own helpers, imported, not copied.
 *
 * Overlays are drawn IN the column, never as `ui/Modal` (see `apps-view.tsx`).
 */

import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';

import { printable } from '../../lib/printable.ts';
import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import {
  FileViewer,
  type ReadResult,
  type TreeNode,
  type TreeRow,
  viewerLines,
} from '../files/index.ts';
import { matchesRepoBinding } from './keys.ts';
import { type BranchRow, type CommitRow, historyLabel, repoPath } from './repo-model.ts';
import { type BranchState, useRepoBranches } from './use-repo-branches.ts';
import { type HistoryState, useRepoHistory } from './use-repo-history.ts';
import { useRepoTree } from './use-repo-tree.ts';
import { useRepoViewer } from './use-repo-viewer.ts';

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

export type Mode = 'browse' | 'filter' | 'branch';

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
  const [mode, setMode] = useState<Mode>('browse');
  /** Bumped when the ref changes. A read that lands after a bump is dropped. */
  const generation = useRef(0);
  const reader = useRepoViewer(loaders, ref, generation);
  const files = useRepoTree(loaders, ref, generation, onToast, setMode, reader.openFile);
  const log = useRepoHistory(loaders, ref, generation, files.current);

  // A new ref (or new loaders) starts a new tree: nothing from the old branch
  // may stay on screen.
  useEffect(() => {
    generation.current += 1;
    reader.reset();
    log.setHistory({ state: 'closed' });
    files.reset(ref);
  }, [ref, reader.reset, log.setHistory, files.reset]);

  const picker = useRepoBranches(loaders, ref, setRef, setMode);
  const refresh = () => {
    const open = files.refresh();
    if (log.history.state !== 'closed') void log.loadHistory(log.history.target);
    picker.loadBranches();
    onToast?.(`Re-reading ${open.length} ${open.length === 1 ? 'directory' : 'directories'}…`);
  };

  const viewerRows = Math.max(height - 3, 1);
  const maxViewerOffset = Math.max(viewerLines(reader.viewer).length - viewerRows, 0);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'filter') {
      // The `<input>` owns every other key while it is open.
      if (matchesRepoBinding(key, 'repo.back')) files.clearFilter();
      return;
    }

    if (mode === 'branch') {
      if (matchesRepoBinding(key, 'repo.back')) return picker.closePicker();
      if (matchesRepoBinding(key, 'repo.pickDown'))
        return picker.setBranchCursor((index) =>
          Math.min(index + 1, Math.max(picker.branchRows.length - 1, 0)),
        );
      if (matchesRepoBinding(key, 'repo.pickUp'))
        return picker.setBranchCursor((index) => Math.max(index - 1, 0));
      if (matchesRepoBinding(key, 'repo.open')) {
        const row = picker.branchRows[Math.min(picker.branchCursor, picker.branchRows.length - 1)];
        if (row) picker.pickBranch(row);
      }
      return;
    }

    if (matchesRepoBinding(key, 'repo.back')) {
      if (log.history.state !== 'closed') return log.setHistory({ state: 'closed' });
      if (files.filter) return files.clearFilter();
      return onBack();
    }
    if (matchesRepoBinding(key, 'repo.history')) return log.toggleHistory();
    if (matchesRepoBinding(key, 'repo.refresh')) return refresh();
    if (matchesRepoBinding(key, 'repo.openWeb')) return onOpenWeb();
    if (matchesRepoBinding(key, 'repo.branch')) return picker.openPicker();

    if (log.history.state !== 'closed') {
      // The tree is frozen while the log is up: the same keys move the log.
      if (matchesRepoBinding(key, 'repo.down'))
        return log.setHistoryCursor((index) =>
          Math.min(index + 1, Math.max(log.historyRows.length - 1, 0)),
        );
      if (matchesRepoBinding(key, 'repo.up'))
        return log.setHistoryCursor((index) => Math.max(index - 1, 0));
      if (matchesRepoBinding(key, 'repo.first')) return log.setHistoryCursor(0);
      if (matchesRepoBinding(key, 'repo.last'))
        return log.setHistoryCursor(Math.max(log.historyRows.length - 1, 0));
      if (matchesRepoBinding(key, 'repo.copy')) {
        const commit = log.historyRows[log.historyCursor];
        if (commit) onCopy(commit.hash, `commit ${commit.shortHash}`);
      }
      return;
    }

    if (matchesRepoBinding(key, 'repo.viewerDown'))
      return reader.setViewerOffset((offset) => Math.min(offset + viewerRows, maxViewerOffset));
    if (matchesRepoBinding(key, 'repo.viewerUp'))
      return reader.setViewerOffset((offset) => Math.max(offset - viewerRows, 0));
    if (matchesRepoBinding(key, 'repo.down')) return files.moveTo(files.cursorIndex + 1);
    if (matchesRepoBinding(key, 'repo.up')) return files.moveTo(files.cursorIndex - 1);
    if (matchesRepoBinding(key, 'repo.first')) return files.moveTo(0);
    if (matchesRepoBinding(key, 'repo.last')) return files.moveTo(files.rows.length - 1);
    if (matchesRepoBinding(key, 'repo.open')) return files.openCurrent();
    if (matchesRepoBinding(key, 'repo.expand')) return files.expandCurrent();
    if (matchesRepoBinding(key, 'repo.collapse')) return files.collapseCurrent();
    if (matchesRepoBinding(key, 'repo.filter')) return setMode('filter');
    if (matchesRepoBinding(key, 'repo.toggleHidden')) return files.setShowHidden((value) => !value);
    if (matchesRepoBinding(key, 'repo.copy')) {
      if (files.current) onCopy(repoPath(files.current.path), repoPath(files.current.path));
    }
  });

  const columnWidth = treeWidth(width);
  const rightWidth = Math.max(width - columnWidth - 1, 10);
  const clock = now ?? Date.now();

  const left =
    mode === 'branch' ? (
      <BranchPicker
        state={picker.branches}
        rows={picker.branchRows}
        cursor={Math.min(picker.branchCursor, Math.max(picker.branchRows.length - 1, 0))}
        current={ref ?? picker.defaultBranch}
        filter={picker.branchFilter}
        onFilter={picker.onBranchFilter}
        width={columnWidth}
        height={height}
        now={clock}
        focused={focused}
      />
    ) : (
      <TreeColumn
        rows={files.rows}
        cursorIndex={files.cursorIndex}
        currentId={files.current?.id}
        focused={focused}
        filterOpen={mode === 'filter'}
        filter={files.filter}
        onFilter={files.setFilter}
        onFilterDone={() => setMode('browse')}
        branchLabel={picker.branchLabel}
        showHidden={files.showHidden}
        loading={files.rootLoad?.state === 'loading' && files.rows.length === 0}
        errorMessage={files.rootLoad?.state === 'error' ? files.rootLoad.message : null}
        empty={files.rootLoad?.state === 'loaded' && files.rows.length === 0}
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
        {log.history.state !== 'closed' ? (
          <HistoryPane
            state={log.history}
            cursor={log.historyCursor}
            now={clock}
            width={rightWidth}
            height={Math.max(height - 1, 1)}
          />
        ) : (
          <FileViewer
            state={reader.viewer}
            offset={reader.viewerOffset}
            width={rightWidth}
            height={Math.max(height - 1, 1)}
            focused={focused}
          />
        )}
        <text fg={theme.faint}>
          {log.history.state !== 'closed'
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
        // Commit metadata is whatever the committer wrote: no control characters reach the terminal.
        const author = printable(row.author);
        const right = age ? `${author} · ${age}` : author;
        return (
          <text
            key={row.hash}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor ? GLYPH.selected : ' '}</span>
            <span fg={theme.faint}>{row.shortHash}</span>
            {layoutRow(` ${printable(row.subject)}`, right, bodyWidth - row.shortHash.length - 1)}
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
