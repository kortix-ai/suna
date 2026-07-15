'use client';

/**
 * `ProgressCard` — the latest run's live story, not the model's checklist.
 *
 * This used to render the agent's own `todo_write` plan. That looked right on
 * paper — six items in the agent's own words is nicer than a raw tool log —
 * but it depended on the model's discipline to keep those items' statuses
 * current, and models don't always bother. On a real run all seven items sat
 * "in progress" while the chat streamed "PDF done, PPTX done" — the card froze
 * mid-run and lied about it for the rest of the session. Worse, it duplicated
 * the composer's own task strip, which already renders the server's todos
 * (`session-chat-input.tsx` via `useOpenCodeSessionTodo`) — so the plan lived
 * in two places, one of which could go stale.
 *
 * The plan now lives in exactly one place: the composer. This card shows
 * something that cannot go stale by construction — `steps`, the grouped tool
 * calls of THIS run (`groupSteps(collectAllToolParts(latestRunMessages(...)))`,
 * computed once in `easy-panel.tsx` and passed down). Tool calls stream
 * whether or not the model remembers to narrate them, so the card is always
 * exactly as current as the run itself. Bounded the same way the old plan
 * was — grouping collapses a 60-call run into ~8 lines, and latest-run scoping
 * means an old run's steps never bleed into a fresh, empty turn.
 *
 * **Nothing here is clickable.** Progress answers a question; it is not a place
 * you go. Every other card in the panel opens something when tapped, and a card
 * that looks tappable but isn't — or that hides a surprise behind a row — is
 * exactly how a non-technical user learns to distrust the whole panel. Read-only
 * is the feature.
 */

import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import type { Step } from '../shared/group-steps';
import type { RunOutcome } from '../shared/run-outcome';
import { PanelCard } from './panel-card';
import { formatDuration } from './progress-summary';
import { StepIcon } from './step-icon';

export function ProgressCard({
  steps,
  isRunning,
  elapsedMs,
  outcome,
  waitingOnUser,
}: {
  /** The latest run's grouped steps — `easy-panel.tsx`'s `latestSteps` memo, reused as-is. */
  steps: Step[];
  isRunning: boolean;
  elapsedMs?: number;
  /** How the run ended. Only read once settled — a running run has no outcome yet. */
  outcome: RunOutcome;
  /** The agent is blocked on a pending question/approval — the chat holds the controls; this card redirects attention (W9). */
  waitingOnUser: boolean;
}) {
  const duration = elapsedMs ? formatDuration(elapsedMs) : '';

  // No steps yet. Waiting outranks everything else here — the agent can be
  // "blocked on you" whether or not it's still marked as running, and that is
  // always the more truthful thing to say than a bare outcome or "Working…".
  if (steps.length === 0) {
    if (waitingOnUser) {
      return (
        <div className="border-border bg-popover flex min-h-11 w-full shrink-0 items-center justify-between gap-2 rounded-md border px-4 py-3">
          <span className="text-kortix-orange truncate text-sm">Waiting for your answer</span>
          {duration && (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {duration}
            </span>
          )}
        </div>
      );
    }

    // Nothing happened, nothing running, nothing wrong: nothing truthful to say.
    // But a FAILED or STOPPED run must say so even with no steps — silence here
    // is the panel claiming a broken run finished fine (W7).
    if (!isRunning) {
      if (outcome === 'succeeded') return null;
      return (
        <div className="border-border bg-popover flex min-h-11 w-full shrink-0 items-center justify-between gap-2 rounded-md border px-4 py-3">
          <span className="text-foreground truncate text-sm">
            {outcome === 'stopped' ? 'Stopped by you' : 'Something went wrong'}
          </span>
          {duration && (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {duration}
            </span>
          )}
        </div>
      );
    }

    // No steps yet, but still working. One live line is the whole message.
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

  // The step actively narrating right now — the last one still running, else
  // just the last step's own label (a boundary between two done steps has
  // nothing better to say), else the generic fallback.
  const currentStep = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];

  const OUTCOME_LINE: Record<RunOutcome, string> = {
    succeeded: `Done · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`,
    failed: 'Something went wrong',
    stopped: 'Stopped by you',
  };

  const subtitle = waitingOnUser
    ? 'Waiting for your answer'
    : isRunning
      ? (currentStep?.label ?? 'Working…')
      : `${OUTCOME_LINE[outcome]}${duration ? ` · ${duration}` : ''}`;

  return (
    <PanelCard
      title="Progress"
      isEmpty={false}
      // Open while it's working — watching the story unfold IS the point. Once
      // it's done, the header's outcome line says everything, and the user's
      // attention belongs on Outputs.
      defaultExpanded={isRunning}
      subtitle={
        waitingOnUser ? (
          <span className="text-kortix-orange block truncate text-sm">{subtitle}</span>
        ) : isRunning ? (
          <TextShimmer as="span" duration={1.8} spread={1.25} className="block truncate text-sm">
            {subtitle}
          </TextShimmer>
        ) : (
          <span className="text-muted-foreground truncate text-sm tabular-nums">{subtitle}</span>
        )
      }
      contentClassName="border-border border-t px-3 py-3"
    >
      <ul className="flex flex-col gap-0.5">
        {steps.map((step) => {
          const isCurrentRunning = step.status === 'running';
          const stepDuration = step.durationMs ? formatDuration(step.durationMs) : '';
          return (
            <li key={step.id} className="flex items-start gap-2.5 px-1 py-1">
              <span className="flex h-5 shrink-0 items-center">
                <StepIcon family={step.family} status={step.status} />
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 text-sm',
                  step.status === 'done' && 'text-muted-foreground',
                  step.status === 'error' && 'text-foreground',
                )}
              >
                {isCurrentRunning ? (
                  <TextShimmer as="span" duration={1.8} spread={1.25} className="block truncate">
                    {step.label}
                  </TextShimmer>
                ) : (
                  step.label
                )}
              </span>
              {stepDuration && (
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {stepDuration}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </PanelCard>
  );
}
