/** The branch picker: the branch list, its filter and cursor, and the pick. */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { type BranchRow, errorText, filterBranches, sortBranches } from './repo-model.ts';
import type { Mode, RepoLoaders } from './repo-view.tsx';

export type BranchState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; defaultBranch: string; rows: BranchRow[] };

export function useRepoBranches(
  loaders: RepoLoaders,
  ref: string | undefined,
  setRef: (ref: string | undefined) => void,
  setMode: (mode: Mode) => void,
) {
  const [branches, setBranches] = useState<BranchState>({ state: 'loading' });
  const [branchFilter, setBranchFilter] = useState('');
  const [branchCursor, setBranchCursor] = useState(0);

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

  const branchRows = useMemo(
    () => (branches.state === 'ready' ? filterBranches(branches.rows, branchFilter) : []),
    [branches, branchFilter],
  );
  const defaultBranch = branches.state === 'ready' ? branches.defaultBranch : null;
  const branchLabel = ref ?? defaultBranch ?? 'default branch';

  const openPicker = () => {
    setBranchCursor(0);
    setMode('branch');
  };

  const onBranchFilter = (value: string) => {
    setBranchFilter(value);
    setBranchCursor(0);
  };

  const closePicker = useCallback(() => {
    setMode('browse');
    setBranchFilter('');
    setBranchCursor(0);
  }, [setMode]);

  const pickBranch = useCallback(
    (row: BranchRow) => {
      closePicker();
      const next = row.isDefault ? undefined : row.name;
      if (next === ref) return;
      setRef(next);
    },
    [closePicker, ref, setRef],
  );

  return {
    branches,
    branchFilter,
    onBranchFilter,
    branchCursor,
    setBranchCursor,
    loadBranches,
    branchRows,
    defaultBranch,
    branchLabel,
    openPicker,
    closePicker,
    pickBranch,
  };
}
