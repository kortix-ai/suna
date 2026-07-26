'use client';

import { useTranslations } from 'next-intl';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Agent, MessageWithParts, ProviderListResponse } from '@kortix/sdk/react';
import { Paperclip } from 'lucide-react';

import type { FlatModel } from '../model-flatten';
import type { ModelDefaultControls } from '../model-selector';
import { ModelSelector } from '../model-selector';
import { useReasoningEffortControl } from '../reasoning-effort-selector';
import { ReasoningEffortSelector } from '../reasoning-effort-selector';
import { VoiceRecorder } from '../voice-recorder';
import { AgentSelector } from './agent-selector';
import { ComposerOverflowMenu } from './composer-overflow-menu';
import { hasComposerOverflowContent } from './composer-overflow';
import { SendStopControl } from './send-stop-control';
import { TokenProgress } from './token-progress';
import { VariantSelector } from './variant-selector';

/**
 * The composer's bottom toolbar — the piece the "make it feel like ChatGPT
 * Work / Claude Cowork" brief is about. ONE layout, for everyone:
 *
 *  - LEFT: attach + a single low-emphasis overflow control. Agent, model,
 *    variant and reasoning effort all live behind that overflow — see
 *    composer-overflow-menu.tsx for the agent-vs-model hierarchy inside it.
 *  - RIGHT: token progress (ambient, no label — see token-progress.tsx),
 *    voice, and send/stop.
 *
 * There used to be a second 'advanced' mode — the original dense inline
 * toolbar — behind a "Show all controls in toolbar" switch in the overflow
 * menu. It was removed because it was a ONE-WAY DOOR: advanced mode did not
 * render the overflow menu, so turning it on hid the only control that could
 * turn it off. It was also redundant; the switch changed only WHERE the same
 * four controls lived, while both paths reach them in one click. Two ways to
 * do one thing is the complexity this brief exists to remove.
 *
 * Voice and token progress are NOT power-user surfaces by the brief's own
 * carve-out (voice is an alternate input modality on par with attach; token
 * progress is a quiet ambient ring) — both stay on the right in both modes.
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
  // Same live capability check ReasoningEffortSelector uses internally —
  // computed here too so the overflow trigger doesn't render on a model with
  // no reasoning knob and an otherwise-empty overflow.
  const reasoning = useReasoningEffortControl(selectedModel, projectId);

  const showOverflow = hasComposerOverflowContent({
    showAgent,
    showModel,
    showVariant,
    showReasoningEffort: reasoning.visible,
  });

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

        {/* One composer. The dense inline toolbar used to be a second mode
            behind a switch in this menu — but `advanced` did not render the
            menu, so flipping it hid its own off-switch. Everything it exposed
            is one click away in here instead. */}
        {showOverflow && (
          <ComposerOverflowMenu
              agents={agents}
              selectedAgent={selectedAgent}
              onAgentChange={onAgentChange ?? (() => {})}
              agentSelectorLocked={agentSelectorLocked}
              showAgent={showAgent}
              models={models}
              selectedModel={selectedModel}
              onModelChange={onModelChange ?? (() => {})}
              modelDefaultControls={modelDefaultControls}
              providers={providers}
              showModel={showModel}
              variants={variants}
              selectedVariant={selectedVariant}
              onVariantChange={onVariantChange ?? (() => {})}
              showVariant={showVariant}
              reasoningModel={selectedModel}
              projectId={projectId}
            showReasoningEffort={reasoning.visible}
          />
        )}
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
