'use client';

/**
 * The pieces every Routing layout shares: the row, the model picker, the
 * availability badge, the condition select, the editable chain and the help
 * mark. `gateway-routing.tsx` owns the draft state; the layouts
 * (`routing-sentence-layout.tsx`, `routing-split-layout.tsx`, and the current
 * section layout in `gateway-routing.tsx`) only render it through
 * `RoutingLayoutProps`. Kept in its own module so a layout file never imports
 * `gateway-routing.tsx` back (`module-cycles.test.ts`).
 */

import {
  WarningIcon as AlertTriangle,
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  InfoIcon,
  PlusIcon as Plus,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations } from '../../../../i18n';
import { Badge } from '../../../../primitives/badge';
import { Button } from '../../../../primitives/button';
import Hint from '../../../../primitives/hint';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../primitives/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../primitives/select';
import { ModelSelector } from '../../../../session/models/model-selector';
import { cn } from '../../../../internal/lib/utils';
import type {
  GatewayFallbackChain,
  GatewayProjectRoutingPolicy,
  GatewayRoutingRule,
} from '@kortix/sdk';
import { modelKeyToWire, useProjectModels, wireToModelKey } from '@kortix/sdk/react';

export const MAX_FALLBACKS = 8;
export const MAX_RULES = 20;

export type FallbackMode = 'inherit' | 'custom' | 'disabled';

export type RoutingModel = ReturnType<typeof useProjectModels>[number];

/**
 * Everything a Routing layout reads and writes. The state lives in
 * `GatewayRouting`; a layout is a pure view over it, so switching layouts
 * keeps an unsaved draft and the save bar works the same for each.
 */
export interface RoutingLayoutProps {
  draft: GatewayProjectRoutingPolicy;
  setDraft: (draft: GatewayProjectRoutingPolicy) => void;
  setRule: (index: number, rule: GatewayRoutingRule) => void;
  removeRule: (index: number) => void;
  /**
   * Adds a rule for the first model without one and returns its wire id.
   * `null` when no model is left or the cap is hit.
   */
  addRule: (() => string) | null;
  fallbackMode: FallbackMode;
  changeFallbackMode: (mode: FallbackMode) => void;
  models: RoutingModel[];
  availability: Record<string, boolean>;
  primaryModel: string;
  /** The platform route this project inherits: primary first. */
  inheritedRoute: string[];
  effectiveVisionModel: string | null;
  /** Generation controls for the primary model, rendered by the host. */
  generationControls: ReactNode;
  controlsDisabled: boolean;
  writable: boolean;
}

/** A model's display name for a wire id, falling back to the id. */
export function modelLabel(models: RoutingModel[], wire: string | null): string {
  if (!wire) return '';
  const match = models.find((model) => modelKeyToWire(model) === wire);
  return match?.modelName ?? wire;
}

/**
 * One decision, one line: what it is on the left, the control on the right.
 *
 * Column width, row padding, and gaps match `ProviderRow` in
 * `packages/ui/src/customize/providers/provider-connect.tsx` exactly (`13rem` label column,
 * `py-1.5` row, `gap-4` between columns).
 */
export function RoutingRow({
  label,
  hint,
  children,
  align = 'center',
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  /** `start` when the right column is a stack (a chain) rather than one control. */
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cn(
        'grid gap-1.5 py-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:gap-4',
        align === 'start' ? 'sm:items-start' : 'sm:items-center',
      )}
    >
      <div className="min-w-0">
        <div className="text-foreground text-sm">{label}</div>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function RoutingModelSelector({
  value,
  models,
  onChange,
  disabled,
  unsetLabel = 'Choose model',
  exclude = [],
  triggerVariant,
}: {
  value: string | null;
  models: RoutingModel[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
  unsetLabel?: string;
  exclude?: string[];
  /** `secondary` draws a filled chip, for a model inside a sentence. */
  triggerVariant?: 'ghost' | 'secondary';
}) {
  const excluded = new Set(exclude);
  const options = models.filter((model) => {
    const wire = modelKeyToWire(model);
    return !excluded.has(wire) || wire === value;
  });
  if (value && !options.some((model) => modelKeyToWire(model) === value)) {
    options.push({
      providerID: 'kortix',
      providerName: 'Kortix',
      modelID: value,
      modelName: value,
    });
  }
  return (
    <ModelSelector
      models={options}
      selectedModel={value ? wireToModelKey(value) : null}
      unsetLabel={unsetLabel}
      disabled={disabled}
      triggerVariant={triggerVariant}
      triggerLabelClassName={triggerVariant === 'secondary' ? 'max-w-48' : undefined}
      onSelect={(model) => onChange(model ? modelKeyToWire(model) : null)}
    />
  );
}

/** Warns inline when the routing-policy preview reports a model's provider isn't connected. */
export function AvailabilityBadge({ available }: { available: boolean | undefined }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (available !== false) return null;
  return (
    <Hint label={tI18nComplete.raw('text7031306d3dd8')}>
      <Badge variant="warning" size="xs" className="shrink-0 gap-1">
        <AlertTriangle className="size-3" />
        {tI18nComplete.raw('text0303e1824670')}
      </Badge>
    </Hint>
  );
}

/**
 * The help mark: one accent-coloured glyph that replaces a description line.
 * It opens a popover on click or tap, so the explanation is reachable on touch
 * screens and by keyboard; the screen itself carries labels only.
 */
export function HelpMark({ label }: { label: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          className="text-kortix-blue shrink-0 rounded-full"
        >
          <InfoIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-3 text-xs text-pretty">
        {label}
      </PopoverContent>
    </Popover>
  );
}

export function ConditionSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: GatewayFallbackChain['fallbackOn'];
  onChange: (value: GatewayFallbackChain['fallbackOn']) => void;
  disabled?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as GatewayFallbackChain['fallbackOn'])}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn('w-40', className)}
        size="sm"
        aria-label={tI18nComplete.raw('text5970362b52d5')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="transient" description={tI18nComplete.raw('text4b8a51b32252')}>
          {tI18nComplete.raw('text91721aa63069')}
        </SelectItem>
        <SelectItem value="any-error" description={tI18nComplete.raw('textc1e4a1169ac8')}>
          {tI18nComplete.raw('text6e2097e246af')}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * One fallback chain as plain lines — a numbered step per model, an add line,
 * and the condition the chain triggers on.
 */
export function ChainRows({
  primary,
  chain,
  models,
  onChange,
  disabled,
  availability,
  addLabel,
  conditionLabel,
}: {
  primary: string | null;
  chain: GatewayFallbackChain;
  models: RoutingModel[];
  onChange: (chain: GatewayFallbackChain) => void;
  disabled?: boolean;
  availability?: Record<string, boolean>;
  /** Overrides the "Add a fallback" placeholder, for a layout with its own wording. */
  addLabel?: string;
  /** Overrides the "Retry on" label. */
  conditionLabel?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const taken = [primary ?? '', ...chain.models];
  const takenSet = new Set(taken);
  const canAdd = models.some((model) => !takenSet.has(modelKeyToWire(model)));

  return (
    <div className="flex flex-col gap-0.5">
      {chain.models.map((model, index) => (
        <div key={model} className="flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <RoutingModelSelector
              value={model}
              models={models}
              exclude={[
                primary ?? '',
                ...chain.models.filter((_, itemIndex) => itemIndex !== index),
              ]}
              onChange={(next) => {
                if (!next) return;
                const updated = [...chain.models];
                updated[index] = next;
                onChange({ ...chain, models: updated });
              }}
              disabled={disabled}
            />
          </div>
          <AvailabilityBadge available={availability?.[model]} />
          {/* Rendered even while `disabled` (a save in flight), not hidden —
              a control that disappears for the length of a mutation makes the
              row jump twice per save. */}
          <Hint label={tI18nComplete.raw('textc66feb5eb8f2')}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={tI18nComplete.raw('textdfea74d6d58d')}
              disabled={disabled || index === 0}
              onClick={() =>
                onChange({
                  ...chain,
                  models: moveFallback(chain.models, index, -1),
                })
              }
            >
              <ArrowUp className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={tI18nComplete.raw('text40bb50da160c')}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={tI18nComplete.raw('text54e22a5335af')}
              disabled={disabled || index === chain.models.length - 1}
              onClick={() =>
                onChange({
                  ...chain,
                  models: moveFallback(chain.models, index, 1),
                })
              }
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={tI18nComplete.raw('textc3812fc4acb8')}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={tI18nComplete.raw('textb4e437b00de3')}
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...chain,
                  models: chain.models.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </Hint>
        </div>
      ))}

      {!disabled ? (
        <div className="flex min-w-0 items-center gap-1">
          <Plus className="text-muted-foreground ml-0.5 size-3 shrink-0" />
          <RoutingModelSelector
            value={null}
            models={models}
            exclude={taken}
            unsetLabel={
              canAdd
                ? (addLabel ?? tI18nComplete.raw('text5b660045c015'))
                : tI18nComplete.raw('text82e4b64f1673')
            }
            disabled={!canAdd || chain.models.length >= MAX_FALLBACKS}
            onChange={(next) => next && onChange({ ...chain, models: [...chain.models, next] })}
          />
        </div>
      ) : null}

      {chain.models.length === 0 && disabled ? (
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text545403adb9e5')}</p>
      ) : null}

      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-xs">
          {conditionLabel ?? tI18nComplete.raw('textbb68ff20e011')}
        </span>
        <ConditionSelect
          value={chain.fallbackOn}
          onChange={(fallbackOn) => onChange({ ...chain, fallbackOn })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export function moveFallback(models: string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= models.length || target < 0 || target >= models.length) {
    return models;
  }
  const next = [...models];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
