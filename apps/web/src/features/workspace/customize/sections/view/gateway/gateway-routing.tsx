'use client';

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
import { ModelSelector } from '@/features/session/model-selector';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useModelDefaults } from '@/hooks/runtime/use-model-defaults';
import { modelKeyToWire, wireToModelKey } from '@/hooks/runtime/use-model-store';
import type {
  GatewayFallbackChain,
  GatewayProjectRoutingPolicy,
  GatewayRoutingRule,
} from '@kortix/sdk/projects-client';
import { useGatewayRoutingPolicy, useProjectModels } from '@kortix/sdk/react';
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
  const options = models.filter((model) => {
    const wire = modelKeyToWire(model);
    return !exclude.includes(wire) || wire === value;
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
      <SelectTrigger className="w-44" aria-label="Fallback condition">
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

function ChainEditor({
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
  const unavailable = [primary ?? '', ...chain.models];
  const canAdd = models.some((model) => !unavailable.includes(modelKeyToWire(model)));

  return (
    <div className="space-y-4 border-t px-4 py-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Fallback on</p>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            Each model is attempted once, in order.
          </p>
        </div>
        <ConditionSelect
          value={chain.fallbackOn}
          onChange={(fallbackOn) => onChange({ ...chain, fallbackOn })}
          disabled={disabled}
        />
      </div>

      {chain.models.length > 0 ? (
        <ul className="space-y-2">
          {chain.models.map((model, index) => (
            <li
              key={`${model}-${index}`}
              className="bg-background flex min-h-10 items-center gap-2 rounded-md border px-3 py-2"
            >
              <span className="text-muted-foreground w-5 shrink-0 text-center text-xs tabular-nums">
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
              <Hint label="Move up">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Move fallback up"
                  disabled={disabled || index === 0}
                  onClick={() =>
                    onChange({ ...chain, models: moveFallback(chain.models, index, -1) })
                  }
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
                  onClick={() =>
                    onChange({ ...chain, models: moveFallback(chain.models, index, 1) })
                  }
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
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          Choose the first fallback model to complete this chain.
        </p>
      )}

      {!disabled ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Add fallback</span>
          <RoutingModelSelector
            value={null}
            models={models}
            exclude={unavailable}
            unsetLabel={canAdd ? 'Choose model' : 'No more models'}
            disabled={!canAdd || chain.models.length >= MAX_FALLBACKS}
            onChange={(next) => next && onChange({ ...chain, models: [...chain.models, next] })}
          />
        </div>
      ) : null}
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
      <CustomizeSectionWrapper
        title="Routing"
        description="Configure what happens when the project default model fails."
      >
        <div className="bg-popover rounded-md border px-4 py-5">
          <p className="text-destructive text-sm">Could not load the routing policy.</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => routing.refetch()}>
            Retry
          </Button>
        </div>
      </CustomizeSectionWrapper>
    );
  }

  if (routing.isPending || !draft || !routing.data) {
    return (
      <CustomizeSectionWrapper
        title="Routing"
        description="Configure what happens when the project default model fails."
      >
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-md" />
          <Skeleton className="h-12 rounded-md" />
        </div>
      </CustomizeSectionWrapper>
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
  const newRuleModel = models.find((model) => !usedRuleModels.includes(modelKeyToWire(model)));

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
    <CustomizeSectionWrapper
      title="Routing"
      description="Choose a bounded fallback path for the project default model."
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
      className="max-w-2xl"
    >
      <div className="space-y-8">
        <section className="space-y-4">
          <Label>Default fallback</Label>
          <div className="bg-popover overflow-hidden rounded-md border">
            <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">When the project default fails</p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                  Inherit the platform route, choose an ordered chain, or return the original error.
                </p>
              </div>
              <Select
                value={fallbackMode}
                disabled={controlsDisabled}
                onValueChange={(mode) => changeFallbackMode(mode as FallbackMode)}
              >
                <SelectTrigger className="w-44" aria-label="Default fallback strategy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">Inherit platform</SelectItem>
                  <SelectItem value="custom">Custom chain</SelectItem>
                  <SelectItem value="disabled">No fallback</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {fallbackMode === 'custom' && draft.defaultFallback ? (
              <ChainEditor
                primary={primaryModel}
                chain={draft.defaultFallback}
                models={models}
                disabled={controlsDisabled}
                availability={availability}
                onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
              />
            ) : fallbackMode === 'inherit' ? (
              <div className="border-t px-4 py-4">
                <p className="text-muted-foreground text-xs">Current inherited route</p>
                <p className="mt-1 truncate font-mono text-xs">
                  {[
                    routing.data.effective.defaultModel,
                    ...routing.data.effective.defaultFallback.models,
                  ].join(' → ')}
                </p>
              </div>
            ) : (
              <div className="border-t px-4 py-4">
                <p className="text-muted-foreground text-sm">
                  The project default error is returned immediately.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <Label>Vision model</Label>
          <div className="bg-popover overflow-hidden rounded-md border">
            <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Image-input override</p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                  Requests that include an image are routed here instead of the default chain.
                </p>
              </div>
              <div className="flex w-full items-center gap-2 sm:w-56">
                <div className="min-w-0 flex-1">
                  <RoutingModelSelector
                    value={draft.visionModel}
                    models={models}
                    disabled={controlsDisabled}
                    unsetLabel="Inherit platform"
                    onChange={(visionModel) => setDraft({ ...draft, visionModel })}
                  />
                </div>
                <AvailabilityBadge
                  available={draft.visionModel ? availability[draft.visionModel] : undefined}
                />
              </div>
            </div>
            {!draft.visionModel ? (
              <div className="border-t px-4 py-4">
                <p className="text-muted-foreground text-xs">Current inherited vision model</p>
                <p className="mt-1 truncate font-mono text-xs">
                  {routing.data.effective.visionModel}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="space-y-4">
          <Label>Generation defaults</Label>
          <div className="bg-popover space-y-4 rounded-md border px-4 py-5">
            <p className="text-muted-foreground text-xs text-pretty">
              Applied to every request for <span className="font-mono">{primaryModel}</span> that
              doesn't already set the parameter — a session's own value always wins. Controls shown
              here are gated by what this model actually supports.
            </p>
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

        <section className="space-y-4">
          <Label>Advanced</Label>
          <Disclosure
            variant="outline"
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="overflow-hidden"
          >
            <DisclosureTrigger variant="outline">
              <Button
                variant="popover"
                className="flex w-full items-center justify-start rounded-none"
              >
                <SlidersHorizontal className="size-4 shrink-0" />
                <span className="flex-1 text-left text-sm font-medium">Per-model fallbacks</span>
                {draft.rules.length > 0 ? (
                  <Badge variant="secondary" size="sm">
                    {draft.rules.length}
                  </Badge>
                ) : null}
              </Button>
            </DisclosureTrigger>
            <DisclosureContent variant="outline" contentClassName="border-border border-t">
              <div className="space-y-5 px-4 py-5">
                <p className="text-muted-foreground text-xs text-pretty">
                  Override the default chain only when a specific model is requested.
                </p>
                {draft.rules.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No per-model fallbacks.</p>
                ) : null}
                {draft.rules.map((rule, index) => (
                  <div
                    key={`${rule.model}-${index}`}
                    className="space-y-4 border-t pt-5 first:border-t-0 first:pt-0"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <RoutingModelSelector
                          value={rule.model}
                          models={models}
                          exclude={usedRuleModels.filter((_, itemIndex) => itemIndex !== index)}
                          disabled={controlsDisabled}
                          onChange={(model) => model && setRule(index, { ...rule, model })}
                        />
                      </div>
                      <AvailabilityBadge available={availability[rule.model]} />
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
                    <ChainEditor
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
                ))}
                {writable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
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
                    <Plus className="size-3.5" /> Add override
                  </Button>
                ) : null}
              </div>
            </DisclosureContent>
          </Disclosure>
        </section>
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
                        queryKey: ['project-model-picker', projectId],
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
        description="This removes the project default, fallback chain, and advanced per-model fallbacks. The project will inherit account and platform routing."
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
    </CustomizeSectionWrapper>
  );
}
