'use client';

/**
 * Thinking-effort control for the session chat composer — the ONE effort knob,
 * in both runtime modes.
 *
 * It sets the session's model **variant** (`local.model.variant`, sent as
 * `variant` on every prompt), never a project setting:
 *
 *  - Native (llm_gateway off): OpenCode derives the variants from models.dev's
 *    `reasoning_options` and applies the provider-specific request overlay
 *    itself (`reasoningEffort`, `reasoningConfig.maxReasoningEffort`, …).
 *  - Gateway (llm_gateway on): the sandbox publishes the same variant ids on
 *    the `kortix` provider and OpenCode sends `reasoning_effort` in the body;
 *    the gateway forwards it per upstream family and REFUSES it (400) for a
 *    family it cannot map, instead of stripping it.
 *
 * The list is `Object.keys(model.variants)` from the picker source the
 * composer already holds — the runtime's own list once the sandbox is up, the
 * ids derived from the API's live `reasoning_options` before that (see
 * `nativeProviderListFromCatalog` / `projectLlmCatalogToProviderList` in the
 * SDK). Never a hardcoded ladder, never the web's baked catalog seed.
 *
 * "Auto" clears the variant: the model's own default applies, and on-gateway
 * the project's Generation defaults (Customize → Gateway → Routing) fill the
 * field the request left unset.
 *
 * History: this used to write the project-level routing policy
 * (`model_generation_config`) from the composer, was hidden off-gateway
 * (#6872), and read its values from a hand-regenerated catalog seed that sat
 * 38 days stale (#6879). Two knobs by mode, three catalog copies. Now one.
 */

import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  CaretDownIcon,
  CellSignalFullIcon,
  CellSignalHighIcon,
  CellSignalLowIcon,
  CellSignalMediumIcon,
  CellSignalNoneIcon,
  GaugeIcon,
} from '@phosphor-icons/react';

/**
 * The value `onVariantChange(null)` means: no variant, let the model decide.
 * A sentinel is needed because Radix's radio group addresses items by string
 * and cannot carry `null`.
 */
const AUTO = '__auto__';

/**
 * Show/hide + the choices, as a pure function so the rule is testable without
 * React: the control renders only when the selected model publishes at least
 * one variant AND the composer can apply one. Order and ids are the model's
 * own; duplicates (a runtime + catalog merge slip) collapse to one entry.
 */
export function reasoningEffortChoices(
  variants: readonly string[] | undefined,
  canApply: boolean,
): string[] {
  if (!canApply || !variants?.length) return [];
  return Array.from(new Set(variants.filter((v) => typeof v === 'string' && v.length > 0)));
}

/** `medium` → `Medium`. The catalog ships lowercase ids; the trigger and the
 *  menu should not. */
function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Cell-signal bars for effort — none → full ladder. Extra ladder steps
 * (`xhigh`, `max`) share Full; unknown ids fall back to Medium so a future
 * catalog value never renders without an icon.
 *
 * `null` (model decides, no variant) gets a Gauge icon instead of a
 * cell-signal step — it isn't a fixed point on the none→full ladder, it's the
 * dial that finds its own reading per turn.
 *
 * A switch that returns JSX (not a component reference) — assigning
 * `const Icon = map[value]` and then `<Icon />` trips the React Compiler's
 * "Cannot create components during render" rule.
 */
function EffortIcon({ value, className }: { value: string | null; className?: string }) {
  switch (value) {
    case null:
    case 'auto':
      return <GaugeIcon className={className} />;
    case 'none':
      return <CellSignalNoneIcon className={className} weight="fill" />;
    case 'minimal':
    case 'low':
      return <CellSignalLowIcon className={className} weight="fill" />;
    case 'medium':
      return <CellSignalMediumIcon className={className} weight="fill" />;
    case 'high':
      return <CellSignalHighIcon className={className} weight="fill" />;
    case 'xhigh':
    case 'max':
    case 'full':
      return <CellSignalFullIcon className={className} weight="fill" />;
    default:
      return <CellSignalMediumIcon className={className} weight="fill" />;
  }
}

export interface ReasoningEffortSelectorProps {
  /** The selected model's variant ids (`Object.keys(model.variants)`). */
  variants: readonly string[] | undefined;
  /** The session's current variant, or null = model default. */
  selectedVariant: string | null | undefined;
  /** Applies a variant to the session; absent = the composer cannot apply one
   *  (no runtime model store), which hides the control entirely. */
  onVariantChange?: (variant: string | null) => void;
  /**
   * Controlled open state — omit and the trigger owns it. Supplied by
   * `composer.tsx` so the `/` palette's "Set reasoning effort" row can open
   * this directly. Same controlled/uncontrolled rule as `ModelSelector`.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Thinking effort as its own composer-toolbar control, a peer of the model
 * pill, stating its value at rest. Renders NOTHING when the model publishes no
 * variants or the composer cannot apply one — a model without a knob never
 * grows dead chrome.
 *
 * A `DropdownMenu` rather than the `CommandPopover` the model and agent
 * pickers use: this is a fixed list of a handful of values with no search, no
 * grouping and no empty state, and `DropdownMenuRadioGroup` gives the
 * single-select semantics — roving focus, typeahead, `aria-checked` — for
 * free, where the command palette would need them re-implemented.
 */
export function ReasoningEffortSelector({
  variants,
  selectedVariant,
  onVariantChange,
  open: openProp,
  onOpenChange,
}: ReasoningEffortSelectorProps) {
  const choices = reasoningEffortChoices(variants, !!onVariantChange);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const onValueChange = useCallback(
    (next: string) => onVariantChange?.(next === AUTO ? null : next),
    [onVariantChange],
  );

  if (choices.length === 0) return null;

  // A stale per-model pick (a variant the current list no longer carries)
  // reads as Auto rather than an unlabeled value; the next explicit choice
  // replaces it.
  const current = selectedVariant && choices.includes(selectedVariant) ? selectedVariant : null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Thinking effort"
          className="text-foreground/70 gap-1.5 rounded-lg"
        >
          <EffortIcon value={current} className="size-4 shrink-0" />
          <span className="max-w-[7rem] truncate">{current ? label(current) : 'Auto'}</span>
          <CaretDownIcon
            className={cn(
              'size-3 opacity-50 transition-transform duration-200 ease-out',
              open && 'rotate-180',
            )}
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="min-w-[10rem]">
        <DropdownMenuRadioGroup value={current ?? AUTO} onValueChange={onValueChange}>
          {/* Auto is first and always present: it is the only way BACK to the
              model's own default once a variant is set, and without it the
              control would be a one-way door. */}
          <DropdownMenuRadioItem value={AUTO}>
            <span className="flex items-center gap-2">
              <EffortIcon value={null} className="size-4 shrink-0" />
              Auto
            </span>
          </DropdownMenuRadioItem>
          {choices.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <span className="flex items-center gap-2">
                <EffortIcon value={value} className="size-4 shrink-0" />
                {label(value)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
