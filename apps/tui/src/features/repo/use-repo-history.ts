/** The history pane: the commit log of the selected path, and its cursor. */

import { type RefObject, useCallback, useState } from 'react';

import type { TreeRow } from '../files/index.ts';
import { type CommitRow, errorText, repoPath } from './repo-model.ts';
import type { RepoLoaders } from './repo-view.tsx';

export type HistoryState =
  | { state: 'closed' }
  | { state: 'loading'; target: string | null }
  | { state: 'error'; target: string | null; message: string }
  | { state: 'ready'; target: string | null; rows: CommitRow[] };

export function useRepoHistory(
  loaders: RepoLoaders,
  ref: string | undefined,
  generation: RefObject<number>,
  current: TreeRow | undefined,
) {
  const [history, setHistory] = useState<HistoryState>({ state: 'closed' });
  const [historyCursor, setHistoryCursor] = useState(0);

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
    [loaders, ref, generation],
  );

  const toggleHistory = useCallback(() => {
    if (history.state !== 'closed') return setHistory({ state: 'closed' });
    // A file reads its own log; a directory its own; nothing selected, the repo.
    const target = current ? repoPath(current.path) : null;
    void loadHistory(target);
  }, [history, current, loadHistory]);

  const historyRows = history.state === 'ready' ? history.rows : [];

  return {
    history,
    setHistory,
    historyCursor,
    setHistoryCursor,
    loadHistory,
    toggleHistory,
    historyRows,
  };
}
