'use client';

import { cn } from '../../../lib/utils';
import { SolidCheckIcon } from '../../../internal/icons/solid-check-icon';
import type { WorkflowRunAgent } from './workflow-run';

/**
 * The run progress ring every workflow surface leads with (the run card, the
 * background run card, the agents line), and the stop and restart state its
 * agent rows share.
 */

/** Room left between two arcs, and for the round caps, in `pathLength` units (100 = the whole ring). */
const RING_GAP = 9;

/**
 * The run's progress as a ring at the head of its card: green for the agents
 * that finished, red for the ones that failed, the gray track for the rest
 * (working, starting, not started). The same stroke and round caps as the
 * session list's glyphs. It never turns: the count is the motion. The words
 * (the card's subtitle) say the same, so the ring is decoration.
 */
export function RunProgressRing({
  done,
  failed,
  total,
  size = 16,
  ended,
}: {
  done: number;
  failed: number;
  total: number;
  /** 16: a row's icon slot. 28: a card header beside a two-line title. */
  size?: 16 | 28;
  /** The run ended: a check in a whole green ring when every agent finished, a square when it was stopped. */
  ended?: 'done' | 'stopped';
}) {
  const big = size === 28;
  // Every agent finished: the solid check (the house check, never a stroked one), in the done hue.
  if (ended === 'done' && failed === 0) {
    return (
      <SolidCheckIcon
        data-tone="run-progress"
        data-done={done}
        data-failed={failed}
        data-total={total}
        data-ended="done"
        className={cn('text-kortix-green shrink-0', big ? 'size-7' : 'size-4')}
      />
    );
  }
  const ring = big ? { box: 28, c: 14, r: 11, stroke: 2.5 } : { box: 16, c: 8, r: 6.3, stroke: 1.5 };
  const part = (count: number) => (total > 0 ? (count / total) * 100 : 0);
  const arc = (count: number) => Math.max(0, part(count) - (count > 0 && count < total ? RING_GAP : 0));
  const doneArc = arc(done);
  const failedArc = arc(failed);
  return (
    <svg
      data-tone="run-progress"
      data-done={done}
      data-failed={failed}
      data-total={total}
      aria-hidden
      viewBox={`0 0 ${ring.box} ${ring.box}`}
      fill="none"
      strokeWidth={ring.stroke}
      strokeLinecap="round"
      className={cn('shrink-0 -rotate-90', big ? 'size-7' : 'size-4')}
    >
      {/* The track reads as a ring on its own (a phase not started), in both themes: the border token vanishes on dark. */}
      <circle cx={ring.c} cy={ring.c} r={ring.r} stroke="var(--muted-foreground)" strokeOpacity={0.35} />
      {done > 0 && (
        <circle cx={ring.c} cy={ring.c} r={ring.r} pathLength={100} stroke="var(--kortix-green)" strokeDasharray={`${doneArc} 100`} />
      )}
      {failed > 0 && (
        <circle
          cx={ring.c}
          cy={ring.c}
          r={ring.r}
          pathLength={100}
          stroke="var(--kortix-red)"
          strokeDasharray={`${failedArc} 100`}
          strokeDashoffset={-part(done)}
        />
      )}
      {/* The ring is turned -90°; these marks are drawn turned back, so they read upright. */}
      {ended === 'stopped' && (
        <rect
          x={ring.c - (big ? 3 : 1.75)}
          y={ring.c - (big ? 3 : 1.75)}
          width={big ? 6 : 3.5}
          height={big ? 6 : 3.5}
          rx={big ? 1.2 : 0.7}
          fill="var(--muted-foreground)"
          stroke="none"
        />
      )}
    </svg>
  );
}

export interface AgentStopState {
  /** Whether a row's agent can be stopped from here at all (a project, a live run). */
  enabled: boolean;
  /** Session ids whose stop is in flight. */
  pending: ReadonlySet<string>;
  stop: (agent: WorkflowRunAgent) => void;
  /** Claude Code's `r`: stop a running agent and start it again with the same prompt. Absent: no Restart. */
  restart?: {
    /** The agent session whose restart is in flight. */
    pending?: string;
    run: (agent: WorkflowRunAgent) => void;
  };
}
