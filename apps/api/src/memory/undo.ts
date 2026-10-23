/**
 * What an Undo writes (pure). One change may have written several version rows
 * (both pages of a `file_note`, one `change_id`); Undo reverts them together:
 * each page goes back to the version before the change's row, and a page the
 * change created goes to the trash.
 */
import type { MemoryPageStatus, MemoryPageType } from '@kortix/api-contract';

export interface Snapshot {
  type: MemoryPageType;
  title: string;
  summary: string;
  body: string;
  status: MemoryPageStatus;
  related: string[];
  deleted: boolean;
}

export interface UndoVersion extends Snapshot {
  versionId: string;
  pageId: string;
  versionNo: number;
  undone: boolean;
}

export type UndoPlan =
  | { error: 'already_undone' | 'superseded' }
  | { steps: { pageId: string; undoes: string; snapshot: Snapshot }[] };

/**
 * `change`: the version rows of one change. `previous`: per page, the version
 * right before the change's row (null when the change created the page).
 * `newer`: page ids with a version after the change's row that is not undone.
 */
export function planUndo(
  change: readonly UndoVersion[],
  previous: ReadonlyMap<string, Snapshot | null>,
  newer: ReadonlySet<string>,
): UndoPlan {
  if (change.some((row) => row.undone)) return { error: 'already_undone' };
  if (change.some((row) => newer.has(row.pageId))) return { error: 'superseded' };
  const steps = change.map((row) => {
    const before = previous.get(row.pageId) ?? null;
    const snapshot = before ?? { ...pick(row), deleted: true };
    return { pageId: row.pageId, undoes: row.versionId, snapshot };
  });
  // Pages leaving go first: a note brought back may take the title of a page the change made.
  return { steps: [...steps.filter((step) => step.snapshot.deleted), ...steps.filter((step) => !step.snapshot.deleted)] };
}

const pick = (row: Snapshot): Snapshot => ({
  type: row.type,
  title: row.title,
  summary: row.summary,
  body: row.body,
  status: row.status,
  related: row.related,
  deleted: row.deleted,
});
