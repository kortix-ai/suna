'use client';

/**
 * Routing — where a request goes when the project default can't take it.
 *
 * **One axis, flat rows.** Every control on this screen sits in the same
 * right-hand column, one row per decision: label and explanation on the left,
 * the control on the right. Same shape, same column width, same row padding
 * as `ProviderRow` in `features/providers/provider-connect.tsx` ("click,
 * paste, done") — a settings screen is scanned by running the eye straight
 * down the controls, and it can only be scanned that way if the controls
 * share one x-position and one rhythm, not just a similar-looking layout.
 *
 * **What this replaced.** Four `bg-popover` panels of equal visual weight,
 * one of them a `Disclosure` hiding a stack of per-model rule blocks, each of
 * which held ANOTHER bordered panel (`ChainEditor`) whose fallback steps were
 * themselves bordered `<li>` cards. Five levels of box for "try B if A
 * fails", with the mode select at one x-position, the condition select at
 * another, the model pickers at a third — and the feature the product owner
 * called out as "the core thing want here" (per-model overrides) was the LAST
 * of the four panels, behind a click that gave no hint of what was under it.
 *
 * **Two tiers, not four equal boxes.** The product feedback on the old
 * layout was specific: it "looks horrendous", overrides are the core feature
 * and should not read as a footnote, and it needs to be as simple as
 * possible. So the four sections split into two tiers instead of one flat
 * stack:
 *
 *   1. **Primary — always visible.** *Fallback* (what handles this project's
 *      requests) and *Per-model overrides* (the exceptions to it) sit at the
 *      top, in that order, right after each other. Overrides also gets a
 *      full-strength `text-foreground` heading (the other three stay
 *      `Label`'s default muted weight) and its "Add override" button lives in
 *      the section header rather than at the bottom of a list — together that
 *      is the visual weight the product owner asked for, without a box.
 *   2. **Advanced — collapsed by default.** *Vision model* (a narrow,
 *      image-input-only override) and *Generation defaults* (four raw
 *      parameter knobs: reasoning effort, temperature, top-p, max tokens) are
 *      fine-tuning, not the decision someone opens this tab to make. Both
 *      move under one "Advanced" `Disclosure` below the primary content. It
 *      opens by default (`hasAdvancedRoutingConfig`) whenever the project
 *      already sets a vision override or a generation parameter, so an
 *      existing non-default config is never hidden from the person who set it.
 *
 * Nothing was cut. Every capability the panels held is still here:
 *
 * | Capability | Where it is now |
 * | --- | --- |
 * | Inherit / custom / no fallback | "When the default fails" row (primary) |
 * | Ordered default chain, reorder + remove, max 8 | Chain row — one line per step (primary) |
 * | Fallback condition (transient / any error) | "Retry on" line, inside the chain it belongs to |
 * | Per-model override rules, max 20 | "Per-model overrides" — one row per rule, promoted second (primary) |
 * | Vision (image-input) override | "Vision model" row, inside Advanced |
 * | Per-model generation defaults | "Generation defaults" section, inside Advanced |
 * | Provider-availability preview | `AvailabilityBadge`, unchanged, now also on the primary |
 * | Reset / dirty / validation / save | Header action + sticky footer, unchanged |
 *
 * The data contract is untouched: same props in, same `routing.set` /
 * `routing.reset` / `routing.preview` calls out, same exported helpers (which
 * `gateway-routing.test.ts` pins).
 */

import {
  WarningIcon as AlertTriangle,
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  CaretDownIcon,
  PlusIcon as Plus,
  ArrowCounterClockwiseIcon as RotateCcw,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ModelSelector } from '@/features/session/model-selector';
import { useModelDefaults } from '@kortix/sdk/react';
import { modelKeyToWire, wireToModelKey } from '@kortix/sdk/react';
import type {
  GatewayFallbackChain,
  GatewayProjectRoutingPolicy,
  GatewayRoutingRule,
} from '@kortix/sdk';
import { qk, useGatewayRoutingPolicy, useProjectModels } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';

import { GenerationControlsPanel } from './generation-controls';

const MAX_FALLBACKS = 8;
const MAX_RULES = 20;

export type FallbackMode = 'inherit' | 'custom' | 'disabled';

type ValidationDraft = Pick<
  GatewayProjectRoutingPolicy,
  'defaultModel' | 'defaultFallback' | 'rules'
>;

type RoutingModel = ReturnType<typeof useProjectModels>[number];

export function fallbackModeForPolicy(
  fallback: GatewayProjectRoutingPolicy['defaultFallback'],
): FallbackMode {
  if (fallback === null) return 'inherit';
  return fallback.models.length === 0 ? 'disabled' : 'custom';
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

export function validateRoutingDraft(
  draft: ValidationDraft,
  fallbackMode: FallbackMode = fallbackModeForPolicy(draft.defaultFallback),
): string | null {
  const validateChain = (primary: string | null, models: string[]) => {
    if (models.length > MAX_FALLBACKS)
      return `A fallback chain can contain at most ${MAX_FALLBACKS} models.`;
    if (new Set(models).size !== models.length) return 'Each fallback model can only appear once.';
    if (primary && models.includes(primary))
      return 'A fallback chain cannot include the primary model.';
    return null;
  };
  if (
    fallbackMode === 'custom' &&
    (!draft.defaultFallback || draft.defaultFallback.models.length === 0)
  ) {
    return 'A custom fallback chain needs at least one model.';
  }
  if (draft.defaultFallback) {
    const issue = validateChain(draft.defaultModel, draft.defaultFallback.models);
    if (issue) return issue;
  }
  if (draft.rules.length > MAX_RULES)
    return `A project can contain at most ${MAX_RULES} overrides.`;
  const primaries = new Set<string>();
  for (const rule of draft.rules) {
    if (!rule.model) return 'Every override needs a primary model.';
    if (primaries.has(rule.model)) return 'Each primary model can only have one override.';
    primaries.add(rule.model);
    const issue = validateChain(rule.model, rule.fallbackModels);
    if (issue) return issue;
  }
  return null;
}

/**
 * The deduped, order-stable set of model wire ids the routing draft
 * references: the resolved primary, the vision override, the default
 * fallback chain, and every per-model rule's primary + fallback chain.
 * Feeds the debounced routing-policy/preview availability check so a user
 * can't unknowingly save a chain that routes to a disconnected provider.
 */
export function collectPreviewTargets(
  policy: Pick<GatewayProjectRoutingPolicy, 'visionModel' | 'defaultFallback' | 'rules'>,
  primaryModel: string | null,
): string[] {
  const targets = new Set<string>();
  const track = (model: string | null | undefined) => {
    if (model && model !== 'auto') targets.add(model);
  };
  track(primaryModel);
  track(policy.visionModel);
  if (policy.defaultFallback) policy.defaultFallback.models.forEach(track);
  for (const rule of policy.rules) {
    track(rule.model);
    rule.fallbackModels.forEach(track);
  }
  return [...targets];
}

function clonePolicy(policy: GatewayProjectRoutingPolicy): GatewayProjectRoutingPolicy {
  return {
    ...policy,
    defaultFallback: policy.defaultFallback
      ? { ...policy.defaultFallback, models: [...policy.defaultFallback.models] }
      : null,
    rules: policy.rules.map((rule) => ({ ...rule, fallbackModels: [...rule.fallbackModels] })),
    modelGenerationConfig: { ...(policy.modelGenerationConfig ?? {}) },
  };
}

export function editablePolicySignature(policy: GatewayProjectRoutingPolicy): string {
  // The shared header owns defaultModel. A successful header change refetches
  // this document, but must not replace unsaved fallback (or vision) edits
  // made on this screen.
  return JSON.stringify({
    visionModel: policy.visionModel,
    defaultFallback: policy.defaultFallback,
    rules: policy.rules,
    modelGenerationConfig: policy.modelGenerationConfig ?? {},
  });
}

/**
 * Whether the "Advanced" disclosure (vision override + per-model generation
 * defaults) should start OPEN for this policy. Advanced is collapsed by
 * default — it holds fine-tuning, not the primary routing decision — but a
 * project that already sets a vision override or any generation parameter
 * must not have that config hidden behind an extra click the moment someone
 * opens the tab.
 */
export function hasAdvancedRoutingConfig(
  policy: Pick<GatewayProjectRoutingPolicy, 'visionModel' | 'modelGenerationConfig'>,
): boolean {
  if (policy.visionModel) return true;
  const config = policy.modelGenerationConfig;
  if (!config) return false;
  return Object.values(config).some((entry) => entry && Object.keys(entry).length > 0);
}

/**
 * One decision, one line: what it is on the left, the control on the right.
 *
 * The whole screen is a stack of these, so every control — mode select, model
 * picker, condition select, chain — starts at the same x. That is the entire
 * layout system here; there is no card, no panel and no nesting to hold, which
 * is what the four `bg-popover` boxes were doing.
 *
 * Column width, row padding, and gaps match `ProviderRow` in
 * `features/providers/provider-connect.tsx` exactly (`13rem` label column,
 * `py-1.5` row, `gap-4` between columns) — same list-row rhythm the rest of
 * Customize already uses, not a lookalike with its own spacing.
 */
function RoutingRow({
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

function RoutingModelSelector({
  value,
  models,
  onChange,
  disabled,
  unsetLabel = 'Choose model',
  exclude = [],
}: {
  value: string | null;
  models: RoutingModel[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
  unsetLabel?: string;
  exclude?: string[];
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
      onSelect={(model) => onChange(model ? modelKeyToWire(model) : null)}
    />
  );
}

/** Warns inline when the routing-policy preview reports a model's provider isn't connected. */
function AvailabilityBadge({ available }: { available: boolean | undefined }) {
  if (available !== false) return null;
  return (
    <Hint label="This model's provider isn't connected for this project — requests routed here fail over immediately">
      <Badge variant="warning" size="xs" className="shrink-0 gap-1">
        <AlertTriangle className="size-3" />
        Not connected
      </Badge>
    </Hint>
  );
}

function ConditionSelect({
  value,
  onChange,
  disabled,
}: {
  value: GatewayFallbackChain['fallbackOn'];
  onChange: (value: GatewayFallbackChain['fallbackOn']) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as GatewayFallbackChain['fallbackOn'])}
      disabled={disabled}
    >
      <SelectTrigger className="w-40" size="sm" aria-label="Fallback condition">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="transient" description="Rate limits, timeouts, and upstream failures">
          Service errors
        </SelectItem>
        <SelectItem value="any-error" description="Any model or provider error">
          Any error
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * One fallback chain as plain lines — a numbered step per model, an add line,
 * and the condition the chain triggers on.
 *
 * Every step used to be a bordered `<li>` inside a bordered panel inside
 * (for a rule) another bordered block. A step carries one model and three
 * controls; it does not need a box of its own to say so, and forty pixels of
 * border per step is what made eight of them unreadable.
 */
function ChainRows({
  primary,
  chain,
  models,
  onChange,
  disabled,
  availability,
}: {
  primary: string | null;
  chain: GatewayFallbackChain;
  models: RoutingModel[];
  onChange: (chain: GatewayFallbackChain) => void;
  disabled?: boolean;
  availability?: Record<string, boolean>;
}) {
  const taken = [primary ?? '', ...chain.models];
  const takenSet = new Set(taken);
  const canAdd = models.some((model) => !takenSet.has(modelKeyToWire(model)));

  return (
    <div className="flex flex-col gap-0.5">
      {chain.models.map((model, index) => (
        <div key={model} className="flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground/60 w-4 shrink-0 text-xs tabular-nums">
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
          <Hint label="Move up">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Move fallback up"
              disabled={disabled || index === 0}
              onClick={() => onChange({ ...chain, models: moveFallback(chain.models, index, -1) })}
            >
              <ArrowUp className="size-3.5" />
            </Button>
          </Hint>
          <Hint label="Move down">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Move fallback down"
              disabled={disabled || index === chain.models.length - 1}
              onClick={() => onChange({ ...chain, models: moveFallback(chain.models, index, 1) })}
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </Hint>
          <Hint label="Remove">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Remove fallback"
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
          <Plus className="text-muted-foreground/60 ml-0.5 size-3 shrink-0" />
          <RoutingModelSelector
            value={null}
            models={models}
            exclude={taken}
            unsetLabel={canAdd ? 'Add a fallback' : 'No models left'}
            disabled={!canAdd || chain.models.length >= MAX_FALLBACKS}
            onChange={(next) => next && onChange({ ...chain, models: [...chain.models, next] })}
          />
        </div>
      ) : null}

      {chain.models.length === 0 && disabled ? (
        <p className="text-muted-foreground text-xs">No fallback models.</p>
      ) : null}

      {/* The condition belongs to THIS chain, so it sits inside it rather than
          in a panel header two levels up. */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-xs">Retry on</span>
        <ConditionSelect
          value={chain.fallbackOn}
          onChange={(fallbackOn) => onChange({ ...chain, fallbackOn })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

/**
 * Routing's heading band — a SECTION heading, in the page's own column.
 *
 * This was `CustomizeSectionWrapper`, which is the settings PANEL's shell: it
 * brings `mx-auto max-w-2xl` and its own `overflow-y-auto`. Routing is not
 * panel content any more — it is one tab of `/projects/[id]/models`, whose
 * column is `CapabilityPageShell`'s `max-w-5xl` — so the wrapper drew this tab
 * 320px narrower than the six tabs beside it, off the column's left edge, and
 * opened a second scroller inside the page's one. The heading and the Reset
 * action are all that was wanted from it, and they are cheaper written out:
 * same `h3`/`p` pair `gateway-access-tab.tsx` uses, so the two tabs that carry
 * section headings carry the same one.
 */
function RoutingSection({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-foreground text-sm font-medium">Routing</h3>
          <p className="text-muted-foreground text-xs text-pretty">
            Where a request goes when the project default can&apos;t take it.
          </p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function GatewayRouting({
  projectId,
  canWrite,
  projectDefaultPending,
}: {
  projectId: string;
  canWrite: boolean;
  projectDefaultPending: boolean;
}) {
  const queryClient = useQueryClient();
  const routing = useGatewayRoutingPolicy(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const catalogModels = useProjectModels(projectId);
  const [draft, setDraft] = useState<GatewayProjectRoutingPolicy | null>(null);
  const [fallbackMode, setFallbackMode] = useState<FallbackMode>('inherit');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const hydratedPolicySignature = useRef<string | null>(null);
  const previewRequestId = useRef(0);

  useEffect(() => {
    if (!routing.data?.project) return;
    const signature = editablePolicySignature(routing.data.project);
    // Effective routing also changes when the header's project default changes.
    // Keep an in-progress fallback draft intact unless the persisted project
    // policy itself changed (save, reset, or an external editor update).
    if (hydratedPolicySignature.current === signature) return;
    hydratedPolicySignature.current = signature;
    setDraft(clonePolicy(routing.data.project));
    setFallbackMode(fallbackModeForPolicy(routing.data.project.defaultFallback));
    setAdvancedOpen((current) => current || hasAdvancedRoutingConfig(routing.data!.project));
  }, [routing.data]);

  // Debounced availability preview: whenever the draft's referenced models
  // change, ask the gateway which of them currently have a connected
  // provider so the chain editor can flag a dead fallback before save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: routing.preview's mutateAsync is a stable handle from useGatewayRoutingPolicy and shouldn't retrigger this debounce.
  useEffect(() => {
    if (!draft || !routing.data) {
      setAvailability({});
      return;
    }
    const projectDefaultWire = modelDefaults.projectDefault
      ? modelKeyToWire(modelDefaults.projectDefault)
      : null;
    const primary = projectDefaultWire ?? routing.data.effective.defaultModel;
    const targets = collectPreviewTargets(draft, primary);
    if (targets.length === 0) {
      setAvailability({});
      return;
    }
    const requestId = ++previewRequestId.current;
    const timer = setTimeout(() => {
      Promise.all(
        targets.map(async (model) => {
          try {
            const result = await routing.preview.mutateAsync({
              requestedModel: model,
              imageInput: false,
            });
            const match = result.models.find((entry) => entry.model === model);
            // Fail open: an unresolved lookup shouldn't paint an unrelated model as broken.
            return [model, match?.available ?? true] as const;
          } catch {
            // A preview request failure (network, auth) isn't evidence the
            // provider is disconnected — don't surface a false warning.
            return [model, true] as const;
          }
        }),
      ).then((entries) => {
        if (previewRequestId.current !== requestId) return; // superseded by a newer edit
        setAvailability(Object.fromEntries(entries));
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, routing.data, modelDefaults.projectDefault]);

  const models = useMemo(() => {
    const byWire = new Map<string, RoutingModel>();
    for (const model of catalogModels) {
      const wire = modelKeyToWire(model);
      if (wire !== 'auto') byWire.set(wire, model);
    }
    const current = draft
      ? [
          draft.defaultModel,
          ...(draft.defaultFallback?.models ?? []),
          ...draft.rules.flatMap((rule) => [rule.model, ...rule.fallbackModels]),
        ]
      : [];
    for (const wire of current) {
      if (!wire || wire === 'auto' || byWire.has(wire)) continue;
      byWire.set(wire, {
        providerID: 'kortix',
        providerName: 'Kortix',
        modelID: wire,
        modelName: wire,
      });
    }
    return [...byWire.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [catalogModels, draft]);

  if (routing.isError) {
    return (
      <RoutingSection>
        <div className="bg-popover rounded-md border px-4 py-3">
          <p className="text-destructive text-sm">Could not load the routing policy.</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => routing.refetch()}>
            Retry
          </Button>
        </div>
      </RoutingSection>
    );
  }

  if (routing.isPending || !draft || !routing.data) {
    return (
      <RoutingSection>
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-md" />
          <Skeleton className="h-12 rounded-md" />
        </div>
      </RoutingSection>
    );
  }

  const writable = canWrite && routing.data.capabilities?.write !== false;
  const controlsDisabled =
    !writable ||
    routing.set.isPending ||
    routing.reset.isPending ||
    projectDefaultPending ||
    modelDefaults.isLoading;
  const editableState = (policy: GatewayProjectRoutingPolicy) => ({
    visionModel: policy.visionModel,
    defaultFallback: policy.defaultFallback,
    rules: policy.rules,
    modelGenerationConfig: policy.modelGenerationConfig ?? {},
  });
  const dirty =
    JSON.stringify(editableState(draft)) !== JSON.stringify(editableState(routing.data.project));
  const projectDefaultWire = modelDefaults.projectDefault
    ? modelKeyToWire(modelDefaults.projectDefault)
    : null;
  const primaryModel = projectDefaultWire ?? routing.data.effective.defaultModel;
  const validation = validateRoutingDraft({ ...draft, defaultModel: primaryModel }, fallbackMode);
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const usedRuleModelSet = new Set(usedRuleModels);
  const newRuleModel = models.find((model) => !usedRuleModelSet.has(modelKeyToWire(model)));
  const inheritedRoute = [
    routing.data.effective.defaultModel,
    ...routing.data.effective.defaultFallback.models,
  ].join(' → ');

  const setRule = (index: number, rule: GatewayRoutingRule) => {
    setDraft((current) => {
      if (!current) return current;
      const rules = [...current.rules];
      rules[index] = rule;
      return { ...current, rules };
    });
  };

  const changeFallbackMode = (mode: FallbackMode) => {
    setFallbackMode(mode);
    setDraft((current) => {
      if (!current) return current;
      if (mode === 'inherit') return { ...current, defaultFallback: null };
      if (mode === 'disabled') {
        return { ...current, defaultFallback: { models: [], fallbackOn: 'transient' } };
      }
      if (current.defaultFallback?.models.length) return current;
      const inherited = routing.data.effective.defaultFallback.models.filter(
        (model) => model !== primaryModel,
      );
      const preferred =
        models.find((model) => modelKeyToWire(model) === 'glm-5.2') ??
        models.find((model) => modelKeyToWire(model) !== primaryModel);
      return {
        ...current,
        defaultFallback: {
          models: inherited.length
            ? inherited.slice(0, MAX_FALLBACKS)
            : preferred
              ? [modelKeyToWire(preferred)]
              : [],
          fallbackOn: routing.data.effective.defaultFallback.fallbackOn,
        },
      };
    });
  };

  return (
    <RoutingSection
      action={
        writable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={controlsDisabled}
            onClick={() => setResetOpen(true)}
          >
            <RotateCcw className="size-3.5" /> Reset
          </Button>
        ) : (
          <Badge variant="muted" size="sm">
            Read only
          </Badge>
        )
      }
    >
      <div className="space-y-8">
        {/* PRIMARY — always visible. "What handles this project's requests"
            (Fallback) and "the exceptions to it" (Per-model overrides) are
            the decision someone opens this tab to make; both get the
            full-strength foreground heading below, not the muted `Label`
            default the two Advanced sections keep. */}
        <section className="space-y-1">
          <Label className="text-foreground">Fallback</Label>
          <div className="flex flex-col">
            <RoutingRow
              label="When the default fails"
              hint="Inherit the platform route, run your own ordered chain, or return the error."
            >
              <Select
                value={fallbackMode}
                disabled={controlsDisabled}
                onValueChange={(mode) => changeFallbackMode(mode as FallbackMode)}
              >
                <SelectTrigger className="w-48 max-w-full" aria-label="Default fallback strategy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">Inherit platform</SelectItem>
                  <SelectItem value="custom">Custom chain</SelectItem>
                  <SelectItem value="disabled">No fallback</SelectItem>
                </SelectContent>
              </Select>
            </RoutingRow>

            {fallbackMode === 'custom' && draft.defaultFallback ? (
              <RoutingRow
                align="start"
                label={<span className="truncate font-mono text-xs">{primaryModel}</span>}
                hint="Tried in order after the project default."
              >
                <div className="space-y-1.5">
                  <AvailabilityBadge available={availability[primaryModel]} />
                  <ChainRows
                    primary={primaryModel}
                    chain={draft.defaultFallback}
                    models={models}
                    disabled={controlsDisabled}
                    availability={availability}
                    onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
                  />
                </div>
              </RoutingRow>
            ) : fallbackMode === 'inherit' ? (
              <RoutingRow label="Inherited route">
                <p className="text-muted-foreground truncate font-mono text-xs">{inheritedRoute}</p>
              </RoutingRow>
            ) : (
              <RoutingRow label="On failure">
                <p className="text-muted-foreground text-xs text-pretty">
                  The error is returned immediately — nothing else is tried.
                </p>
              </RoutingRow>
            )}
          </div>
        </section>

        {/* Per-model overrides is the core feature this tab exists for, not
            the fourth of four equal panels it used to be. It is promoted
            straight to second position (right after the baseline it
            overrides), keeps a foreground heading, and its "Add override"
            action moved into the section header — no more scrolling to the
            bottom of a list to find the one thing you opened the tab to do. */}
        <section className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-foreground">Per-model overrides</Label>
              {draft.rules.length > 0 ? (
                <Badge variant="secondary" size="sm">
                  {draft.rules.length}
                </Badge>
              ) : null}
            </div>
            {writable ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={controlsDisabled || !newRuleModel || draft.rules.length >= MAX_RULES}
                onClick={() =>
                  newRuleModel &&
                  setDraft({
                    ...draft,
                    rules: [
                      ...draft.rules,
                      {
                        model: modelKeyToWire(newRuleModel),
                        fallbackModels: [],
                        fallbackOn: 'transient',
                      },
                    ],
                  })
                }
              >
                <Plus className="size-3.5 shrink-0" /> Add override
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs text-pretty">
            A chain that replaces the fallback above, but only when that exact model is requested.
          </p>

          {draft.rules.length === 0 ? (
            <p className="text-muted-foreground pt-3 text-xs">
              None — every model uses the fallback above.
            </p>
          ) : (
            <div className="flex flex-col">
              {draft.rules.map((rule, index) => (
                <RoutingRow
                  key={rule.model}
                  align="start"
                  label={
                    <div className="flex min-w-0 items-center gap-1">
                      <div className="min-w-0 flex-1">
                        <RoutingModelSelector
                          value={rule.model}
                          models={models}
                          exclude={usedRuleModels.filter((_, itemIndex) => itemIndex !== index)}
                          disabled={controlsDisabled}
                          onChange={(model) => model && setRule(index, { ...rule, model })}
                        />
                      </div>
                      {writable ? (
                        <Hint label="Remove override">
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Remove model override"
                            disabled={controlsDisabled}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                rules: draft.rules.filter((_, itemIndex) => itemIndex !== index),
                              })
                            }
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </Hint>
                      ) : null}
                    </div>
                  }
                >
                  <div className="space-y-1.5">
                    <AvailabilityBadge available={availability[rule.model]} />
                    <ChainRows
                      primary={rule.model}
                      chain={{ models: rule.fallbackModels, fallbackOn: rule.fallbackOn }}
                      models={models}
                      disabled={controlsDisabled}
                      availability={availability}
                      onChange={(chain) =>
                        setRule(index, {
                          ...rule,
                          fallbackModels: chain.models,
                          fallbackOn: chain.fallbackOn,
                        })
                      }
                    />
                  </div>
                </RoutingRow>
              ))}
            </div>
          )}
        </section>

        {/* ADVANCED — collapsed by default. Vision is a narrow, image-input-only
            override; Generation defaults is four raw parameter knobs
            (reasoning effort, temperature, top-p, max tokens). Neither is the
            decision someone opens Routing to make, so both fold under one
            disclosure below the primary content instead of matching Fallback
            and Per-model overrides panel-for-panel. `hasAdvancedRoutingConfig`
            opens this by default whenever the project already sets either —
            an existing non-default config is never hidden from view. */}
        <Disclosure open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <DisclosureTrigger>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground -mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium transition-colors"
            >
              <CaretDownIcon
                className={cn('size-3.5 shrink-0 transition-transform', advancedOpen && 'rotate-180')}
              />
              Advanced
              <span className="text-muted-foreground/60 font-normal">
                Vision model, generation defaults
              </span>
            </button>
          </DisclosureTrigger>
          <DisclosureContent>
            <div className="space-y-8 pt-5">
              <section className="space-y-1">
                <Label>Vision model</Label>
                <div className="flex flex-col">
                  <RoutingRow
                    label="Image requests"
                    hint={
                      draft.visionModel
                        ? 'Requests with an image go here instead of the chain above.'
                        : routing.data.effective.visionModel
                          ? `Inherits ${routing.data.effective.visionModel}.`
                          : 'Requests with an image follow the chain above.'
                    }
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <RoutingModelSelector
                        value={draft.visionModel}
                        models={models}
                        disabled={controlsDisabled}
                        unsetLabel="Inherit platform"
                        onChange={(visionModel) => setDraft({ ...draft, visionModel })}
                      />
                      <AvailabilityBadge
                        available={draft.visionModel ? availability[draft.visionModel] : undefined}
                      />
                    </div>
                  </RoutingRow>
                </div>
              </section>

              <section className="space-y-1">
                <Label>Generation defaults</Label>
                <p className="text-muted-foreground text-xs text-pretty">
                  Applied to every request for <span className="font-mono">{primaryModel}</span>{' '}
                  that doesn't already set the parameter — a session's own value always wins. Only
                  the controls this model supports are shown.
                </p>
                <div className="pt-3">
                  <GenerationControlsPanel
                    model={primaryModel}
                    value={draft.modelGenerationConfig?.[primaryModel]}
                    disabled={controlsDisabled}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        modelGenerationConfig: {
                          ...draft.modelGenerationConfig,
                          [primaryModel]: next,
                        },
                      })
                    }
                  />
                </div>
              </section>
            </div>
          </DisclosureContent>
        </Disclosure>
      </div>

      {writable ? (
        <div className="bg-background/95 sticky bottom-0 -mx-4 mt-8 flex items-center justify-between gap-4 border-t px-4 py-4 backdrop-blur">
          <div className="text-muted-foreground text-xs">
            {validation ?? (dirty ? 'Unsaved changes' : 'Routing is up to date')}
          </div>
          <Button
            type="button"
            disabled={!dirty || !!validation || controlsDisabled}
            onClick={() => {
              const defaultModel = modelDefaults.data ? projectDefaultWire : draft.defaultModel;
              routing.set.mutate(
                { ...draft, defaultModel },
                {
                  onSuccess: async () => {
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: ['model-defaults', projectId] }),
                      queryClient.invalidateQueries({
                        queryKey: qk.project.modelPicker(projectId),
                      }),
                    ]);
                    successToast('Routing policy saved');
                  },
                  onError: (error) =>
                    errorToast(
                      error instanceof Error ? error.message : 'Could not save routing policy',
                    ),
                },
              );
            }}
          >
            {routing.set.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Save
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset project routing?"
        description="This removes the project default, fallback chain, and per-model overrides. The project will inherit account and platform routing."
        confirmLabel="Reset routing"
        confirmVariant="destructive"
        isPending={routing.reset.isPending}
        onConfirm={() =>
          routing.reset.mutate(undefined, {
            onSuccess: () => {
              setResetOpen(false);
              void queryClient.invalidateQueries({ queryKey: ['model-defaults', projectId] });
              successToast('Project routing reset');
            },
            onError: (error) =>
              errorToast(error instanceof Error ? error.message : 'Could not reset routing'),
          })
        }
      />
    </RoutingSection>
  );
}
