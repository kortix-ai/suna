/**
 * The one open activity sheet per screen.
 *
 * A burst row asks for the sheet (`show`) and, while it owns it, republishes
 * its live view (`sync`). The sheet itself is hosted once by the transcript
 * screen (`ActivitySheetHost`), so it outlives the row: a burst that re-keys,
 * turns bare, or unmounts leaves the last view on screen instead of closing it.
 */

import { create } from 'zustand';
import { isToolPart, type Part } from '@kortix/sdk';
import type { ActivityContextValue } from '@/components/session/turn/activity-step';
import type { BurstView } from './activity';
import { ownsBurst } from './activity-sheet';

export interface OpenActivitySheet {
  /** Parts of the burst as last synced — decides which row owns the sheet. */
  partIds: string[];
  /** Every call the sheet has shown, including calls that left the burst. */
  callIds: string[];
  view: BurstView;
  context: ActivityContextValue;
}

interface ActivitySheetState {
  sheet: OpenActivitySheet | null;
  show: (parts: ReadonlyArray<Part>, view: BurstView, context: ActivityContextValue) => void;
  sync: (parts: ReadonlyArray<Part>, view: BurstView, context: ActivityContextValue) => void;
  close: () => void;
}

function callIdsOf(parts: ReadonlyArray<Part>): string[] {
  return parts.flatMap((part) => (isToolPart(part) ? [part.callID] : []));
}

export const useActivitySheetStore = create<ActivitySheetState>()((set) => ({
  sheet: null,
  show: (parts, view, context) =>
    set({ sheet: { partIds: parts.map((part) => part.id), callIds: callIdsOf(parts), view, context } }),
  sync: (parts, view, context) =>
    set((state) => {
      const { sheet } = state;
      if (!sheet || !ownsBurst(sheet.partIds, parts)) return state;
      const callIds = [...new Set([...sheet.callIds, ...callIdsOf(parts)])];
      return { sheet: { partIds: parts.map((part) => part.id), callIds, view, context } };
    }),
  close: () => set((state) => (state.sheet ? { sheet: null } : state)),
}));
