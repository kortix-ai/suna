'use client';

import { useTranslations } from '@/i18n/use-translations';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import Loading from '@/components/ui/loading';
import { SendStopControl } from './send-stop-control';

export interface ComposerToolbarProps {
  /** Rendered in the right cluster, ahead of send/stop. The composer passes
   *  this only for the `'inline'` underbar placement — with the `'row'`
   *  placement the slot lives on `ComposerUnderbar` instead, and handing it to
   *  both would render it twice. */
  toolbarSlot?: React.ReactNode;
  /**
   * The session sits on a rewound path. A compact Restore control renders
   * beside send/stop because send is the action that commits the path — the
   * warning lives at the moment it matters, not in a banner above the card.
   */
  rewind?: { pending?: boolean; disabled?: boolean; onRestore: () => void };
  /** Rendered FIRST in the left cluster, before the model selector. */
  leading?: React.ReactNode;

  isSending: boolean;
  isBusy: boolean;
  onStop?: () => void;
  stopDisabled: boolean;
  /** See `SendStopControl`. */
  canStop?: boolean;
  escCount: number;
  lockForQuestion: boolean;
  questionButtonLabel?: string | null;
  /** See `SendStopControl`. */
  submitLabel?: string | null;
  questionCanAct: boolean;
  hasText: boolean;
  canSubmit: boolean;
  submitDisabled: boolean;
  disabled: boolean;
  modelUnavailable: boolean;
  /** No agent is available to this user — the send is refused. See composer.tsx. */
  agentUnavailable?: boolean;
  /** A selected upload failed. See `SendStopControl`. */
  attachmentFailed?: boolean;
  /** Why the selected model cannot take the attachments, or null. See `SendStopControl`. */
  attachmentUnsupported?: string | null;
  onSubmit: () => void;
}

export function ComposerToolbar({
  toolbarSlot,
  rewind,
  leading,
  isSending,
  isBusy,
  onStop,
  stopDisabled,
  canStop,
  escCount,
  lockForQuestion,
  questionButtonLabel,
  submitLabel,
  questionCanAct,
  hasText,
  canSubmit,
  submitDisabled,
  disabled,
  modelUnavailable,
  agentUnavailable = false,
  attachmentFailed = false,
  attachmentUnsupported = null,
  onSubmit,
}: ComposerToolbarProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="kortix-composer-toolbar flex items-center justify-between gap-1 overflow-visible">
      <div className="flex min-w-0 items-center gap-1 overflow-visible">{leading}</div>

      <div className="flex shrink-0 items-center gap-1.5">
        {rewind && (
          <HoverCard openDelay={0} closeDelay={0}>
            <HoverCardTrigger asChild>
              {/* The span, not the button, carries the hover: the Button base
                  sets `disabled:pointer-events-none`, so a disabled trigger
                  would never open the card that explains WHY it is disabled. */}
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={rewind.pending || rewind.disabled}
                  onClick={rewind.onRestore}
                  className="text-muted-foreground hover:text-foreground gap-1.5"
                >
                  {rewind.pending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
                  )}
                  {tI18nComplete.raw('texta76e13b98392')}
                </Button>
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="px-3 py-2 text-sm text-balance">
              {rewind.disabled && !rewind.pending
                ? tI18nComplete.raw('text98433e61649a')
                : tI18nComplete.raw('text4c25090df9ea')}
            </HoverCardContent>
          </HoverCard>
        )}

        {toolbarSlot}

        <SendStopControl
          isSending={isSending}
          isBusy={isBusy}
          onStop={onStop}
          stopDisabled={stopDisabled}
          canStop={canStop}
          escCount={escCount}
          lockForQuestion={lockForQuestion}
          questionButtonLabel={questionButtonLabel}
          submitLabel={submitLabel}
          questionCanAct={questionCanAct}
          hasText={hasText}
          canSubmit={canSubmit}
          submitDisabled={submitDisabled}
          disabled={disabled}
          modelUnavailable={modelUnavailable}
          agentUnavailable={agentUnavailable}
          attachmentFailed={attachmentFailed}
          attachmentUnsupported={attachmentUnsupported}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
