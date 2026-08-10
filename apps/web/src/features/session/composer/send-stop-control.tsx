'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react';

import { NO_MODEL_AVAILABLE_ACTION_MESSAGE } from '../model-availability';

// ============================================================================
// Send / Stop control — right-most action in the composer toolbar.
// ============================================================================
//
// Unchanged behaviourally from the original inline JSX (pure extraction):
// three mutually exclusive states — sending spinner, stop button (with the
// triple-ESC hint), and the normal send button (or the question action
// button while a structured question is active).

/**
 * The composer's icon-button geometry, shared by the three mutually exclusive
 * states below so they can never drift apart mid-transition — a send button
 * that changed width when it became a stop button would shift the whole right
 * cluster the instant a turn starts.
 *
 *  - `h-8 w-9` — 32px tall, 36px wide. A 9/8 pill, matching the attach and
 *    dictation buttons; a 32px square reads narrower than the text pills
 *    beside it at the same height.
 *  - `hit-area-1` — 4px of invisible target on every side (44×40 real), with
 *    zero layout cost. The row's `gap-2` is 8px, so neighbouring extensions
 *    meet exactly and never overlap.
 *  - `transition-[...]` — named properties. `Button`'s base variant ships
 *    `transition-all`, which would animate width/padding during the state
 *    swap as well as color; this narrows it to what should actually move.
 */
const ICON_BUTTON =
  'h-8 w-9 flex-shrink-0 rounded-full p-0 hit-area-1 ' +
  'transition-[background-color,color,opacity,scale] duration-300 ease-out ' +
  'active:scale-[0.96] active:duration-150';

export interface SendStopControlProps {
  isSending: boolean;
  isBusy: boolean;
  onStop?: () => void;
  stopDisabled: boolean;
  escCount: number;
  lockForQuestion: boolean;
  questionButtonLabel?: string | null;
  questionCanAct: boolean;
  /** `text.trim().length > 0` — used only for the question-mode button swap,
   *  which cares specifically about typed text, not attachments. */
  hasText: boolean;
  canSubmit: boolean;
  submitDisabled: boolean;
  disabled: boolean;
  modelUnavailable: boolean;
  onSubmit: () => void;
}

export function SendStopControl({
  isSending,
  isBusy,
  onStop,
  stopDisabled,
  escCount,
  lockForQuestion,
  questionButtonLabel,
  questionCanAct,
  hasText,
  canSubmit,
  submitDisabled,
  disabled,
  modelUnavailable,
  onSubmit,
}: SendStopControlProps) {
  if (isSending && !lockForQuestion) {
    return (
      <Button size="sm" disabled className={ICON_BUTTON}>
        <Loading className="size-4" />
      </Button>
    );
  }

  if (!isSending && isBusy && (onStop || stopDisabled) && !lockForQuestion) {
    return (
      <div className="relative flex items-center">
        {/* ESC hint — matches Kortix tooltip styling (bg-primary rounded-2xl) */}
        {escCount > 0 && (
          <div className="animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 pointer-events-none absolute right-1/2 bottom-full mb-2 translate-x-1/2 duration-150">
            <div className="bg-primary text-primary-foreground flex items-center gap-1.5 rounded-2xl px-3 py-1.5 text-xs whitespace-nowrap">
              <kbd className="bg-background/20 text-primary-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-xs font-medium">
                ESC
              </kbd>
              <span>{escCount === 1 ? '×2 to stop' : '×1 to stop'}</span>
            </div>
            {/* Arrow matching TooltipContent */}
            <div className="-mt-px flex justify-center">
              <div className="bg-primary size-2.5 -translate-y-[calc(50%_-_2px)] rotate-45 rounded-[2px]" />
            </div>
          </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={onStop}
              disabled={stopDisabled || !onStop}
              className={ICON_BUTTON}
            >
              <div className="h-3 w-3 rounded-[3px] bg-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              Stop{' '}
              <kbd className="bg-background/20 text-primary-foreground ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-xs font-medium">
                ESC
              </kbd>{' '}
              ×3
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (!isSending && (!isBusy || lockForQuestion)) {
    return (
      <div className="opacity-100">
        {lockForQuestion && questionButtonLabel && !hasText ? (
          <Button
            size="sm"
            disabled={!questionCanAct || disabled}
            onClick={onSubmit}
            // `w-auto` releases the 36px pill width — this one is a text
            // button. `px-3` matches every other text pill in the row.
            className={cn(ICON_BUTTON, 'w-auto px-3 text-xs font-medium')}
          >
            {questionButtonLabel}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex rounded-full">
                <Button
                  size="sm"
                  disabled={
                    lockForQuestion
                      ? (!canSubmit && !questionCanAct) || disabled
                      : !canSubmit || submitDisabled
                  }
                  onClick={onSubmit}
                  aria-label={
                    modelUnavailable ? NO_MODEL_AVAILABLE_ACTION_MESSAGE : 'Send message'
                  }
                  className={ICON_BUTTON}
                >
                  {disabled ? (
                    <div className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            {modelUnavailable && (
              <TooltipContent side="top" className="max-w-[260px] text-xs">
                <p>{NO_MODEL_AVAILABLE_ACTION_MESSAGE}</p>
              </TooltipContent>
            )}
          </Tooltip>
        )}
      </div>
    );
  }

  return null;
}
