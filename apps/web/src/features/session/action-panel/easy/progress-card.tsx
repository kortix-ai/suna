'use client';

/**
 * `ProgressCard` — how far along the agent is, and nothing else.
 *
 * It used to be a transcript of tool calls, rendered as a stepper: "Recalled
 * what you told it before", "Searched and read 6 sources", "Ran a command". That
 * was the wrong genre. It restated the chat in worse words, it grew without
 * bound (a long run made hundreds of rows to scroll), and none of it answered
 * the only question the user has — *how far along is this?* An audit trail is
 * what Advanced mode is for.
 *
 * So this shows the agent's own PLAN: the checklist it wrote, in its own words,
 * with its own state. Six items, never six hundred — bounded by construction, so
 * it can never become a wall.
 *
 * **Nothing here is clickable.** Progress answers a question; it is not a place
 * you go. Every other card in the panel opens something when tapped, and a card
 * that looks tappable but isn't — or that hides a surprise behind a row — is
 * exactly how a non-technical user learns to distrust the whole panel. Read-only
 * is the feature.
 */

import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { TodoStatusIcon, type TodoItem } from '../../tool/shared/todo-helpers';
import { planProgress } from '../shared/derive-plan';
import type { RunOutcome } from '../shared/run-outcome';
import { PanelCard } from './panel-card';
import { formatDuration } from './progress-summary';

export function ProgressCard({
  plan,
  isRunning,
  elapsedMs,
  outcome,
}: {
  /** The agent's checklist. Empty when it never made one — many short runs don't. */
  plan: TodoItem[];
  isRunning: boolean;
  elapsedMs?: number;
  /** How the run ended. Only read once settled — a running run has no outcome yet. */
  outcome: RunOutcome;
}) {
  const { done, total, current } = planProgress(plan);
  const duration = elapsedMs ? formatDuration(elapsedMs) : '';

  // Nothing planned, nothing running, nothing wrong: nothing truthful to say.
  // But a FAILED or STOPPED run must say so even with no plan — silence here
  // is the panel claiming a broken run finished fine (W7).
  if (total === 0 && !isRunning) {
    if (outcome === 'succeeded') return null;
    return (
      <div className="border-border bg-popover flex min-h-11 w-full shrink-0 items-center justify-between gap-2 rounded-md border px-4 py-3">
        <span className="text-foreground truncate text-sm">
          {outcome === 'stopped' ? 'Stopped by you' : 'Something went wrong'}
        </span>
        {duration && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{duration}</span>
        )}
      </div>
    );
  }

  // No plan, but still working. One live line is the whole message.
  if (total === 0) {
    return (
      <div className="border-border bg-popover flex min-h-11 w-full shrink-0 items-center justify-between gap-2 rounded-md border px-4 py-3">
        <TextShimmer as="span" duration={1.8} spread={1.25} className="truncate text-sm">
          Working…
        </TextShimmer>
        {duration && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{duration}</span>
        )}
      </div>
    );
  }

  const OUTCOME_PREFIX: Record<RunOutcome, string> = {
    succeeded: '',
    failed: 'Something went wrong · ',
    stopped: 'Stopped by you · ',
  };

  const subtitle =
    isRunning && current
      ? `Step ${Math.min(done + 1, total)} of ${total} · ${current.content}`
      : `${OUTCOME_PREFIX[outcome]}${done} of ${total} done`;

  return (
    <PanelCard
      title="Progress"
      isEmpty={false}
      // Open while it's working — watching the plan tick over IS the point. Once
      // it's done, "6 of 6 done" in the header says everything, and the user's
      // attention belongs on Outputs.
      defaultExpanded={isRunning}
      subtitle={
        isRunning ? (
          <TextShimmer as="span" duration={1.8} spread={1.25} className="block truncate text-sm">
            {subtitle}
          </TextShimmer>
        ) : (
          <span className="text-muted-foreground truncate text-sm tabular-nums">
            {subtitle}
            {duration ? ` · ${duration}` : ''}
          </span>
        )
      }
      contentClassName="border-border border-t px-3 py-3"
    >
      <ul className="flex flex-col gap-0.5">
        {plan.map((todo, i) => (
          <li key={`${i}-${todo.content}`} className="flex items-start gap-2.5 px-1 py-1">
            <span className="flex h-5 shrink-0 items-center">
              <TodoStatusIcon status={todo.status} />
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 text-sm',
                todo.status === 'completed' && 'text-muted-foreground line-through',
                todo.status === 'cancelled' && 'text-muted-foreground/60 line-through',
                todo.status === 'in_progress' && 'text-foreground font-medium',
                todo.status === 'pending' && 'text-muted-foreground',
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </PanelCard>
  );
}
