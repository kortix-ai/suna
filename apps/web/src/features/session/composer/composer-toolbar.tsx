'use client';

import { useTranslations } from 'next-intl';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Agent, MessageWithParts, ProviderListResponse } from '@kortix/sdk/react';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react';

import type { FlatModel } from '../model-flatten';
import type { ModelDefaultControls } from '../model-selector';
import { ModelSelector } from '../model-selector';
import { VoiceRecorder } from '../voice-recorder';
import { AgentSelector } from './agent-selector';
import { SendStopControl } from './send-stop-control';
import { TokenProgress } from './token-progress';

/**
 * The composer's bottom toolbar — the familiar one.
 *
 *  - LEFT: attach, agent, model — all inline, all always visible, each
 *    showing its current value at rest. Variant (thinking mode) and
 *    reasoning effort moved INSIDE the model popover (Task 10) — they're
 *    settings on top of the selected model, not peers of it, and folding
 *    them in kept the row from growing with every new per-model knob.
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

  variants: string[];
  selectedVariant: string | null;
  onVariantChange?: (variant: string | null) => void;

  projectId: string | undefined;

  messages: MessageWithParts[] | undefined;
  onContextClick?: () => void;

  toolbarSlot?: React.ReactNode;

  /**
   * Wraps `TokenProgress` in a div with this className, e.g. `'hidden
   * sm:flex'`. Undefined (every call site except the new shell,
   * `composer/composer.tsx`) renders `TokenProgress` with no wrapper at
   * all — byte-identical to before this prop existed. `token-progress.tsx`'s
   * own doc comment records the deliberate decision to keep it always
   * visible in THIS (old) toolbar; the new shell built in Task 12 is where
   * the responsive collapse belongs, so it opts in here instead of this
   * component hard-coding a breakpoint for every consumer.
   */
  tokenProgressWrapperClassName?: string;

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
  tokenProgressWrapperClassName,
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
    <div className="kortix-composer-toolbar mb-1.5 flex items-center justify-between gap-1 overflow-visible pr-1.5 pl-2">
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
              <Paperclip className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line2252JsxTextAttachFiles')}
            </p>
          </TooltipContent>
        </Tooltip>

        {/* Agent and model sit INLINE, always visible — the composer people
            already know. An earlier pass hid them behind a "…" popover; that
            traded one glanceable row for a click and a guess, and these two
            most-changed controls stopped showing their current value at
            rest. Variant and reasoning effort now live inside the model
            popover itself (below the model list) instead of the inline row —
            see ModelSelector's `variants`/`onVariantChange`/`projectId`
            props and `model-popover-extras.ts`. */}
        {showAgent && (
          <AgentSelector
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onAgentChange ?? (() => {})}
            disabled={agentSelectorLocked}
            triggerLabelClassName="max-w-[7rem]"
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
            triggerLabelClassName="max-w-[7rem]"
            variants={variants}
            selectedVariant={selectedVariant}
            onVariantChange={onVariantChange}
            projectId={projectId}
          />
        )}
      </div>

      {/* RIGHT: ambient token progress, any slot content, voice, send/stop. */}
      <div className="flex shrink-0 items-center gap-0">
        {tokenProgressWrapperClassName ? (
          <div className={tokenProgressWrapperClassName}>
            <TokenProgress
              messages={messages}
              models={models}
              selectedModel={selectedModel}
              onContextClick={onContextClick}
            />
          </div>
        ) : (
          <TokenProgress
            messages={messages}
            models={models}
            selectedModel={selectedModel}
            onContextClick={onContextClick}
          />
        )}

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
