'use client';

import { useTranslations } from 'next-intl';

import type { Agent, MessageWithParts, ProviderListResponse } from '@kortix/sdk/react';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import type { FlatModel } from '../model-flatten';
import type { ModelDefaultControls } from '../model-selector';
import { ModelSelector } from '../model-selector';
import { ReasoningEffortSelector } from '../reasoning-effort-selector';
import { VoiceRecorder } from '../voice-recorder';
import { SendStopControl } from './send-stop-control';
import { TokenProgress } from './token-progress';

/**
 * The composer's bottom toolbar — the familiar one.
 *
 *  - LEFT: attach, agent, model, reasoning effort — all inline, all showing
 *    their current value at rest. Variant (thinking mode) stays folded inside
 *    the model popover: it is a setting on top of the selected model, not a
 *    peer of it. Reasoning effort is NOT — it is a per-project setting, so it
 *    sits beside the model rather than two clicks inside it.
 *  - RIGHT: token progress (ambient, no label), voice, send/stop.
 *
 * Reasoning effort's placement is contested and was resolved deliberately.
 * `main` removed it from this bar (PR #6381: "it lives inside the
 * session-overrides panel — the bar keeps only agent + model") and its
 * overrides panel does carry a working control. This branch keeps it here as
 * well, by explicit decision, which means it is reachable from both places.
 * If that duplication is unwanted, the fix is to delete the
 * `ReasoningEffortSelector` render below plus the `reasoningMenuOpen` pair —
 * not to assume a merge dropped it by accident.
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
  onAttachClick: () => void;

  /** Already filtered to non-hidden, non-subagent agents (`primaryAgents` in
   *  session-chat-input.tsx) — this component does no further filtering. */
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange?: (agentName: string | null) => void;
  agentSelectorLocked: boolean;

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

  messages: MessageWithParts[] | undefined;
  onContextClick?: () => void;

  toolbarSlot?: React.ReactNode;

  onTranscription: (text: string) => void;
  voiceDisabled: boolean;

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
  onSubmit: () => void;
}

export function ComposerToolbar({
  onAttachClick,
  agents,
  selectedAgent,
  onAgentChange,
  agentSelectorLocked,
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
  messages,
  onContextClick,
  toolbarSlot,
  onTranscription,
  voiceDisabled,
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
}: ComposerToolbarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const showAgent = agents.length > 0 && !!(onAgentChange || agentSelectorLocked);
  const showModel = (models.length > 0 || modelRequired) && !!onModelChange;

  return (
    <div className="kortix-composer-toolbar flex items-center justify-between gap-1 overflow-visible px-1">
      <div className="flex min-w-0 items-center gap-1 overflow-visible">
        <Hint
          side="top"
          label={tHardcodedUi.raw('componentsSessionSessionChatInput.line2252JsxTextAttachFiles')}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-base"
            onClick={onAttachClick}
            aria-label="Attach files"
            className="text-muted-foreground rounded-full"
          >
            <Paperclip className="size-4 shrink-0" />
          </Button>
        </Hint>

        {/* {showAgent && (
          <AgentSelector
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onAgentChange ?? (() => {})}
            disabled={agentSelectorLocked}
            triggerLabelClassName="max-w-[7rem]"
          />
        )} */}

        {showModel && (
          <ModelSelector
            models={models}
            modelsLoading={modelsLoading}
            selectedModel={selectedModel}
            onSelect={onModelChange!}
            providers={providers}
            defaultControls={modelDefaultControls}
            triggerLabelClassName="max-w-[7rem]"
            variants={variants}
            selectedVariant={selectedVariant}
            onVariantChange={onVariantChange}
            projectId={projectId}
            open={modelMenuOpen}
            onOpenChange={onModelMenuOpenChange}
          />
        )}

        <ReasoningEffortSelector
          model={selectedModel}
          projectId={projectId}
          open={reasoningMenuOpen}
          onOpenChange={onReasoningMenuOpenChange}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <TokenProgress
          messages={messages}
          models={models}
          selectedModel={selectedModel}
          onContextClick={onContextClick}
        />

        {/* {toolbarSlot} */}

        <VoiceRecorder onTranscription={onTranscription} disabled={voiceDisabled} />

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
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
