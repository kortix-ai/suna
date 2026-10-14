/**
 * The one open activity sheet per screen.
 *
 * A burst row asks for the sheet (`show`) and, while it owns it, republishes
 * its live view (`sync`). The sheet itself is hosted once by the transcript
 * screen (`ActivitySheetHost`), so it outlives the row: a burst that re-keys,
 * turns bare, or unmounts leaves the last view on screen instead of closing it.
 */

import { create } from 'zustand';
import type { SessionLogBlock } from '@kortix/sdk';
import type { PermissionReply } from '@/components/session/tool/tool-part-renderer';
import type { BurstView } from './activity';
import { ownsBurst } from './activity-sheet';

/**
 * The context a burst carries into the sheet — moved here when the dead
 * `turn/activity-step.tsx` inline row was deleted (web keeps its own twin).
 */
export interface ActivityContextValue {
  sessionId?: string;
  /** The owning turn is still working. */
  turnLive: boolean;
  /** Opens a file the agent read or wrote (the chat's file viewer). */
  onOpenFile?: (path: string) => void;
  /** Absolute sandbox path → the path a reader sees. */
  toDisplayPath?: (path: string) => string;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
}

export interface OpenActivitySheet {
  /** Blocks of the burst as last synced — decides which row owns the sheet. */
  blockIds: string[];
  /** Every call the sheet has shown, including calls that left the burst. */
  callIds: string[];
  view: BurstView;
  context: ActivityContextValue;
}

interface ActivitySheetState {
  sheet: OpenActivitySheet | null;
  show: (blocks: ReadonlyArray<SessionLogBlock>, view: BurstView, context: ActivityContextValue) => void;
  sync: (blocks: ReadonlyArray<SessionLogBlock>, view: BurstView, context: ActivityContextValue) => void;
  close: () => void;
}

function callIdsOf(blocks: ReadonlyArray<SessionLogBlock>): string[] {
  return blocks.flatMap((block) => (block.type === 'tool_call' ? [block.call_id] : []));
}

export const useActivitySheetStore = create<ActivitySheetState>()((set) => ({
  sheet: null,
  show: (blocks, view, context) =>
    set({ sheet: { blockIds: blocks.map((block) => block.id), callIds: callIdsOf(blocks), view, context } }),
  sync: (blocks, view, context) =>
    set((state) => {
      const { sheet } = state;
      if (!sheet || !ownsBurst(sheet.blockIds, blocks)) return state;
      const callIds = [...new Set([...sheet.callIds, ...callIdsOf(blocks)])];
      return { sheet: { blockIds: blocks.map((block) => block.id), callIds, view, context } };
    }),
  close: () => set((state) => (state.sheet ? { sheet: null } : state)),
}));
