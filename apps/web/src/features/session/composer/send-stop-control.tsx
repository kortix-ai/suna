'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
      <Button size="sm" disabled className="h-8 w-8 shrink-0 rounded-full p-0">
        <Loading className="size-4" />
      </Button>
    );
  }

  if (!isSending && isBusy && (onStop || stopDisabled) && !lockForQuestion) {
    return (
      <div className="relative flex items-center">
        {/* ESC hint — matches dosco tooltip styling (bg-primary rounded-2xl) */}
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
              className="h-8 w-8 shrink-0 rounded-full p-0"
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
            className="h-8 shrink-0 rounded-full px-3.5 text-xs font-medium"
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
                  className="h-8 w-8 shrink-0 rounded-full p-0"
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
