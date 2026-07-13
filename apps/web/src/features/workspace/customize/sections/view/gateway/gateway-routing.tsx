'use client';

import { ArrowDown, ArrowUp, GitBranch, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import type {
  GatewayFallbackChain,
  GatewayProjectRoutingPolicy,
  GatewayRoutingRule,
} from '@kortix/sdk/projects-client';
import { useGatewayRoutingPolicy, useProjectModels } from '@kortix/sdk/react';

const INHERIT = '__inherit__';
const MAX_FALLBACKS = 8;
const MAX_RULES = 20;

type ValidationDraft = Pick<
  GatewayProjectRoutingPolicy,
  'defaultModel' | 'defaultFallback' | 'rules'
>;

export function moveFallback(models: string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= models.length || target < 0 || target >= models.length) {
    return models;
  }
  const next = [...models];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function validateRoutingDraft(draft: ValidationDraft): string | null {
  const validateChain = (primary: string | null, models: string[]) => {
    if (models.length > MAX_FALLBACKS)
      return `A fallback chain can contain at most ${MAX_FALLBACKS} models.`;
    if (new Set(models).size !== models.length) return 'Each fallback model can only appear once.';
    if (primary && models.includes(primary))
      return 'A fallback chain cannot include the primary model.';
    return null;
  };
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

function clonePolicy(policy: GatewayProjectRoutingPolicy): GatewayProjectRoutingPolicy {
  return {
    ...policy,
    defaultFallback: policy.defaultFallback
      ? { ...policy.defaultFallback, models: [...policy.defaultFallback.models] }
      : null,
    rules: policy.rules.map((rule) => ({ ...rule, fallbackModels: [...rule.fallbackModels] })),
  };
}

function modelValue(providerID: string, modelID: string): string {
  return providerID === 'kortix' ? modelID : `${providerID}/${modelID}`;
}

function ModelSelect({
  value,
  models,
  onChange,
  disabled,
  inheritLabel,
  exclude = [],
}: {
  value: string | null;
  models: Array<{ id: string; label: string }>;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  inheritLabel?: string;
  exclude?: string[];
}) {
  const options = models.filter((model) => !exclude.includes(model.id) || model.id === value);
  return (
    <Select
      value={value ?? INHERIT}
      onValueChange={(next) => onChange(next === INHERIT ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger className="w-full max-w-md" aria-label={inheritLabel ?? 'Model'}>
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel ? <SelectItem value={INHERIT}>{inheritLabel}</SelectItem> : null}
        {value && !options.some((model) => model.id === value) ? (
          <SelectItem value={value}>{value}</SelectItem>
        ) : null}
        {options.map((model) => (
          <SelectItem key={model.id} value={model.id} description={model.id}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
          Transient errors
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
}: {
  primary: string | null;
  chain: GatewayFallbackChain;
  models: Array<{ id: string; label: string }>;
  onChange: (chain: GatewayFallbackChain) => void;
  disabled?: boolean;
}) {
  const addCandidate = models.find(
    (model) => model.id !== primary && !chain.models.includes(model.id),
  )?.id;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Label>Error condition</Label>
          <p className="text-muted-foreground mt-1 text-xs">
            Move to the next model once per failed route.
          </p>
        </div>
        <ConditionSelect
          value={chain.fallbackOn}
          onChange={(fallbackOn) => onChange({ ...chain, fallbackOn })}
          disabled={disabled}
        />
      </div>
      <div className="divide-border border-border divide-y border-y">
        {chain.models.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            No fallback models. The primary error is returned immediately.
          </p>
        ) : null}
        {chain.models.map((model, index) => (
          <div key={`${model}-${index}`} className="flex items-center gap-2 py-2.5">
            <span className="text-muted-foreground w-6 text-center text-xs tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <ModelSelect
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
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Move fallback up"
              disabled={disabled || index === 0}
              onClick={() => onChange({ ...chain, models: moveFallback(chain.models, index, -1) })}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Move fallback down"
              disabled={disabled || index === chain.models.length - 1}
              onClick={() => onChange({ ...chain, models: moveFallback(chain.models, index, 1) })}
            >
              <ArrowDown />
            </Button>
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
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      {!disabled ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!addCandidate || chain.models.length >= MAX_FALLBACKS}
          onClick={() =>
            addCandidate &&
            onChange({
              ...chain,
              models: [...chain.models, addCandidate],
            })
          }
        >
          <Plus /> Add fallback
        </Button>
      ) : null}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border grid gap-6 border-b py-7 md:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function GatewayRouting({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const routing = useGatewayRoutingPolicy(projectId);
  const catalogModels = useProjectModels(projectId);
  const [draft, setDraft] = useState<GatewayProjectRoutingPolicy | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [previewModel, setPreviewModel] = useState<string>('auto');
  const [imageInput, setImageInput] = useState(false);

  useEffect(() => {
    if (routing.data?.project) setDraft(clonePolicy(routing.data.project));
  }, [routing.data]);

  const models = useMemo(() => {
    const byId = new Map<string, string>();
    for (const model of catalogModels) {
      byId.set(modelValue(model.providerID, model.modelID), model.modelName);
    }
    const current = draft
      ? [
          draft.defaultModel,
          draft.visionModel,
          ...(draft.defaultFallback?.models ?? []),
          ...draft.rules.flatMap((rule) => [rule.model, ...rule.fallbackModels]),
        ]
      : [];
    current.forEach((id) => id && !byId.has(id) && byId.set(id, id));
    return [...byId.entries()]
      .map(([id, label]) => ({ id, label }))
      .filter((model) => model.id !== 'auto')
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [catalogModels, draft]);

  if (routing.isPending || !draft || !routing.data) {
    return <div className="text-muted-foreground p-8 text-sm">Loading routing policy…</div>;
  }
  if (routing.isError) {
    return <div className="text-destructive p-8 text-sm">Could not load the routing policy.</div>;
  }

  const writable = canWrite && routing.data.capabilities?.write !== false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(routing.data.project);
  const validation = validateRoutingDraft(draft);
  const fallbackMode =
    draft.defaultFallback === null
      ? 'inherit'
      : draft.defaultFallback.models.length === 0
        ? 'disabled'
        : 'custom';
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const newRuleModel = models.find((model) => !usedRuleModels.includes(model.id))?.id;

  const setRule = (index: number, rule: GatewayRoutingRule) => {
    setDraft((current) => {
      if (!current) return current;
      const rules = [...current.rules];
      rules[index] = rule;
      return { ...current, rules };
    });
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-24">
      <div className="border-border flex items-start justify-between gap-6 border-b py-7">
        <div>
          <div className="flex items-center gap-2">
            <GitBranch className="text-muted-foreground size-4" />
            <h2 className="text-base font-medium">Routing policy</h2>
            {!writable ? (
              <Badge variant="muted" size="sm">
                Read only
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm">
            Choose project defaults and finite fallback routes. Models come from the live project
            catalog.
          </p>
        </div>
        {writable ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setResetOpen(true)}>
            <RotateCcw /> Reset
          </Button>
        ) : null}
      </div>

      <Section
        title="Default models"
        description="Used for auto requests. Unset values inherit the account or platform configuration."
      >
        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Label>Project default</Label>
              <Badge variant="muted" size="xs">
                {draft.defaultModel ? 'Project' : routing.data.effective.defaultModelSource}
              </Badge>
            </div>
            <ModelSelect
              value={draft.defaultModel}
              models={models}
              inheritLabel={`Inherit ${routing.data.effective.defaultModel}`}
              disabled={!writable}
              onChange={(defaultModel) => setDraft({ ...draft, defaultModel })}
            />
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Label>Vision model</Label>
              {!draft.visionModel ? (
                <Badge variant="muted" size="xs">
                  Platform
                </Badge>
              ) : null}
            </div>
            <ModelSelect
              value={draft.visionModel}
              models={models.filter((model) => {
                const entry = catalogModels.find(
                  (candidate) => modelValue(candidate.providerID, candidate.modelID) === model.id,
                );
                return entry?.capabilities?.vision !== false;
              })}
              inheritLabel={`Inherit ${routing.data.platform.visionModel}`}
              disabled={!writable}
              onChange={(visionModel) => setDraft({ ...draft, visionModel })}
            />
            <p className="text-muted-foreground mt-2 text-xs">
              Used only when an auto request contains images and its chosen default lacks image
              input.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="Default fallback"
        description="The ordered route used after the resolved project default fails. Every model is attempted at most once."
      >
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Label>Strategy</Label>
              <p className="text-muted-foreground mt-1 text-xs">
                Inherit the operator policy, define a project chain, or return the primary error.
              </p>
            </div>
            <Select
              value={fallbackMode}
              disabled={!writable}
              onValueChange={(mode) => {
                if (mode === 'inherit') setDraft({ ...draft, defaultFallback: null });
                else if (mode === 'disabled') {
                  setDraft({ ...draft, defaultFallback: { models: [], fallbackOn: 'transient' } });
                } else {
                  setDraft({
                    ...draft,
                    defaultFallback: {
                      models: routing.data.effective.defaultFallback.models.length
                        ? [...routing.data.effective.defaultFallback.models]
                        : [],
                      fallbackOn: routing.data.effective.defaultFallback.fallbackOn,
                    },
                  });
                }
              }}
            >
              <SelectTrigger className="w-48" aria-label="Default fallback strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Inherit platform</SelectItem>
                <SelectItem value="custom">Custom chain</SelectItem>
                <SelectItem value="disabled">No fallback</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.defaultFallback && fallbackMode !== 'disabled' ? (
            <ChainEditor
              primary={draft.defaultModel ?? routing.data.effective.defaultModel}
              chain={draft.defaultFallback}
              models={models}
              disabled={!writable}
              onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
            />
          ) : fallbackMode === 'inherit' ? (
            <div className="border-border text-muted-foreground border-y py-4 text-sm">
              Current platform route: {routing.data.platform.defaultModel}
              {routing.data.platform.defaultFallback.models.map((model) => ` → ${model}`).join('')}
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        title="Model overrides"
        description="Exact-model policies for explicit requests or resolved defaults. Overrides take precedence over the default chain."
      >
        <div className="space-y-5">
          {draft.rules.length === 0 ? (
            <div className="border-border text-muted-foreground border-y py-4 text-sm">
              No model-specific overrides.
            </div>
          ) : null}
          {draft.rules.map((rule, index) => (
            <div
              key={`${rule.model}-${index}`}
              className="border-border border-t pt-5 first:border-t-0 first:pt-0"
            >
              <div className="mb-4 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Label className="mb-2 block">Primary model</Label>
                  <ModelSelect
                    value={rule.model}
                    models={models}
                    exclude={usedRuleModels.filter((_, itemIndex) => itemIndex !== index)}
                    disabled={!writable}
                    onChange={(model) => model && setRule(index, { ...rule, model })}
                  />
                </div>
                {writable ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="mt-7"
                    aria-label="Remove model override"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        rules: draft.rules.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
              <ChainEditor
                primary={rule.model}
                chain={{ models: rule.fallbackModels, fallbackOn: rule.fallbackOn }}
                models={models}
                disabled={!writable}
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
              disabled={!newRuleModel || draft.rules.length >= MAX_RULES}
              onClick={() =>
                newRuleModel &&
                setDraft({
                  ...draft,
                  rules: [
                    ...draft.rules,
                    {
                      model: newRuleModel,
                      fallbackModels: [],
                      fallbackOn: 'transient',
                    },
                  ],
                })
              }
            >
              <Plus /> Add override
            </Button>
          ) : null}
        </div>
      </Section>

      <Section
        title="Route preview"
        description="Resolve the exact route and check project availability without sending a prompt or consuming tokens."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <div>
              <Label className="mb-2 block">Requested model</Label>
              <Select value={previewModel} onValueChange={setPreviewModel}>
                <SelectTrigger className="w-full" aria-label="Preview requested model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex h-9 items-center gap-2">
              <Switch
                id="routing-image-input"
                checked={imageInput}
                onCheckedChange={setImageInput}
              />
              <Label htmlFor="routing-image-input">Image input</Label>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={routing.preview.isPending}
              onClick={() => routing.preview.mutate({ requestedModel: previewModel, imageInput })}
            >
              Preview route
            </Button>
          </div>
          {routing.preview.data ? (
            <div className="border-border border-y py-4">
              <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="muted" size="xs">
                  {routing.preview.data.route.policyId}
                </Badge>
                <span>Fallback on {routing.preview.data.route.fallbackOn}</span>
              </div>
              <ol className="space-y-2">
                {routing.preview.data.models.map((model, index) => (
                  <li key={`${model.model}-${index}`} className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground w-5 text-xs tabular-nums">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.model}</span>
                    <Badge variant={model.available ? 'success' : 'warning'} size="xs">
                      {model.available ? 'Available' : 'Unavailable'}
                    </Badge>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </Section>

      {writable ? (
        <div className="border-border bg-background/95 sticky bottom-0 -mx-6 flex items-center justify-between gap-4 border-t px-6 py-4 backdrop-blur">
          <div className="text-muted-foreground text-xs">
            {validation ?? (dirty ? 'Unsaved routing changes' : 'Routing policy is up to date')}
          </div>
          <Button
            type="button"
            disabled={!dirty || !!validation || routing.set.isPending}
            onClick={() =>
              routing.set.mutate(draft, {
                onSuccess: () => successToast('Routing policy saved'),
                onError: (error) =>
                  errorToast(
                    error instanceof Error ? error.message : 'Could not save routing policy',
                  ),
              })
            }
          >
            Save routing policy
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset routing policy?"
        description="This removes the project default, vision override, fallback chain, and every model override. The project will inherit account and platform routing."
        confirmLabel="Reset policy"
        confirmVariant="destructive"
        isPending={routing.reset.isPending}
        onConfirm={() =>
          routing.reset.mutate(undefined, {
            onSuccess: () => {
              setResetOpen(false);
              successToast('Routing policy reset');
            },
            onError: (error) =>
              errorToast(error instanceof Error ? error.message : 'Could not reset routing policy'),
          })
        }
      />
    </div>
  );
}
