'use client';

/**
 * Per-model generation-parameter controls (reasoning effort, temperature,
 * top_p, max output tokens) — capability-gated off the live catalog, never
 * hardcoded per model. Shared by the routing section's project-default
 * config and the Playground's per-model tuning.
 *
 * *** CAPABILITY DATA SOURCE ***
 * `catalogModelForGateway` mirrors apps/api's `catalogModelForWireModel`
 * (models/catalog-models.ts) but reads the WEB-side catalog —
 * `LLM_PROVIDER_BY_ID` (apps/web/src/lib/llm-providers.ts), which is the
 * baked snapshot until `applyLiveLlmProviderCatalog` pushes the live,
 * hourly-refreshed catalog over it. Same underlying models.dev data, no
 * extra network round trip — every field this component reads
 * (reasoning_options, temperature, limit.output) was threaded onto
 * `LlmProviderModel` in that module for exactly this purpose.
 */

import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { LLM_PROVIDER_BY_ID, type LlmProviderModel } from '@/lib/llm-providers';
import {
  generationControlCapabilities,
  getManagedModel,
  pricingRefLookupCandidates,
} from '@kortix/llm-catalog';
import type { GatewayModelGenerationConfig } from '@kortix/sdk/projects-client';

/** See the module doc comment — this is the client-side mirror of
 *  apps/api's `catalogModelForWireModel`. Kept in lockstep deliberately:
 *  same precedence (codex/<id> → openai/<id>, provider/model, managed
 *  bare id via pricingRef, synthetic `auto`), same permissive fallback for
 *  a managed model models.dev doesn't carry under its own id. */
export function catalogModelForGateway(wireModel: string): LlmProviderModel | undefined {
  if (wireModel.startsWith('codex/')) {
    const id = wireModel.slice('codex/'.length);
    return LLM_PROVIDER_BY_ID.get('openai')?.models.find((m) => m.id === id);
  }
  const slash = wireModel.indexOf('/');
  if (slash > 0) {
    const providerId = wireModel.slice(0, slash);
    const modelId = wireModel.slice(slash + 1);
    return LLM_PROVIDER_BY_ID.get(providerId)?.models.find((m) => m.id === modelId);
  }
  const managed = getManagedModel(wireModel);
  if (managed) {
    // Try dot/dash id variants (see `pricingRefLookupCandidates`) so a
    // dotted-vs-dashed slip in `pricingRef` degrades gracefully instead of
    // silently losing real capability data.
    for (const ref of pricingRefLookupCandidates(managed.pricingRef)) {
      const refSlash = ref.indexOf('/');
      if (refSlash <= 0) continue;
      const byRef = LLM_PROVIDER_BY_ID.get(ref.slice(0, refSlash))?.models.find(
        (m) => m.id === ref.slice(refSlash + 1),
      );
      if (byRef) return byRef;
    }
    return {
      id: managed.id,
      name: managed.name,
      released: null,
      reasoning: true,
      tool_call: true,
      temperature: true,
      limit: managed.limit,
    };
  }
  if (wireModel === 'auto' || wireModel === 'kortix/auto') {
    return {
      id: 'auto',
      name: 'Auto',
      released: null,
      reasoning: false,
      tool_call: true,
      temperature: true,
      limit: { context: 1_000_000, output: 128_000 },
    };
  }
  return undefined;
}

const EMPTY_CONFIG: GatewayModelGenerationConfig = {};

/**
 * Compact, capability-gated generation-controls panel for a single model.
 * Renders NOTHING for a control the model doesn't support — driven entirely
 * off `generationControlCapabilities` (`@kortix/llm-catalog`), never a
 * per-model id check. Returns `null` (no panel at all) when the model
 * supports none of the four controls.
 */
export function GenerationControlsPanel({
  model,
  value,
  onChange,
  disabled,
}: {
  model: string;
  value: GatewayModelGenerationConfig | undefined;
  onChange: (next: GatewayModelGenerationConfig) => void;
  disabled?: boolean;
}) {
  const catalogModel = useMemo(() => catalogModelForGateway(model), [model]);
  const caps = useMemo(() => generationControlCapabilities(catalogModel), [catalogModel]);
  const config = value ?? EMPTY_CONFIG;

  const hasAnyControl =
    !!caps.reasoningEffort || caps.temperature || caps.topP || !!caps.maxOutputTokens;
  if (!hasAnyControl) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <AlertTriangle className="size-3 shrink-0" />
        This model exposes no tunable generation parameters.
      </p>
    );
  }

  const set = <K extends keyof GatewayModelGenerationConfig>(
    key: K,
    next: GatewayModelGenerationConfig[K],
  ) => {
    const updated = { ...config, [key]: next };
    if (next === undefined) delete updated[key];
    onChange(updated);
  };

  return (
    <div className="space-y-4">
      {caps.reasoningEffort ? (
        <div className="flex items-center justify-between gap-3">
          <Label className="text-muted-foreground text-xs font-normal">Reasoning effort</Label>
          <Select
            value={config.reasoningEffort ?? '__default'}
            onValueChange={(next) =>
              set('reasoningEffort', next === '__default' ? undefined : next)
            }
            disabled={disabled}
          >
            <SelectTrigger className="w-36" size="sm" aria-label="Reasoning effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">Model default</SelectItem>
              {caps.reasoningEffort.values.map((effort) => (
                <SelectItem key={effort} value={effort} className="capitalize">
                  {effort}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {caps.temperature ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-muted-foreground text-xs font-normal">
              Temperature
              {config.temperature !== undefined ? (
                <span className="tabular-nums"> — {config.temperature.toFixed(2)}</span>
              ) : (
                <span className="text-muted-foreground/70"> — default</span>
              )}
            </Label>
            {config.temperature !== undefined ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                onClick={() => set('temperature', undefined)}
                disabled={disabled}
              >
                Reset
              </button>
            ) : null}
          </div>
          <Slider
            value={[config.temperature ?? 1]}
            min={0}
            max={2}
            step={0.05}
            disabled={disabled}
            onValueChange={([next]) => set('temperature', next)}
          />
        </div>
      ) : null}

      {caps.topP ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-muted-foreground text-xs font-normal">
              Top-p
              {config.topP !== undefined ? (
                <span className="tabular-nums"> — {config.topP.toFixed(2)}</span>
              ) : (
                <span className="text-muted-foreground/70"> — default</span>
              )}
            </Label>
            {config.topP !== undefined ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                onClick={() => set('topP', undefined)}
                disabled={disabled}
              >
                Reset
              </button>
            ) : null}
          </div>
          <Slider
            value={[config.topP ?? 1]}
            min={0}
            max={1}
            step={0.01}
            disabled={disabled}
            onValueChange={([next]) => set('topP', next)}
          />
        </div>
      ) : null}

      {caps.maxOutputTokens ? (
        <div className="flex items-center justify-between gap-3">
          <Label className="text-muted-foreground text-xs font-normal">
            Max output tokens
            <span className="text-muted-foreground/70 tabular-nums">
              {' '}
              — up to {caps.maxOutputTokens.ceiling.toLocaleString()}
            </span>
          </Label>
          <Input
            type="number"
            min={1}
            max={caps.maxOutputTokens.ceiling}
            value={config.maxOutputTokens ?? ''}
            placeholder="default"
            variant="popover"
            className="h-8 w-28 text-xs"
            disabled={disabled}
            onChange={(e) => {
              const ceiling = caps.maxOutputTokens?.ceiling;
              const raw = e.target.value;
              if (!raw || ceiling === undefined) return set('maxOutputTokens', undefined);
              const parsed = Math.max(1, Math.min(ceiling, Number(raw)));
              set('maxOutputTokens', Number.isFinite(parsed) ? parsed : undefined);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
