/**
 * Per-model generation controls (reasoning effort, temperature, top_p, max
 * output tokens) for the Gateway → Routing "Generation defaults" panel.
 *
 * *** CAPABILITY DATA SOURCE ***
 * Every control is gated on the model's record from the project's
 * `/model-picker` response (`GatewayCatalogModel`: `reasoning_options`,
 * `temperature`, `limit.output`) via `@kortix/llm-catalog`'s
 * `generationControlCapabilities` — the exact function the gateway's own
 * request clamp runs, so the panel offers precisely what a request may carry.
 * The record comes from the API's hourly-refreshed live catalog, with managed
 * ids already resolved through their pricingRef server-side. There is no
 * web-side catalog lookup here any more: the baked seed it used to read was
 * hand-regenerated and sat 38 days stale (#6879), hiding controls for every
 * model newer than it.
 */

import { WarningIcon as AlertTriangle } from '@phosphor-icons/react';
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
import { generationControlCapabilities } from '@kortix/llm-catalog';
import type { GatewayCatalogModel, GatewayModelGenerationConfig } from '@kortix/sdk';


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
  catalogModel,
  value,
  onChange,
  disabled,
}: {
  model: string;
  /**
   * The model's record from the project's `/model-picker` response — the
   * API's live catalog (managed ids already resolved through their
   * pricingRef server-side). This is the ONLY capability source: the web's
   * baked catalog seed was hand-regenerated and sat 38 days stale, hiding
   * every control for models newer than it (#6879). Absent → no controls.
   */
  catalogModel: GatewayCatalogModel | undefined;
  value: GatewayModelGenerationConfig | undefined;
  onChange: (next: GatewayModelGenerationConfig) => void;
  disabled?: boolean;
}) {
  // `GatewayCatalogModel` is keyed by wire id and carries no `id` field of its
  // own; `CatalogModel` wants one — stamp the wire id on.
  const caps = useMemo(
    () => generationControlCapabilities(catalogModel ? { id: model, ...catalogModel } : undefined),
    [catalogModel, model],
  );
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
            thumbLabel="Temperature"
            formatValue={(next) => next.toFixed(2)}
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
            thumbLabel="Top-p"
            formatValue={(next) => next.toFixed(2)}
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
