/** The file tree: its rows, the cursor, the filter and the dotfile toggle. */

import { type RefObject, useCallback, useMemo, useState } from 'react';

import {
  type FileTree,
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
} from '../files/index.ts';
import { REPO_ROOT, errorText } from './repo-model.ts';
import type { Mode, RepoLoaders, RepoViewProps } from './repo-view.tsx';

export function useRepoTree(
  loaders: RepoLoaders,
  ref: string | undefined,
  generation: RefObject<number>,
  onToast: RepoViewProps['onToast'],
  setMode: (mode: Mode) => void,
  openFile: (path: string) => Promise<void>,
) {
  const [tree, setTree] = useState<FileTree>(() => createTree(REPO_ROOT));
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);

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
    [loaders, onToast, generation],
  );

  /** A new tree at `forRef`, cursor cleared, its root reading. */
  const reset = useCallback(
    (forRef: string | undefined) => {
      setTree(createTree(REPO_ROOT));
      setCursorId(null);
      void loadDirectory(REPO_ROOT, forRef, generation.current);
    },
    [loadDirectory, generation],
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
    [tree, loadDirectory, ref, generation],
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

  const expandCurrent = () => {
    if (current?.type === 'directory' && !current.expanded) expandRow(current);
  };

  const collapseCurrent = () => {
    if (!current) return;
    if (current.type === 'directory' && current.expanded) {
      setTree((currentTree) => collapse(currentTree, current.path));
      return;
    }
    const parent = parentOf(tree, current.path);
    if (parent && parent !== REPO_ROOT) setCursorId(parent);
  };

  /** Re-reads the root and every expanded directory; returns their paths. */
  const refresh = () => {
    const open = [REPO_ROOT, ...allRows.filter((row) => row.expanded).map((row) => row.path)];
    setTree((currentTree) => forgetLoads(currentTree));
    for (const path of open) void loadDirectory(path, ref, generation.current);
    return open;
  };

  const clearFilter = useCallback(() => {
    setMode('browse');
    setFilter('');
  }, [setMode]);

  const rootLoad = loadStateOf(tree, REPO_ROOT);

  return {
    filter,
    setFilter,
    showHidden,
    setShowHidden,
    reset,
    refresh,
    rows,
    cursorIndex,
    current,
    moveTo,
    openCurrent,
    expandCurrent,
    collapseCurrent,
    clearFilter,
    rootLoad,
  };
}
