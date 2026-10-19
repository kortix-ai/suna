'use client';

import type { FileNode } from '@/features/file-browser/types';
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';

type MenuItem = ComponentType<{ onClick?: () => void; disabled?: boolean; children: ReactNode }>;
type MenuSeparator = ComponentType;

/**
 * The explorer's multi-selection, read by every card and row: which items are
 * selected, how a click on one behaves, what a drag of one carries, and the
 * menu a right-click on a selected one opens. Absent (no provider) = a source
 * without selection; cards then behave as single items.
 */
/**
 * The selected paths, outside React state. A card subscribes to its own
 * `has(path)` and the bar to the count, so a drag that changes three cards
 * re-renders those three, not every card in the folder.
 */
export interface SelectionStore {
  subscribe: (listener: () => void) => () => void;
  paths: () => ReadonlySet<string>;
  /** Clicks select instead of open: entered from a menu, or anything selected. */
  mode: () => boolean;
  /** Replace the selection. A set equal to the current one notifies nobody. */
  set: (paths: Set<string>, mode?: boolean) => void;
  clear: () => void;
}

export function createSelectionStore(): SelectionStore {
  let paths: ReadonlySet<string> = new Set();
  let explicitMode = false;
  const listeners = new Set<() => void>();
  const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
    a.size === b.size && [...a].every((p) => b.has(p));
  const store: SelectionStore = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    paths: () => paths,
    mode: () => explicitMode || paths.size > 0,
    set: (next, mode = true) => {
      if (mode === explicitMode && same(next, paths)) return;
      paths = next;
      explicitMode = mode;
      for (const listener of listeners) listener();
    },
    clear: () => store.set(new Set(), false),
  };
  return store;
}

const EMPTY_STORE = createSelectionStore();

export interface DriveSelection {
  store: SelectionStore;
  /**
   * A click on a card: toggles it in select mode or with ⌘/Ctrl, extends the
   * range with Shift, and otherwise calls `open`.
   */
  onItemClick: (node: FileNode, event: React.MouseEvent, open: () => void) => void;
  /** "Select" from an item's menu: select mode, with this item in. */
  selectItem: (node: FileNode) => void;
  /** What a drag of `node` moves: the whole selection when it is in it. */
  dragPaths: (node: FileNode) => string[];
  /**
   * The menu for a right-click on `node` while several are selected and it
   * is one of them, or `null` for the item's own menu.
   */
  selectionMenu: (node: FileNode, Item: MenuItem, Separator: MenuSeparator) => ReactNode | null;
}

export const DriveSelectionContext = createContext<DriveSelection | null>(null);

export function useDriveSelection(): DriveSelection | null {
  return useContext(DriveSelectionContext);
}

/** Marks a card or row as selectable for the drag-to-select rectangle. */
export const DRIVE_ITEM_ATTR = 'data-drive-item';

/**
 * What a move drag carries: one path, or several as a JSON array under the
 * same type (`DRAG_MIME`), so a drop target reads both the same way.
 */
export function encodeDragPaths(paths: string[]): string {
  return paths.length === 1 ? paths[0]! : JSON.stringify(paths);
}

export function decodeDragPaths(value: string): string[] {
  if (!value.startsWith('[')) return value ? [value] : [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    // A single path that only looks like JSON (a folder named `[draft]`).
    return [value];
  }
}

/**
 * A card's or row's side of the selection: whether it is selected, and the
 * click handler to put on it. The handler ignores clicks that only reach the
 * card through React's tree (a portaled menu item; see `own-clicks.ts`).
 */
export function useItemSelection(node: FileNode, open: () => void) {
  const selection = useDriveSelection();
  const store = selection?.store ?? EMPTY_STORE;
  // Each card reads two booleans: it re-renders only when its own flips.
  const selected = useSyncExternalStore(store.subscribe, () => store.paths().has(node.path), () => false);
  const selectMode = useSyncExternalStore(store.subscribe, store.mode, () => false);
  const onClick = (event: React.MouseEvent) => {
    if (!(event.currentTarget as Node).contains(event.target as Node)) return;
    if (selection) selection.onItemClick(node, event, open);
    else open();
  };
  return { selection, selected, selectMode, onClick };
}
