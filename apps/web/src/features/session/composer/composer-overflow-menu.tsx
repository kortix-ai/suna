'use client';

import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Agent, ProviderListResponse } from '@kortix/sdk/react';
import { EllipsisIcon } from 'lucide-react';

import type { FlatModel } from '../model-flatten';
import type { ReasoningEffortModelKey } from '../reasoning-effort-selector';
import { ReasoningEffortSelector } from '../reasoning-effort-selector';
import type { ModelDefaultControls } from '../model-selector';
import { ModelSelector } from '../model-selector';
import { AgentSelector } from './agent-selector';
import { VariantSelector } from './variant-selector';

/**
 * The single low-emphasis control the simple composer toolbar hides
 * everything power-user-ish behind: agent, model, variant, reasoning effort.
 * Each row still opens its EXISTING selector popover unchanged (nested Radix
 * popovers are supported out of the box — the same `command.tsx` primitives
 * this app already nests inside modals elsewhere) — so nothing about how
 * those controls work had to change, only where they render.
 *
 * *** HIERARCHY: why Agent is listed above Model ***
 * Both are "reachable in one click" once this menu is open — neither is
 * buried behind a second menu. Kortix's product model centers on Agents:
 * named personas with their own skills/instructions, picked by outcome
 * ("Research assistant", "Deploy agent") — the same mental model as
 * ChatGPT's Custom-GPT picker or a Claude Project. That's what a
 * non-technical user recognizes as "who am I talking to". The Model
 * (`gpt-5.6-sol`, `claude-hawk`, ...) is the engine swapped in underneath
 * that persona — a genuine power lever (cost/quality/latency), and one that
 * means little to read without already knowing what "a model" is. So Agent
 * gets top billing; Model sits directly below it, equally one click away.
 */
export interface ComposerOverflowMenuProps {
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange: (agentName: string | null) => void;
  agentSelectorLocked: boolean;
  showAgent: boolean;

  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange: (model: { providerID: string; modelID: string } | null) => void;
  modelDefaultControls?: ModelDefaultControls;
  providers?: ProviderListResponse;
  showModel: boolean;

  variants: string[];
  selectedVariant: string | null;
  onVariantChange: (variant: string | null) => void;
  showVariant: boolean;

  reasoningModel: ReasoningEffortModelKey | null;
  projectId: string | undefined;
  showReasoningEffort: boolean;
}

/** One setting per row: name on the left, its existing selector on the right.
 *  Uniform by design — the previous menu bolded Agent, boxed Model, and left
 *  the reasoning control as an unlabeled "Auto" chip adrift between two
 *  separators, so three settings read as three unrelated kinds of thing. */
function OverflowRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <div className="flex min-w-0 items-center justify-end">{children}</div>
    </div>
  );
}

export function ComposerOverflowMenu({
  agents,
  selectedAgent,
  onAgentChange,
  agentSelectorLocked,
  showAgent,
  models,
  selectedModel,
  onModelChange,
  modelDefaultControls,
  providers,
  showModel,
  variants,
  selectedVariant,
  onVariantChange,
  showVariant,
  reasoningModel,
  projectId,
  showReasoningEffort,
}: ComposerOverflowMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More options"
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors',
            open && 'bg-muted text-foreground',
          )}
        >
          <EllipsisIcon className="size-4" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 space-y-1 p-2">
        {showAgent && (
          <OverflowRow label="Agent">
            <AgentSelector
              agents={agents}
              selectedAgent={selectedAgent}
              onSelect={onAgentChange}
              disabled={agentSelectorLocked}
            />
          </OverflowRow>
        )}
        {showModel && (
          <OverflowRow label="Model">
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              onSelect={onModelChange}
              providers={providers}
              defaultControls={modelDefaultControls}
            />
          </OverflowRow>
        )}
        {showReasoningEffort && (
          <OverflowRow label="Thinking">
            <ReasoningEffortSelector model={reasoningModel} projectId={projectId} />
          </OverflowRow>
        )}
        {variants.length > 0 && (
          <OverflowRow label="Variant">
            <VariantSelector
              variants={variants}
              selectedVariant={selectedVariant}
              onSelect={onVariantChange}
            />
          </OverflowRow>
        )}
      </PopoverContent>
    </Popover>
  );
}
