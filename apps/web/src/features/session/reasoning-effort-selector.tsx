'use client';

/**
 * Reasoning-effort control for the session chat composer — shown only for a
 * model that actually exposes a tunable effort knob, driven off the SAME
 * live models.dev capability data (`@kortix/llm-catalog`'s
 * `generationControlCapabilities`) that gates the gateway settings'
 * Generation Controls panel (`generation-controls.tsx`, #4995). Never a
 * hardcoded per-model list — a reasoning model with no `reasoning_options`
 * entry still gets the generic low/medium/high fallback, a model that isn't
 * `reasoning: true` at all gets nothing.
 *
 * *** WHY THIS WRITES A PROJECT-LEVEL SETTING, NOT A PER-MESSAGE ONE ***
 * OpenCode's own message-send payload (`SendMessageOptions` in
 * `@kortix/sdk`'s `use-opencode-sessions/keys.ts`, consumed by
 * `promptOpenCodeMessage`) only ever carries `model` / `agent` / `variant` /
 * `directory` — there is no per-message reasoning-effort field to set on a
 * chat send today. Separately, models.dev-sourced models don't populate
 * OpenCode's legacy per-model `variant` map, which is why the composer's
 * `VariantSelector` renders nothing for a model like `openai/gpt-5.6-sol`
 * even though it's very much a reasoning model.
 *
 * The one path that reliably reaches the wire today is the per-project
 * **model_generation_config** the gateway injects at resolution time —
 * `packages/llm-gateway/src/pipeline/generation-defaults.ts` merges it into
 * the outbound OpenAI-shaped body (`reasoning_effort`) for any field the
 * client didn't already set, and `apps/api/src/llm-gateway/routing/
 * resolve-route.ts` re-clamps + supplies it per request from
 * `project_llm_routing_policies.model_generation_config` (same table/API the
 * Gateway → Routing settings page's "Generation defaults" panel writes).
 * This component reads/writes that same config, scoped to
 * (this project, this exact wire model) — every session in the project
 * sending to this model picks up the change immediately, and an explicit
 * per-request value (should OpenCode ever grow one) would still win, since
 * injection only ever fills a field the client left unset.
 *
 * Writing requires the `gateway.routing-policy` PUT's capability gate
 * (`PROJECT_CUSTOMIZE_WRITE`, editor+) — a plain project member can see the
 * currently configured effort but not change it; the control disables with
 * an explanatory tooltip in that case rather than hiding outright, so it
 * stays discoverable.
 */

import { Brain, Check, ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { catalogModelForGateway } from '@/features/workspace/customize/sections/view/gateway/generation-controls';
import { modelKeyToWire } from '@/hooks/runtime/use-model-store';
import { cn } from '@/lib/utils';
import { generationControlCapabilities } from '@kortix/llm-catalog';
import type { GatewayProjectRoutingPolicy } from '@kortix/sdk/projects-client';
import { useGatewayRoutingPolicy } from '@kortix/sdk/react';

export interface ReasoningEffortModelKey {
  providerID: string;
  modelID: string;
}

export interface ReasoningEffortControl {
  /** False when the model has no reasoning-effort knob, or there's no
   *  project to scope the setting to — render nothing. */
  visible: boolean;
  /** The model's own effort labels (e.g. ['none','low','medium','high','xhigh','max']). */
  values: string[];
  /** Currently configured effort for this (project, model), or null = model default. */
  current: string | null;
  /** Whether the current user can change it (editor+ on the project). */
  canWrite: boolean;
  /** Initial load or a write in flight. */
  pending: boolean;
  wireModel: string | undefined;
  setEffort: (next: string | null) => void;
}

/**
 * The model's own effort labels for the composer to offer — the show/hide
 * source of truth. Pure wrapper around `@kortix/llm-catalog`'s
 * `generationControlCapabilities` so it's testable without mounting React or
 * a query client; a model with no reasoning-effort knob returns `[]`, which
 * is exactly what makes the control render nothing.
 */
export function reasoningEffortValuesFor(wireModel: string | undefined): string[] {
  if (!wireModel) return [];
  const catalogModel = catalogModelForGateway(wireModel);
  return generationControlCapabilities(catalogModel).reasoningEffort?.values ?? [];
}

/**
 * Merge a new (or cleared) reasoning-effort choice for `wireModel` into a
 * project's `modelGenerationConfig`, preserving any other generation-config
 * fields already set for that model (temperature, topP, maxOutputTokens) and
 * every OTHER model's entry untouched. `next: null` clears the override back
 * to "model default"; if that empties the model's entry entirely, the key is
 * dropped rather than left as `{}`. Pure — no network, no React — so the
 * exact object the PUT would send is directly assertable in a test.
 */
export function applyReasoningEffort(
  modelGenerationConfig: GatewayProjectRoutingPolicy['modelGenerationConfig'],
  wireModel: string,
  next: string | null,
): GatewayProjectRoutingPolicy['modelGenerationConfig'] {
  const current = modelGenerationConfig ?? {};
  const { reasoningEffort: _currentEffort, ...restForModel } = current[wireModel] ?? {};
  const entry = next ? { ...restForModel, reasoningEffort: next } : restForModel;
  const otherEntries = Object.entries(current).filter(([key]) => key !== wireModel);
  return Object.fromEntries(
    Object.keys(entry).length > 0 ? [...otherEntries, [wireModel, entry]] : otherEntries,
  );
}

/**
 * Derive show/hide + values + current value + write mechanics for the
 * reasoning-effort control on a given (model, project). Thin React/query
 * wiring over the two pure functions above.
 */
export function useReasoningEffortControl(
  model: ReasoningEffortModelKey | null | undefined,
  projectId: string | undefined,
): ReasoningEffortControl {
  const wireModel = model ? modelKeyToWire(model) : undefined;
  const values = useMemo(() => reasoningEffortValuesFor(wireModel), [wireModel]);
  const routing = useGatewayRoutingPolicy(projectId);

  const current =
    wireModel && routing.data
      ? (routing.data.project.modelGenerationConfig?.[wireModel]?.reasoningEffort ?? null)
      : null;
  const canWrite = routing.data?.capabilities?.write ?? false;

  const setEffort = (next: string | null) => {
    if (!wireModel || !projectId || !routing.data) return;
    const policy: GatewayProjectRoutingPolicy = routing.data.project;
    routing.set.mutate({
      ...policy,
      modelGenerationConfig: applyReasoningEffort(policy.modelGenerationConfig, wireModel, next),
    });
  };

  return {
    visible: !!projectId && values.length > 0,
    values,
    current,
    canWrite,
    pending: !!projectId && (routing.isLoading || routing.set.isPending),
    wireModel,
    setEffort,
  };
}

export function ReasoningEffortSelector({
  model,
  projectId,
}: {
  model: ReasoningEffortModelKey | null;
  projectId: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { visible, values, current, canWrite, pending, wireModel, setEffort } =
    useReasoningEffortControl(model, projectId);

  if (!visible) return null;

  const locked = !canWrite;
  const displayValue = current ?? 'auto';

  return (
    <CommandPopover open={open} onOpenChange={(next) => setOpen(locked || pending ? false : next)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CommandPopoverTrigger>
            <button
              type="button"
              aria-disabled={locked || pending || undefined}
              aria-label="Reasoning effort"
              className={cn(
                'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium capitalize transition-colors duration-200',
                open && 'bg-muted text-foreground',
                current && 'text-foreground',
                (locked || pending) &&
                  'hover:text-muted-foreground cursor-not-allowed opacity-70 hover:bg-transparent',
              )}
            >
              <Brain className="size-3.5 shrink-0" />
              {/* Icon-only on phones — the Brain glyph + aria-label carry it;
                  the value label returns from `sm:` up. */}
              <span className="hidden max-w-[80px] truncate sm:inline">{displayValue}</span>
              <ChevronDown
                className={cn(
                  'size-3 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CommandPopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px]">
          {locked ? (
            <p>Only project editors can change reasoning effort for this model.</p>
          ) : (
            <p>
              Reasoning effort for <span className="font-mono">{wireModel}</span> — applies to every
              session in this project using this model.
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[180px]">
        <CommandList>
          <CommandGroup heading="Reasoning effort">
            <CommandItem
              value="reasoning-effort-default"
              onSelect={() => {
                setEffort(null);
                setOpen(false);
              }}
            >
              <span className="flex-1 truncate">Model default</span>
              {current === null && <Check className="text-foreground size-3.5 shrink-0" />}
            </CommandItem>
            {values.map((value) => (
              <CommandItem
                key={value}
                value={`reasoning-effort-${value}`}
                onSelect={() => {
                  setEffort(value);
                  setOpen(false);
                }}
              >
                <span className="flex-1 truncate capitalize">{value}</span>
                {current === value && <Check className="text-foreground size-3.5 shrink-0" />}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}
