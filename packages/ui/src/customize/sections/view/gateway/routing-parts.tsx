'use client';

/**
 * The controls the Routing tab is built from: the provider-logo model chip,
 * the searchable model picker (single or ordered multi-select), the error
 * condition select and the floating save bar. `gateway-routing.tsx` owns the
 * draft; `routing-sentence-layout.tsx` renders it as sentences.
 */

import { CaretDownIcon, CheckIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useTranslations } from '../../../../i18n';
import { Button } from '../../../../primitives/button';
import { ButtonGroup } from '../../../../primitives/button-group';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../../primitives/command';
import { CountBadge } from '../../../../primitives/count-badge';
import Hint from '../../../../primitives/hint';
import Loading from '../../../../primitives/loading';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../primitives/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../primitives/select';
import { cn } from '../../../../internal/lib/utils';
import { ProviderLogo } from '../../../../internal/lib/provider-branding';
import { pickerGroupId } from '../../../../session/models/model-grouping';
import { pickerModelName } from '../../../../session/models/model-tags';
import type {
  GatewayFallbackChain,
  GatewayProjectRoutingPolicy,
  GatewayRoutingRule,
} from '@kortix/sdk';
import { modelKeyToWire, useProjectModels } from '@kortix/sdk/react';

export const MAX_FALLBACKS = 8;
export const MAX_RULES = 20;

export type FallbackMode = 'inherit' | 'custom' | 'disabled';

export type RoutingModel = ReturnType<typeof useProjectModels>[number];

/**
 * Everything the Routing layout reads and writes. The state lives in
 * `GatewayRouting`; the layout is a pure view over it.
 */
export interface RoutingLayoutProps {
  draft: GatewayProjectRoutingPolicy;
  setDraft: (draft: GatewayProjectRoutingPolicy) => void;
  setRule: (index: number, rule: GatewayRoutingRule) => void;
  removeRule: (index: number) => void;
  /** Adds a rule for the first runnable model without one. `null` when none is left or the cap is hit. */
  addRule: (() => string) | null;
  fallbackMode: FallbackMode;
  changeFallbackMode: (mode: FallbackMode) => void;
  /** Every model the draft can name, including ones that are no longer runnable. */
  models: RoutingModel[];
  /** The models a person may pick: offered by the project and runnable for the caller. */
  selectableModels: RoutingModel[];
  availability: Record<string, boolean>;
  primaryModel: string;
  /** The platform route this project inherits: primary first. */
  inheritedRoute: string[];
  /** The condition the inherited route switches on. */
  inheritedFallbackOn: GatewayFallbackChain['fallbackOn'];
  effectiveVisionModel: string | null;
  /** Generation controls for the primary model, rendered by the host. */
  generationControls: ReactNode;
  controlsDisabled: boolean;
  writable: boolean;
}

/**
 * A model the project can choose: the project offers it (`enabled`) and its
 * provider is connected for the caller (`available`). Undefined means the
 * catalog does not say, which counts as yes.
 */
export function isSelectableModel(model: RoutingModel): boolean {
  return model.enabled !== false && model.available !== false;
}

export function findModel(models: RoutingModel[], wire: string | null): RoutingModel | undefined {
  if (!wire) return undefined;
  return models.find((model) => modelKeyToWire(model) === wire);
}

/** A model's display name for a wire id, falling back to the id. */
export function modelLabel(models: RoutingModel[], wire: string | null): string {
  if (!wire) return '';
  const match = findModel(models, wire);
  return match ? pickerModelName(match) : wire;
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

function ModelMark({ model }: { model: RoutingModel | undefined }) {
  if (!model) return null;
  return (
    <ProviderLogo
      providerID={pickerGroupId(model)}
      name={model.providerName}
      size="xs"
      className="size-4 rounded-none bg-transparent"
    />
  );
}

/** The orange dot a model gets when its provider is not connected. */
function UnavailableDot({ label }: { label: string }) {
  return (
    <Hint label={label}>
      <span
        role="img"
        aria-label={label}
        className="bg-kortix-orange size-1.5 shrink-0 rounded-full"
      />
    </Hint>
  );
}

/**
 * A model in a sentence: provider logo and name, read-only or removable.
 * The same pill shape the pickers use, so a chain reads as one row of things.
 */
export function ModelChip({
  wire,
  models,
  unavailable,
  onRemove,
}: {
  wire: string;
  models: RoutingModel[];
  unavailable?: boolean;
  onRemove?: () => void;
}) {
  const t = useTranslations('gatewayRouting');
  const label = modelLabel(models, wire);
  return (
    <span
      className={cn(
        'bg-secondary text-secondary-foreground inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-lg pl-2.5 text-sm',
        onRemove ? 'pr-1' : 'pr-3',
      )}
    >
      <ModelMark model={findModel(models, wire)} />
      <span className="min-w-0 truncate font-medium">{label}</span>
      {unavailable ? <UnavailableDot label={t('notConnected')} /> : null}
      {onRemove ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t('removeModel', { model: label })}
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Searchable model list in a popover. `multiple` keeps the popover open and
 * numbers the picked models in pick order, so a whole backup chain is built
 * in one visit; single mode closes on pick. `leading` is an extra first row
 * (for example "Auto").
 */
export function ModelPicker({
  models,
  selected,
  onToggle,
  multiple = false,
  exclude = [],
  trigger,
  leading,
  disabled,
}: {
  models: RoutingModel[];
  /** Picked wire ids, in order. */
  selected: string[];
  onToggle: (wire: string) => void;
  multiple?: boolean;
  exclude?: string[];
  trigger: ReactNode;
  leading?: { label: string; active: boolean; onSelect: () => void };
  disabled?: boolean;
}) {
  const t = useTranslations('gatewayRouting');
  const [open, setOpen] = useState(false);
  const excluded = new Set(exclude);
  const options = models.filter((model) => !excluded.has(modelKeyToWire(model)));

  return (
    <Popover open={disabled ? false : open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(320px,calc(100vw-1.5rem))] p-0">
        <Command>
          <CommandInput compact placeholder={t('searchModels')} />
          <CommandList className="max-h-80 p-1">
            <CommandEmpty>{t('noModels')}</CommandEmpty>
            {leading ? (
              <CommandItem
                value={`__leading ${leading.label}`}
                onSelect={() => {
                  leading.onSelect();
                  setOpen(false);
                }}
              >
                <span className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{leading.label}</span>
                {leading.active ? <CheckIcon className="size-4 shrink-0" /> : null}
              </CommandItem>
            ) : null}
            {options.map((model) => {
              const wire = modelKeyToWire(model);
              const order = selected.indexOf(wire);
              return (
                <CommandItem
                  key={wire}
                  value={`${pickerModelName(model)} ${model.providerName} ${wire}`}
                  onSelect={() => {
                    onToggle(wire);
                    if (!multiple) setOpen(false);
                  }}
                >
                  <ModelMark model={model} />
                  <span className="min-w-0 flex-1 truncate">{pickerModelName(model)}</span>
                  {order < 0 ? null : multiple ? (
                    <CountBadge count={order + 1} />
                  ) : (
                    <CheckIcon className="size-4 shrink-0" />
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** A picker trigger that shows the chosen model as a chip with a caret. */
export function ModelPickerButton({
  wire,
  models,
  placeholder,
  unavailable,
  className,
  ...props
}: {
  wire: string | null;
  models: RoutingModel[];
  placeholder: string;
  unavailable?: boolean;
} & ComponentProps<typeof Button>) {
  const t = useTranslations('gatewayRouting');
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={cn('max-w-full min-w-0 gap-2', className)}
      {...props}
    >
      {wire ? <ModelMark model={findModel(models, wire)} /> : null}
      <span className="min-w-0 truncate">{wire ? modelLabel(models, wire) : placeholder}</span>
      {unavailable ? <UnavailableDot label={t('notConnected')} /> : null}
      <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
    </Button>
  );
}

/** The dashed "+" that opens the multi-select backup picker. */
export function AddModelButton({
  label,
  className,
  ...props
}: { label: string } & ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'border-border text-muted-foreground hover:text-foreground border border-dashed',
        className,
      )}
      {...props}
    >
      <PlusIcon className="size-3.5" />
      {label}
    </Button>
  );
}

export function ConditionSelect({
  value,
  onChange,
  disabled,
}: {
  value: GatewayFallbackChain['fallbackOn'];
  onChange: (value: GatewayFallbackChain['fallbackOn']) => void;
  disabled?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as GatewayFallbackChain['fallbackOn'])}
      disabled={disabled}
    >
      <SelectTrigger
        className="w-auto"
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

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * The left edge and width of the nearest scrolling ancestor, kept current on
 * resize. The save bar is `fixed` to the window bottom; this keeps it centred
 * over the content column instead of the whole window (the sidebar).
 */
function useScrollColumnFrame(anchor: RefObject<HTMLElement | null>) {
  const [frame, setFrame] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    let column = anchor.current?.parentElement ?? null;
    while (column && !/(auto|scroll)/.test(getComputedStyle(column).overflowY)) {
      column = column.parentElement;
    }
    const target = column ?? document.documentElement;
    const update = () => {
      const rect = target.getBoundingClientRect();
      setFrame({ left: rect.left, width: rect.width });
    };
    // A ResizeObserver reports once on observe, so this also sets the first frame.
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [anchor]);
  return frame;
}

export function RoutingSaveBar({
  message,
  saving,
  canSave,
  onDiscard,
  onSave,
}: {
  message: string;
  saving: boolean;
  canSave: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useTranslations('gatewayRouting');
  const reduceMotion = useReducedMotion();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const frame = useScrollColumnFrame(anchorRef);
  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      <div
        style={frame ? { left: frame.left, width: frame.width } : { visibility: 'hidden' }}
        className="pointer-events-none fixed bottom-4 z-30 flex justify-center px-4"
      >
        <m.div
          initial={{
            opacity: 0,
            transform: reduceMotion ? 'translateY(0px)' : 'translateY(8px)',
          }}
          animate={{
            opacity: 1,
            transform: 'translateY(0px)',
            transition: { duration: 0.18, ease: EASE_OUT },
          }}
          className="bg-popover text-popover-foreground border-border pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-md"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
            {message}
          </span>
          <ButtonGroup className="shrink-0">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-8"
              disabled={saving}
              onClick={onDiscard}
            >
              {t('discard')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={!canSave || saving}
              onClick={onSave}
            >
              {saving ? <Loading className="size-4 shrink-0" /> : null}
              {t('save')}
            </Button>
          </ButtonGroup>
        </m.div>
      </div>
    </>
  );
}
