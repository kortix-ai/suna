'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Kbd } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { ArrowUpIcon as ArrowUp, SquareIcon } from '@phosphor-icons/react';
import { NO_MODEL_AVAILABLE_ACTION_MESSAGE } from '../model-availability';
import { NO_AGENT_ACCESS_MESSAGE } from './composer-agent-access';

const ICON_BUTTON =
  'shrink-0 rounded-full p-0 hit-area-1 transition-[color,background-color,opacity,scale] active:scale-[0.96] active:duration-150 duration-300 ease-out ';

export interface SendStopControlProps {
  isSending: boolean;
  isBusy: boolean;
  onStop?: () => void;
  stopDisabled: boolean;
  escCount: number;
  lockForQuestion: boolean;
  questionButtonLabel?: string | null;
  questionCanAct: boolean;
  hasText: boolean;
  canSubmit: boolean;
  submitDisabled: boolean;
  disabled: boolean;
  modelUnavailable: boolean;
  /**
   * The agent roster is empty for this user, so nothing can run this prompt.
   * Outranks `modelUnavailable` in the copy: with no agent, the model is not
   * the thing to go fix.
   */
  agentUnavailable?: boolean;
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
  agentUnavailable = false,
  onSubmit,
}: SendStopControlProps) {
  // One line, the same one the agent picker's tooltip carries — the two
  // controls are refusing for one reason and must not word it two ways.
  const refusal = agentUnavailable
    ? NO_AGENT_ACCESS_MESSAGE
    : modelUnavailable
      ? NO_MODEL_AVAILABLE_ACTION_MESSAGE
      : null;
  if (isSending && !lockForQuestion) {
    return (
      <Button size="icon-base" disabled className={ICON_BUTTON}>
        <Loading className="size-4" />
      </Button>
    );
  }

  if (!isSending && isBusy && (onStop || stopDisabled) && !lockForQuestion) {
    return (
      <div className="relative flex items-center">
        {escCount > 0 && (
          <div className="animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 pointer-events-none absolute right-1/2 bottom-full mb-2 translate-x-1/2 duration-150">
            <div className="bg-background text-foreground z-[9999] inline-flex w-fit items-center gap-1.5 overflow-hidden rounded-sm border p-1 px-1.5 text-[13px] whitespace-nowrap">
              <Kbd>ESC</Kbd>
              <span>{escCount === 1 ? '×2 to stop' : '×1 to stop'}</span>
            </div>
          </div>
        )}
        <Hint
          side="top"
          label={
            <p>
              Stop <Kbd>ESC</Kbd> ×3
            </p>
          }
        >
          <Button
            size="icon-base"
            onClick={onStop}
            disabled={stopDisabled || !onStop}
            className={ICON_BUTTON}
          >
            <SquareIcon weight="fill" className="size-4 shrink-0" />
          </Button>
        </Hint>
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
            className="hit-area-1 shrink-0 rounded-lg transition-[color,background-color,opacity,scale] duration-300 ease-out active:scale-[0.96] active:duration-150"
          >
            {questionButtonLabel}
          </Button>
        ) : (
          <Hint side="top" label={refusal ?? 'Send message'}>
            {/* The span, not the button, carries the tooltip trigger: a
                disabled button takes no pointer events, so the reason the send
                is off would never open — which is exactly the state where the
                reason matters most. */}
            <span className="inline-flex">
              <Button
                size="icon-base"
                disabled={
                  lockForQuestion
                    ? (!canSubmit && !questionCanAct) || disabled
                    : !canSubmit || submitDisabled
                }
                onClick={onSubmit}
                aria-label={refusal ?? 'Send message'}
                className={ICON_BUTTON}
              >
                {disabled ? (
                  <div className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </span>
          </Hint>
        )}
      </div>
    );
  }

  return null;
}
