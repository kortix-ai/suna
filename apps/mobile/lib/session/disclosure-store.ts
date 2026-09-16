/**
 * Expand/collapse choices for the rows of an assistant turn — bursts, thought
 * rows, same-tool groups, file-chip runs, tool rows, and error stack traces.
 *
 * apps/web keeps this in component state (`userToggled` ref + `useState`). A
 * mobile transcript is a FlatList, and a recycled or re-mounted cell loses
 * component state, so a row the user opened would snap shut on scroll. The
 * store holds ONLY the user's explicit choice; the automatic state (open while
 * running) is computed on render, and `resolveDisclosureOpen` in
 * `./activity.ts` combines the two.
 */

import { create } from 'zustand';

export type DisclosureKind = 'burst' | 'thought' | 'group' | 'chips' | 'tool' | 'trace';

/** `burst:<first part id>`, `tool:<part id>`, … — ids stay stable while a turn streams. */
export function disclosureKey(kind: DisclosureKind, id: string): string {
  return `${kind}:${id}`;
}

interface DisclosureState {
  /** The user's explicit open/closed choice per key. Absent = never toggled. */
  choices: Record<string, boolean>;
  setChoice: (key: string, open: boolean) => void;
  clear: () => void;
}

export const useDisclosureStore = create<DisclosureState>()((set) => ({
  choices: {},
  setChoice: (key, open) =>
    set((state) => {
      if (state.choices[key] === open) return state;
      return { choices: { ...state.choices, [key]: open } };
    }),
  clear: () =>
    set((state) => (Object.keys(state.choices).length === 0 ? state : { choices: {} })),
}));

/** The user's choice for one key — `undefined` until they toggle it. */
export function useDisclosureChoice(key: string): boolean | undefined {
  return useDisclosureStore((state) => state.choices[key]);
}
