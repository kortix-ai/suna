import { loadEntireHistory, type LoadEntireHistoryOptions } from '../print/load-entire-history';

/** Resolve again after paging: older pages can change the first loaded turn's anchor. */
export async function jumpToOutcome({ needsHistory, history, resolve, scroll, unavailable, loadError }: {
  needsHistory: boolean;
  history: LoadEntireHistoryOptions;
  resolve: () => string | undefined;
  scroll: (key: string) => Promise<boolean>;
  unavailable: () => void;
  loadError: () => void;
}): Promise<void> {
  if (needsHistory && !(await loadEntireHistory(history)).exhausted) {
    loadError();
    return;
  }
  const key = resolve();
  if (!key || !await scroll(key)) unavailable();
}
