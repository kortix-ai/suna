'use client';

import { createContext, useContext } from 'react';
import { type ToolOutcome } from './tool-outcome';
import { isEmptyShowPart } from '@/features/session/session-activity-groups';
import { type ToolPart } from '@/ui';

export const ToolRunningContext = createContext(false);

/**
 * Whether the row a trigger belongs to is currently expanded.
 *
 * A trigger is a node the tool builds and {@link BasicTool} renders, so the
 * tool itself cannot see the disclosure state it lives above — the `open` state
 * is `BasicTool`'s. This context is that one fact, published where the trigger
 * is RENDERED (inside the provider below) rather than where its element is
 * created, so `useToolOpen()` inside a trigger component reads the real value
 * while the same call in the tool's own body would not.
 *
 * It exists so a trigger can stop repeating what the open card already shows —
 * `bash` drops the command line from its row once the card beneath is spelling
 * the whole command out. Rows with no body never open, so the default is
 * `false` and a non-disclosure surface needs no provider.
 */
export const ToolOpenContext = createContext(false);

export function useToolOpen(): boolean {
  return useContext(ToolOpenContext);
}

/**
 * This step's verdict, supplied once by `ToolPartRenderer` and read by
 * {@link BasicTool} — the same ambient-per-part seam `ToolRunningContext` and
 * `ToolDurationContext` already use.
 *
 * It is a context and not a prop because the icon has to change for EVERY
 * registered renderer, and there are ~40 of them each passing their own
 * `icon={…}`. Threading a prop through all of them guarantees the next tool
 * added forgets it; reading it here means a failed call cannot draw a
 * business-as-usual icon no matter which tool produced it.
 */
export const ToolOutcomeContext = createContext<ToolOutcome>('ok');

export const StalePendingContext = createContext(false);

/**
 * Whether the turn that owns this part is STILL RUNNING.
 *
 * `ToolRunningContext` cannot answer this, and that is the bug this exists to
 * close. A tool call is created `pending` with an empty `input`, and its
 * arguments arrive afterwards as streamed JSON in `state.raw`. For the frames
 * between those two events, a live call is byte-for-byte identical to a
 * leftover `pending` part from a run that died — same status, same empty input,
 * same absent `raw` — so `tool-part-renderer`'s stale test matched both and
 * `ToolRunningContext` reported `false` for a call that had only just started.
 *
 * The visible cost was a row contradicting the line directly beneath it: the
 * transcript rendered "No content received" over a `write` while the SDK's own
 * status line, reading THAT SAME PART, rendered "Making changes..."
 * (`packages/sdk/src/core/turns/state.ts`). One part, two views, opposite
 * verdicts — which is what made a working session look frozen.
 *
 * The part alone cannot settle it, so the answer comes from one level up. The
 * turn already knows whether it is working (`session-chat.tsx`'s `working`), and
 * that single boolean is the whole discriminator: while the turn is live, an
 * input-less pending part is a call that has not spoken YET; once the turn is
 * over, the same part is a call that never will.
 *
 * Defaults to `false` so a surface that renders parts outside a live turn — the
 * Advanced panel, `/debug/tools`, a restored transcript — keeps the settled
 * reading without opting in.
 */
export const TurnLiveContext = createContext(false);

export const ToolDurationContext = createContext<number | undefined>(undefined);

// Background memory plumbing (searches/gets and raw .kortix/memory reads) stays
// out of the Actions panel. The memory editor tool itself ('memory'/'oc-memory')
// is NOT listed here — it renders in the panel so clicking its chat row works.
const MEMORY_LOOKUP_TOOL_NAMES = new Set([
  'get_mem',
  'get-mem',
  'oc-get_mem',
  'oc-get-mem',
  'ltm_search',
  'ltm-search',
  'mem_search',
  'mem-search',
  'memory_search',
  'memory-search',
  'oc-mem_search',
  'oc-mem-search',
]);

export function shouldShowToolPartInActionsPanel(part: Pick<ToolPart, 'tool' | 'state'>): boolean {
  if (MEMORY_LOOKUP_TOOL_NAMES.has(part.tool)) return false;
  // A `show` that handed nothing over renders an empty card, so its stepper row
  // would open onto blank space. Same verdict the chat transcript reaches.
  if (isEmptyShowPart(part)) return false;
  // A skill row opens its SKILL.md in the detail panel, so it has no Actions
  // row of its own. (It used to raise a side sheet; that sheet is gone.)
  if (part.tool === 'skill') return false;
  // File reads stay out of the Actions panel.
  if (part.tool === 'read') return false;
  return true;
}

export const ToolActivateContext = createContext<((callID: string) => void) | null>(null);

export const BoundActivateContext = createContext<(() => void) | null>(null);
