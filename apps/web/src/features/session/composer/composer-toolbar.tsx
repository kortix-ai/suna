'use client';

import type { ProviderListResponse } from '@kortix/sdk/react';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import Loading from '@/components/ui/loading';
import type { FlatModel } from '../model-flatten';
import type { ModelDefaultControls } from '../model-selector';
import { ModelSelector } from '../model-selector';
import { ReasoningEffortSelector } from '../reasoning-effort-selector';
import { SendStopControl } from './send-stop-control';

/**
 * The composer's bottom toolbar — the familiar one, now scoped to the two
 * controls that describe WHAT will answer.
 *
 *  - LEFT: model, thinking effort — inline, showing their current value at
 *    rest. Thinking effort IS the model variant (`local.model.variant`): one
 *    knob, per session, in both runtime modes. It used to be split — a
 *    "Thinking mode" row folded inside the model popover off-gateway and a
 *    project-level routing-policy chip on-gateway (#6872) — which put the
 *    same setting in two places with two scopes. The popover row is gone.
 *  - RIGHT: send/stop.
 *
 * Attach, agent, and token progress used to sit here. They now live in the
 * row BELOW the card (`composer.tsx`, directly after the card element) so the
 * card holds the message and the controls that shape the reply, while the
 * under-row holds what you bring to it (files, agent) and what it costs
 * (context ring, hard right). Do not re-add them here — they would render
 * twice.
 *
 * The effort control's placement was resolved deliberately: it sits here,
 * glanceable at rest, and the `/` palette's "Set reasoning effort" row opens
 * it (`reasoningMenuOpen`). Do not fold it back into the model popover.
 *
 * Two earlier passes are recorded here so they are not re-attempted:
 *
 *  1. A second 'advanced' mode behind a "Show all controls in toolbar" switch.
 *     Removed: it was a ONE-WAY DOOR — advanced mode did not render the menu
 *     holding the switch, so turning it on hid its own off-switch.
 *  2. Hiding agent/model/variant/effort behind a "…" overflow popover.
 *     Removed: it traded a glanceable row for a click and a guess, and the two
 *     most-changed controls stopped showing which agent and model were active
 *     without opening a menu. Simplifying the TRANSCRIPT was the goal; the
 *     composer was already fine. Task 10's popover-fold keeps agent and model
 *     glanceable at rest — only variant/effort, which are secondary to the
 *     model choice, moved behind a click.
 */
export interface ComposerToolbarProps {
  models: FlatModel[];
  /** Threaded through to ModelSelector so it can show its loading state —
   *  added on main while this toolbar was being extracted. */
  modelsLoading?: boolean;
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  modelDefaultControls?: ModelDefaultControls;
  providers?: ProviderListResponse;
  modelRequired: boolean;
  /**
   * Lets the composer open the model popover from outside the toolbar — the
   * `/` palette's "Switch model" and "Set reasoning effort" rows. Both land on
   * this one control: reasoning effort is a footer row INSIDE the model
   * popover, not a popover of its own (see `model-selector.tsx`).
   *
   * Optional, so a toolbar rendered without them behaves exactly as before,
   * with `ModelSelector` owning its own open state.
   */
  modelMenuOpen?: boolean;
  onModelMenuOpenChange?: (open: boolean) => void;
  /** Same, for the reasoning-effort dropdown — the `/` palette's "Set
   *  reasoning effort" row. A separate pair because it is now a separate
   *  control, not a section inside the model popover. */
  reasoningMenuOpen?: boolean;
  onReasoningMenuOpenChange?: (open: boolean) => void;

  variants: string[];
  selectedVariant: string | null;
  onVariantChange?: (variant: string | null) => void;

  projectId: string | undefined;

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
  escCount: number;
  lockForQuestion: boolean;
  questionButtonLabel?: string | null;
  questionCanAct: boolean;
  hasText: boolean;
  canSubmit: boolean;
  submitDisabled: boolean;
  disabled: boolean;
  modelUnavailable: boolean;
  /** No agent is available to this user — the send is refused. See composer.tsx. */
  agentUnavailable?: boolean;
  onSubmit: () => void;
}

export function ComposerToolbar({
  models,
  modelsLoading,
  selectedModel,
  onModelChange,
  modelDefaultControls,
  providers,
  modelRequired,
  modelMenuOpen,
  onModelMenuOpenChange,
  reasoningMenuOpen,
  onReasoningMenuOpenChange,
  variants,
  selectedVariant,
  onVariantChange,
  projectId,
  toolbarSlot,
  rewind,
  leading,
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
}: ComposerToolbarProps) {
  const showModel = (models.length > 0 || modelRequired) && !!onModelChange;

  return (
    <div className="kortix-composer-toolbar flex items-center justify-between gap-1 overflow-visible">
      <div className="flex min-w-0 items-center gap-1 overflow-visible">
        {leading}

        {showModel && (
          <ModelSelector
            models={models}
            modelsLoading={modelsLoading}
            selectedModel={selectedModel}
            onSelect={onModelChange!}
            providers={providers}
            defaultControls={modelDefaultControls}
            triggerLabelClassName="max-w-[7rem]"
            projectId={projectId}
            open={modelMenuOpen}
            onOpenChange={onModelMenuOpenChange}
          />
        )}

        <ReasoningEffortSelector
          variants={variants}
          selectedVariant={selectedVariant}
          onVariantChange={onVariantChange}
          open={reasoningMenuOpen}
          onOpenChange={onReasoningMenuOpenChange}
        />
      </div>

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
                  Restore
                </Button>
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="px-3 py-2 text-sm text-balance">
              {rewind.disabled && !rewind.pending
                ? 'The agent is still working — restore is available once it finishes or you stop it.'
                : 'Session rewound — sending a new prompt commits this path. Restore keeps the removed messages and file changes.'}
            </HoverCardContent>
          </HoverCard>
        )}

        {toolbarSlot}

        <SendStopControl
          isSending={isSending}
          isBusy={isBusy}
          onStop={onStop}
          stopDisabled={stopDisabled}
          escCount={escCount}
          lockForQuestion={lockForQuestion}
          questionButtonLabel={questionButtonLabel}
          questionCanAct={questionCanAct}
          hasText={hasText}
          canSubmit={canSubmit}
          submitDisabled={submitDisabled}
          disabled={disabled}
          modelUnavailable={modelUnavailable}
          agentUnavailable={agentUnavailable}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
