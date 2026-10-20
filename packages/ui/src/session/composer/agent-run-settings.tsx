'use client';

import { useTranslations } from '../../i18n';

import type { Agent, FlatModel, ProviderListResponse } from '@kortix/sdk/react';
import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';

import { Button } from '../../primitives/button';
import { ModelSelector, type ModelDefaultControls } from '../models/model-selector';
import { ReasoningEffortSelector } from './reasoning-effort-selector';

export interface AgentRunSettingsProps {
  /** The selected agent; its model and reasoning are what this pane edits. */
  agent: Agent | undefined;
  models: FlatModel[];
  modelsLoading?: boolean;
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange: (model: { providerID: string; modelID: string } | null) => void;
  /** True while the agent runs on its own model (no override in this composer). */
  modelOnDefault?: boolean;
  /** Drops the override; absent = no reset affordance. */
  onModelReset?: () => void;
  modelDefaultControls?: ModelDefaultControls;
  providers?: ProviderListResponse;
  projectId?: string;
  modelMenuOpen?: boolean;
  onModelMenuOpenChange?: (open: boolean) => void;
  variants: readonly string[];
  selectedVariant: string | null;
  onVariantChange?: (variant: string | null) => void;
  reasoningMenuOpen?: boolean;
  onReasoningMenuOpenChange?: (open: boolean) => void;
}

/**
 * The right pane of the agent popover (KRTX-2700): the selected agent's model
 * and reasoning. The agent's own model is the baseline ("Agent default"); a
 * pick is an override for THIS agent, with Reset beside it. Reasoning "Auto"
 * is its own reset, so it needs none.
 */
export function AgentRunSettings({
  agent,
  models,
  modelsLoading,
  selectedModel,
  onModelChange,
  modelOnDefault = true,
  onModelReset,
  modelDefaultControls,
  providers,
  projectId,
  modelMenuOpen,
  onModelMenuOpenChange,
  variants,
  selectedVariant,
  onVariantChange,
  reasoningMenuOpen,
  onReasoningMenuOpenChange,
}: AgentRunSettingsProps) {
  const t = useTranslations('threads');
  const name = agent
    ? isMetaAgentName(agent.name)
      ? META_AGENT_DISPLAY_NAME
      : capitalizeWords(agent.name)
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {name && (
        <div className="min-w-0">
          <p className="text-foreground truncate text-sm font-medium">{name}</p>
          {agent?.description && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{agent.description}</p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{t('runSettingsModel')}</span>
          {modelOnDefault ? (
            <span className="text-muted-foreground text-xs">{t('runSettingsAgentDefault')}</span>
          ) : onModelReset ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={onModelReset}
              className="h-auto p-0 text-xs"
            >
              {t('runSettingsReset')}
            </Button>
          ) : null}
        </div>
        <ModelSelector
          models={models}
          modelsLoading={modelsLoading}
          selectedModel={selectedModel}
          onSelect={onModelChange}
          providers={providers}
          defaultControls={modelDefaultControls}
          triggerVariant="secondary"
          triggerLabelClassName="max-w-[12rem]"
          projectId={projectId}
          offerProviderAccounts
          open={modelMenuOpen}
          onOpenChange={onModelMenuOpenChange}
        />
      </div>

      {variants.length > 0 && onVariantChange && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t('thinkingEffort')}</span>
          <div>
            <ReasoningEffortSelector
              variants={variants}
              selectedVariant={selectedVariant}
              onVariantChange={onVariantChange}
              open={reasoningMenuOpen}
              onOpenChange={onReasoningMenuOpenChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}
