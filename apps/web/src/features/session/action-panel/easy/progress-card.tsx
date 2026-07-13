'use client';

/**
 * `ProgressCard` — the plain-language story of the run, as a stepper.
 *
 * The earlier version made each row a disclosure that expanded the raw tool
 * views *inline*, nested inside the card's own disclosure. Two levels of
 * expand-in-place is a lot of machinery to hand a non-technical user, and it
 * crushed code and diffs into a narrow column. So: the stepper is read-only
 * and calm — icon, one plain sentence, how long it took — and tapping a step
 * slides in the real detail via the panel-filling `DetailLayer`, the same
 * surface a Context badge opens. One rule to learn: the card summarizes, the
 * detail shows.
 */

import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { useCallback, useEffect } from 'react';
import { deriveOutputs, type OutputItem } from '../shared/derive-panels';
import type { Step } from '../shared/group-steps';
import type { Detail } from './detail-view';
import { ToolParts } from './detail-view';
import { FilePreview } from './file-preview';
import { OutputRows } from './outputs-card';
import { PanelCard } from './panel-card';
import { formatDuration, progressSubtitle } from './progress-summary';
import { StepIcon } from './step-icon';

export function ProgressCard({
  steps,
  sessionId,
  isRunning,
  focusStepId,
  onOpenDetail,
  onCloseDetail,
}: {
  steps: Step[];
  sessionId: string;
  isRunning: boolean;
  /** A tool call clicked in the chat: open the card and that step's detail. */
  focusStepId?: string;
  /** Detail replaces the whole panel — so the panel, not this card, owns it. */
  onOpenDetail: (detail: Detail) => void;
  /** Closes it again — the file viewer renders its own close button. */
  onCloseDetail: () => void;
}) {
  const hasSteps = steps.length > 0;
  const subtitle = progressSubtitle(steps, isRunning);

  /** A file opened from a step behaves exactly as one opened from Outputs. */
  const fileDetail = useCallback(
    (output: OutputItem): Detail => ({
      key: `file:${output.path}`,
      title: output.name,
      hideHeader: true,
      padded: false,
      body: (
        <FilePreview path={output.path!} name={output.name} onClose={onCloseDetail} />
      ),
    }),
    [onCloseDetail],
  );

  const openStep = useCallback(
    (step: Step) => {
      // A step that WROTE something: the file is the point, not the tool call
      // that produced it. "Write · report.md · /workspace/report.md" followed by
      // a cramped snippet is the machine's account of the event; the user asked
      // to see the file. So show the file — same viewer, same copy / download /
      // full screen as Outputs, because it is the same thing.
      //
      // A failed write produces no file (`deriveOutputs` drops errored parts),
      // so it correctly falls through to the tool view, which is where the error
      // actually lives.
      if (step.family === 'edit' || step.family === 'create') {
        const files = deriveOutputs(step.parts).filter((o) => o.path);
        if (files.length === 1) {
          onOpenDetail(fileDetail(files[0]));
          return;
        }
        if (files.length > 1) {
          // Several files in one step: list them, then the same file viewer.
          onOpenDetail({
            key: step.id,
            title: step.label,
            icon: <StepIcon family={step.family} status={step.status} />,
            body: (
              <OutputRows outputs={files} onOpenOutput={(o) => onOpenDetail(fileDetail(o))} />
            ),
          });
          return;
        }
      }

      onOpenDetail({
        key: step.id,
        title: step.label,
        icon: <StepIcon family={step.family} status={step.status} />,
        // The tool views own their spacing — padding them again just narrows
        // the column that code, diffs and terminal output have to fit into.
        padded: false,
        body: <ToolParts parts={step.parts} sessionId={sessionId} />,
      });
    },
    [onOpenDetail, sessionId, fileDetail],
  );

  useEffect(() => {
    if (!focusStepId) return;
    const step = steps.find((s) => s.id === focusStepId);
    if (step) openStep(step);
  }, [focusStepId, steps, openStep]);

  return (
    <PanelCard
      title="Progress"
      isEmpty={!hasSteps}
      defaultExpanded={Boolean(focusStepId)}
      subtitle={
        isRunning && hasSteps ? (
          <TextShimmer as="span" duration={1.8} spread={1.25} className="block truncate text-sm">
            {subtitle}
          </TextShimmer>
        ) : (
          <span className="text-muted-foreground truncate text-sm tabular-nums">{subtitle}</span>
        )
      }
      // Tighter than Context: the stepper rows carry their own inset, so a p-4
      // body would inset them twice.
      contentClassName="border-border border-t px-2 py-2.5"
      emptyText="The steps the agent takes will appear here."
    >
      <Stepper orientation="vertical" count={steps.length} className="w-full">
        {steps.map((step, i) => (
          <StepperItem
            key={step.id}
            step={i + 1}
            completed={step.status !== 'running'}
            className="w-full items-start not-last:flex-1"
          >
            <StepperTrigger
              asChild
              className="w-full items-start gap-3 rounded-md p-0 text-left"
            >
              <button
                type="button"
                onClick={() => openStep(step)}
                // No vertical padding on the row: a flex container's padding sits
                // OUTSIDE its children's box, so the `self-stretch` icon column
                // could never reach into it — leaving a dead gap between the
                // connector and the next tile. The breathing room lives on the
                // label instead, where the column can span it.
                //
                // `group/step` (named, not bare — the card's own Disclosure is
                // already a `group`) so the hover fill can live on the LABEL
                // rather than the whole row: the indicator column is the
                // stepper's spine, and washing it on hover makes the tile and
                // its connector look like part of the button.
                className="group/step flex w-full cursor-pointer items-start gap-3 px-2 py-0 transition-transform active:scale-[0.998]"
              >
                {/* The indicator keeps its tinted tile in EVERY state — the
                    running step used to be the one bare icon in the column,
                    which read as a rendering slip rather than as "this one is
                    live". Its liveness is carried by the icon's own pulse. */}
                <span className="flex flex-col items-center self-stretch">
                  <StepperIndicator className="bg-muted/70 data-[state=active]:bg-muted/70 data-[state=completed]:bg-muted/70 size-7">
                    <StepIcon family={step.family} status={step.status} />
                  </StepperIndicator>
                  {/* `m-0`: the primitive ships `m-0.5`, which floats the line
                      off the tile and breaks the run into detached segments. */}
                  <StepperSeparator className="bg-border m-0 min-h-0 w-px" />
                </span>

                <span className="group-hover/step:bg-muted-foreground/[0.04] flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 transition-colors">
                  {step.status === 'running' ? (
                    <TextShimmer as="span" duration={1.8} spread={1.25} className="min-w-0 flex-1 truncate text-sm">
                      {step.label}
                    </TextShimmer>
                  ) : (
                    <StepperTitle
                      className={cn(
                        'min-w-0 flex-1 truncate font-normal',
                        step.status === 'error' && 'text-kortix-red',
                      )}
                    >
                      {step.label}
                    </StepperTitle>
                  )}
                  {typeof step.durationMs === 'number' && step.durationMs > 0 && (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {formatDuration(step.durationMs)}
                    </span>
                  )}
                </span>
              </button>
            </StepperTrigger>
          </StepperItem>
        ))}
      </Stepper>
    </PanelCard>
  );
}
