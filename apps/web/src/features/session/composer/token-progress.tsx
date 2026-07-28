'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { ProgressRing } from '@/components/ui/progress-ring';
import { STATUS_TEXT } from '@/components/ui/status';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { MessageWithParts } from '@kortix/sdk/react';

import type { FlatModel } from '../model-flatten';

// ============================================================================
// Token Progress Circle
// ============================================================================
//
// Deliberately kept visible in BOTH the simple and advanced composer toolbars
// (see composer-toolbar.tsx) — it's a quiet, non-interactive ring with no
// label text, not a "control" a non-technical user has to understand. The
// brief for the composer simplification explicitly allows ambient surfaces
// like this to stay put: it communicates "the conversation is getting long"
// without asking anyone to know what a token is.

interface TokenProgressProps {
  messages: MessageWithParts[] | undefined;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onContextClick?: () => void;
}

export function getLastAssistantTokenTotal(messages: MessageWithParts[] | undefined): number {
  if (!messages) return 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const t = (msg.info as any).tokens;
    if (!t) continue;
    const total =
      (t.input ?? 0) +
      (t.output ?? 0) +
      (t.reasoning ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0);
    if (total > 0) return total;
  }
  return 0;
}

export function getContextLimit(
  models: FlatModel[] | undefined,
  selectedModel: { providerID: string; modelID: string } | null | undefined,
): number {
  if (selectedModel && models) {
    const model = models.find(
      (m) => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID,
    );
    if (model?.contextWindow && model.contextWindow > 0) return model.contextWindow;
  }
  return 200000;
}

export function TokenProgress({
  messages,
  models,
  selectedModel,
  onContextClick,
}: TokenProgressProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const contextTokens = useMemo(() => getLastAssistantTokenTotal(messages), [messages]);
  const contextLimit = useMemo(
    () => getContextLimit(models, selectedModel),
    [models, selectedModel],
  );
  const ratio = contextTokens > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;

  if (contextTokens === 0 && !onContextClick) return null;

  const color =
    ratio >= 0.9
      ? STATUS_TEXT.destructive
      : ratio > 0.8
        ? STATUS_TEXT.warning
        : 'text-muted-foreground';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative inline-flex">
            <button
              type="button"
              className="flex size-6 cursor-pointer items-center justify-center"
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onContextClick?.();
              }}
            >
              <ProgressRing
                value={Math.round(ratio * 100)}
                className="size-5"
                progressClassName={color}
              />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="space-y-0.5 font-mono text-xs">
            <div>
              Context: {(contextTokens / 1000).toFixed(1)}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line736JsxTextK')}
              {(contextLimit / 1000).toFixed(0)}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line736JsxTextKTokens')}
            </div>
            <div className="text-muted-foreground">
              {Math.round(ratio * 100)}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line737JsxTextUsed')}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
