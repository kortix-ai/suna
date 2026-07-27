'use client';

import { useTranslations } from 'next-intl';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Agent, MessageWithParts, ProviderListResponse } from '@kortix/sdk/react';
import { Paperclip } from 'lucide-react';

import type { FlatModel } from '../model-flatten';
import type { ModelDefaultControls } from '../model-selector';
import { ModelSelector } from '../model-selector';
import { ReasoningEffortSelector } from '../reasoning-effort-selector';
import { VoiceRecorder } from '../voice-recorder';
import { AgentSelector } from './agent-selector';
import { SendStopControl } from './send-stop-control';
import { TokenProgress } from './token-progress';
import { VariantSelector } from './variant-selector';

/**
 * The composer's bottom toolbar — the familiar one.
 *
 *  - LEFT: attach, agent, model, variant, reasoning effort — all inline, all
 *    always visible, each showing its current value at rest.
 *  - RIGHT: token progress (ambient, no label), voice, send/stop.
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
 *     composer was already fine.
 */
export interface ComposerToolbarProps {
  onAttachClick: () => void;

  /** Already filtered to non-hidden, non-subagent agents (`primaryAgents` in
   *  session-chat-input.tsx) — this component does no further filtering. */
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange?: (agentName: string | null) => void;
  agentSelectorLocked: boolean;
  /** Names of the platform-owned agents inside `agents` — the picker renders
   *  those elevated above the workspace roster (see ./agent-selector). Absent
   *  or empty (every project without the `agi` flag) renders the picker
   *  exactly as it does upstream. */
  platformAgentNames?: readonly string[];

  models: FlatModel[];
  /** Threaded through to ModelSelector so it can show its loading state —
   *  added on main while this toolbar was being extracted. */
  modelsLoading?: boolean;
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  modelDefaultControls?: ModelDefaultControls;
  providers?: ProviderListResponse;
  modelRequired: boolean;

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
  platformAgentNames,
  models,
  modelsLoading,
  selectedModel,
  onModelChange,
  modelDefaultControls,
  providers,
  modelRequired,
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
  const showVariant = variants.length > 0 && !!onVariantChange;

  return (
    <div className="mb-1.5 flex items-center justify-between gap-1 overflow-visible pr-1.5 pl-2">
      {/* LEFT */}
      <div className="flex min-w-0 items-center gap-0 overflow-visible">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onAttachClick}
              className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors"
              aria-label="Attach files"
            >
              <Paperclip className="h-4 w-4" strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{tHardcodedUi.raw('componentsSessionSessionChatInput.line2252JsxTextAttachFiles')}</p>
          </TooltipContent>
        </Tooltip>

        {/* Agent, model, variant and reasoning effort sit INLINE, always
            visible — the composer people already know. An earlier pass hid
            them behind a "…" popover; that traded one glanceable row for a
            click and a guess, and the two most-changed controls (agent and
            model) stopped showing their current value at rest. */}
        {showAgent && (
          <AgentSelector
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onAgentChange ?? (() => {})}
            disabled={agentSelectorLocked}
            platformAgentNames={platformAgentNames}
          />
        )}
        {showModel && (
          <ModelSelector
            models={models}
            modelsLoading={modelsLoading}
            selectedModel={selectedModel}
            onSelect={onModelChange!}
            providers={providers}
            defaultControls={modelDefaultControls}
          />
        )}
        {showVariant && (
          <VariantSelector
            variants={variants}
            selectedVariant={selectedVariant}
            onSelect={onVariantChange!}
          />
        )}
        {/* Capability-gated internally: renders nothing unless the selected
            model actually exposes a reasoning-effort knob. */}
        <ReasoningEffortSelector model={selectedModel} projectId={projectId} />
      </div>

      {/* RIGHT: ambient token progress, any slot content, voice, send/stop. */}
      <div className="flex shrink-0 items-center gap-0">
        <TokenProgress
          messages={messages}
          models={models}
          selectedModel={selectedModel}
          onContextClick={onContextClick}
        />

        {toolbarSlot}

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
