'use client';

import { useTranslations } from '../../../../i18n';
/**
 * Routing — where a request goes when its model can't take it.
 *
 * This file owns the state: the editable draft of the project routing policy,
 * the fallback mode, the debounced provider-availability preview, save, and
 * reset. `routing-sentence-layout.tsx` renders the draft as plain sentences
 * (All requests, Images, Exceptions, Model defaults); `routing-parts.tsx`
 * holds the controls it is built from, including the floating save bar.
 *
 * The data contract is untouched: same props in, same `routing.set` /
 * `routing.reset` / `routing.preview` calls out, same exported helpers (which
 * `gateway-routing.test.ts` pins).
 */

import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '../../../../primitives/badge';
import { Button } from '../../../../primitives/button';
import { ConfirmDialog } from '../../../../primitives/confirm-dialog';
import { Skeleton } from '../../../../primitives/skeleton';
import { errorToast, successToast } from '../../../../primitives/toast';
import type { GatewayProjectRoutingPolicy, GatewayRoutingRule } from '@kortix/sdk';
import {
  modelKeyToWire,
  qk,
  useGatewayRoutingPolicy,
  useModelDefaults,
  useProjectModelPickerCatalog,
  useProjectModels,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';

import { GenerationControlsPanel } from './generation-controls';
import {
  type FallbackMode,
  isSelectableModel,
  MAX_FALLBACKS,
  MAX_RULES,
  type RoutingLayoutProps,
  type RoutingModel,
  RoutingSaveBar,
} from './routing-parts';
import { RoutingSentenceLayout } from './routing-sentence-layout';

export { moveFallback } from './routing-parts';
export type { FallbackMode } from './routing-parts';

type ValidationDraft = Pick<
  GatewayProjectRoutingPolicy,
  'defaultModel' | 'defaultFallback' | 'rules'
>;

export function fallbackModeForPolicy(
  fallback: GatewayProjectRoutingPolicy['defaultFallback'],
): FallbackMode {
  if (fallback === null) return 'inherit';
  return fallback.models.length === 0 ? 'disabled' : 'custom';
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
 * Routing's heading band — a SECTION heading, in the page's own column.
 *
 * This was `CustomizeSectionWrapper`, which is the settings PANEL's shell: it
 * brings `mx-auto max-w-2xl` and its own `overflow-y-auto`. Routing is not
 * panel content any more — it is one tab of `/workspaces/[id]/models`, whose
 * column is `CapabilityPageShell`'s `max-w-5xl` — so the wrapper drew this tab
 * 320px narrower than the six tabs beside it, off the column's left edge, and
 * opened a second scroller inside the page's one. The heading and the Reset
 * action are all that was wanted from it, and they are cheaper written out:
 * same `h3`/`p` pair `gateway-access-tab.tsx` uses, so the two tabs that carry
 * section headings carry the same one.
 */
function RoutingSection({ action, children }: { action?: ReactNode; children: ReactNode }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('textbcba696f3eb1')}
          </h3>
          <p className="text-muted-foreground text-xs text-pretty">
            {tI18nComplete.raw('textafb9890f7c72')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayRouting');
  const queryClient = useQueryClient();
  const routing = useGatewayRoutingPolicy(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const catalogModels = useProjectModels(projectId);
  const pickerCatalog = useProjectModelPickerCatalog(projectId);
  const [draft, setDraft] = useState<GatewayProjectRoutingPolicy | null>(null);
  const [fallbackMode, setFallbackMode] = useState<FallbackMode>('inherit');
  const [resetOpen, setResetOpen] = useState(false);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [hydratedPolicySignature, setHydratedPolicySignature] = useState<string | null>(null);
  const previewRequestId = useRef(0);

  // Effective routing also changes when the header's project default changes.
  // Keep an in-progress fallback draft intact unless the persisted project
  // policy itself changed (save, reset, or an external editor update).
  const persistedProject = routing.data?.project;
  const persistedSignature = persistedProject ? editablePolicySignature(persistedProject) : null;
  if (persistedProject && persistedSignature !== hydratedPolicySignature) {
    setHydratedPolicySignature(persistedSignature);
    setDraft(clonePolicy(persistedProject));
    setFallbackMode(fallbackModeForPolicy(persistedProject.defaultFallback));
  }

  const previewRoute = routing.preview.mutateAsync;

  // Debounced availability preview: whenever the draft's referenced models
  // change, ask the gateway which of them currently have a connected
  // provider so the chain editor can flag a dead fallback before save.
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
            const result = await previewRoute({
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
  }, [draft, routing.data, modelDefaults.projectDefault, previewRoute]);

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
          <p className="text-destructive text-sm">{tI18nComplete.raw('textb728bd912cde')}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => routing.refetch()}>
            {tI18nComplete.raw('text942087cc2d41')}
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
  // The mode counts too: "try backups" with an empty chain serializes like
  // "show the error", but it is an unsaved (and invalid) choice.
  const dirty =
    fallbackMode !== fallbackModeForPolicy(routing.data.project.defaultFallback) ||
    JSON.stringify(editableState(draft)) !== JSON.stringify(editableState(routing.data.project));
  const projectDefaultWire = modelDefaults.projectDefault
    ? modelKeyToWire(modelDefaults.projectDefault)
    : null;
  const primaryModel = projectDefaultWire ?? routing.data.effective.defaultModel;
  const validation = validateRoutingDraft({ ...draft, defaultModel: primaryModel }, fallbackMode);
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const usedRuleModelSet = new Set(usedRuleModels);
  const selectableModels = models.filter(isSelectableModel);
  const newRuleModel = selectableModels.find(
    (model) =>
      modelKeyToWire(model) !== primaryModel && !usedRuleModelSet.has(modelKeyToWire(model)),
  );
  const inheritedRoute = [
    routing.data.effective.defaultModel,
    ...routing.data.effective.defaultFallback.models,
  ];

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
      const runnable = new Set(selectableModels.map((model) => modelKeyToWire(model)));
      const inherited = routing.data.effective.defaultFallback.models.filter(
        (model) => model !== primaryModel && runnable.has(model),
      );
      // No model id is hardcoded: the platform fallback already follows the
      // served lineup (`inherited`); otherwise take the first other model.
      const preferred = selectableModels.find((model) => modelKeyToWire(model) !== primaryModel);
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

  const removeRule = (index: number) =>
    setDraft({ ...draft, rules: draft.rules.filter((_, itemIndex) => itemIndex !== index) });

  const addRule =
    newRuleModel && draft.rules.length < MAX_RULES
      ? () => {
          const model = modelKeyToWire(newRuleModel);
          setDraft({
            ...draft,
            rules: [...draft.rules, { model, fallbackModels: [], fallbackOn: 'transient' }],
          });
          return model;
        }
      : null;

  const generationControls = (
    <GenerationControlsPanel
      model={primaryModel}
      catalogModel={pickerCatalog?.models?.[primaryModel]}
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
  );

  const layoutProps: RoutingLayoutProps = {
    draft,
    setDraft,
    setRule,
    removeRule,
    addRule,
    fallbackMode,
    changeFallbackMode,
    models,
    selectableModels,
    availability,
    primaryModel,
    inheritedRoute,
    inheritedFallbackOn: routing.data.effective.defaultFallback.fallbackOn,
    // What "Auto" resolves to: the inherited model, not this project's own
    // override (choosing Auto clears that override).
    effectiveVisionModel:
      (routing.data.project.visionModel
        ? routing.data.platform.visionModel
        : routing.data.effective.visionModel) ?? null,
    generationControls,
    controlsDisabled,
    writable: Boolean(writable),
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
            <RotateCcw className="size-3.5" /> {tI18nComplete.raw('textdaee7606b339')}
          </Button>
        ) : (
          <Badge variant="muted" size="sm">
            {tI18nComplete.raw('text8ac767353080')}
          </Badge>
        )
      }
    >
      <RoutingSentenceLayout {...layoutProps} />

      {writable && (dirty || routing.set.isPending) ? (
        <RoutingSaveBar
          message={validation ?? t('unsaved')}
          saving={routing.set.isPending}
          canSave={dirty && !validation && !controlsDisabled}
          onDiscard={() => {
            setDraft(clonePolicy(routing.data.project));
            setFallbackMode(fallbackModeForPolicy(routing.data.project.defaultFallback));
          }}
          onSave={() => {
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
                  successToast(tI18nComplete.raw('text538f96979be7'));
                },
                onError: (error) =>
                  errorToast(
                    error instanceof Error ? error.message : tI18nComplete.raw('text4501be681694'),
                  ),
              },
            );
          }}
        />
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={tI18nComplete.raw('text7918f9e61a56')}
        description={tI18nComplete.raw('textaf87e03f3626')}
        confirmLabel={tI18nComplete.raw('textf665e07f2a78')}
        confirmVariant="destructive"
        isPending={routing.reset.isPending}
        onConfirm={() =>
          routing.reset.mutate(undefined, {
            onSuccess: () => {
              setResetOpen(false);
              void queryClient.invalidateQueries({ queryKey: ['model-defaults', projectId] });
              successToast(tI18nComplete.raw('textd70047735b1c'));
            },
            onError: (error) =>
              errorToast(
                error instanceof Error ? error.message : tI18nComplete.raw('text71ea14bcd4ab'),
              ),
          })
        }
      />
    </RoutingSection>
  );
}
