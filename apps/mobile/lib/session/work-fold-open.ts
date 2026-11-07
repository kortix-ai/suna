/**
 * Which settled turns have their "Worked for" row open (KRTX-2113).
 *
 * The session list is a FlatList (`windowSize={11}`): a turn that scrolls out
 * of the window unmounts, and state inside it is lost. A reader who opened a
 * turn's work, scrolled away and came back found it closed again. The open
 * set lives here, keyed by turn id, so it survives the remount.
 *
 * Module scope is deliberate: turn ids are unique, the set holds only the
 * turns a reader opened, and it lasts as long as the app process.
 */
import { useCallback, useSyncExternalStore } from 'react';

const open = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleWorkFold(turnId: string): void {
  if (open.has(turnId)) open.delete(turnId);
  else open.add(turnId);
  for (const listener of listeners) listener();
}

export function isWorkFoldOpen(turnId: string): boolean {
  return open.has(turnId);
}

/** `[open, toggle]` for one turn's "Worked for" row. Closed until the reader opens it. */
export function useWorkFoldOpen(turnId: string): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => open.has(turnId), () => false);
  const toggle = useCallback(() => toggleWorkFold(turnId), [turnId]);
  return [value, toggle];
}
