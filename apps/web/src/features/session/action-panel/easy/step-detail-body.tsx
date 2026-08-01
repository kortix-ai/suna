'use client';

/**
 * A step's tool calls with the chronology bar under them — Marko's ask: arrow
 * keys from start to end of a run, with the wall-clock time of whatever you are
 * looking at.
 *
 * Index and follow-mode live here rather than in the panel provider because
 * they are scoped to one open detail: closing it and opening another must start
 * at the latest action again, and local state gives that for free by
 * unmounting.
 *
 * Its own file (rather than sitting in `easy-panel.tsx`) because the detail it
 * renders is opened from the provider, which mounts above both panel surfaces —
 * importing it back out of the cards component would be a cycle.
 */

import type { ToolPart } from '@/ui';
import { useCallback, useEffect, useState } from 'react';
import { ActionNavigator } from '../shared/action-navigator';
import { type FollowMode, clampIndex } from '../shared/action-navigator-logic';
import { ToolParts } from './detail-view';
import { focusIndexForCall } from './easy-panel-logic';

export function StepDetailBody({
  parts,
  sessionId,
  /** The call the user actually clicked in the chat. A step is a GROUP ("Ran
   *  13 commands"), so without this the detail always opened on the last part
   *  in live mode — clicking the 4th command showed the 13th. */
  focusCallId,
}: {
  parts: ToolPart[];
  sessionId: string;
  focusCallId?: string;
}) {
  const focusIndex = focusIndexForCall(parts, focusCallId);
  const [index, setIndex] = useState(focusIndex >= 0 ? focusIndex : parts.length - 1);
  // Arriving from a chat click pins the view to that call; 'live' would drag
  // it straight back to the newest part on the next streaming update.
  const [mode, setMode] = useState<FollowMode>(focusIndex >= 0 ? 'manual' : 'live');

  useEffect(() => {
    if (parts.length === 0) return;
    setIndex((i) => (mode === 'live' ? parts.length - 1 : clampIndex(i, parts.length)));
  }, [parts.length, mode]);

  const safeIndex = clampIndex(index, parts.length);
  const current = parts[safeIndex];
  const atLatest = safeIndex >= parts.length - 1;

  // Stable identity so ActionNavigator's keydown effect doesn't re-subscribe
  // on every streaming re-render; setState setters are already stable.
  const handleIndexChange = useCallback((i: number, m: FollowMode) => {
    setMode(m);
    setIndex(i);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {current && <ToolParts parts={[current]} sessionId={sessionId} />}
      </div>
      <ActionNavigator
        parts={parts}
        index={safeIndex}
        isLive={atLatest && mode === 'live'}
        onIndexChange={handleIndexChange}
      />
    </div>
  );
}
