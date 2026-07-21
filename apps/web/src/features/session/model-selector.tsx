'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandItemHoverCard,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import type { HarnessAuthKind } from '@kortix/sdk';
import type { KortixHarness } from '@kortix/sdk/react';
import { harnessPresentation } from '@kortix/sdk/react';
import {
  Bot,
  Check,
  ChevronDown,
  CreditCard,
  FolderGit2,
  KeyRound,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '@/features/providers/provider-branding';
import { useLlmProviderCatalogRevision } from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import { useAccountState } from '@/hooks/billing';
import { connectedGatewayProviderIdsFromSecretNames } from '@/hooks/runtime/provider-selection';
import { useModelStore } from '@/hooks/runtime/use-model-store';
import { useProjectLlmGatewayEnabled } from '@/hooks/runtime/use-project-llm-gateway-enabled';
import { computeFreeTier } from '@/hooks/runtime/use-runtime-local';
import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';
import { AUTO_MODEL_ID, PROVIDER_LABELS } from '@kortix/llm-catalog';
import { listProjectSecrets } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import {
  COMPOSER_PILL_ACTIVE_CLASS,
  COMPOSER_PILL_DISABLED_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
} from './composer-pill';
import {
  RENDERED_MODEL_CAP,
  capModelList,
  defaultOptionCopy,
  filterHarnessPresets,
  harnessSubscriptionCopy,
  isSubscriptionConnection,
  pickerGroupId,
  presetProviderTag,
  shouldShowModelSearch,
} from './model-selector-helpers';
import { shouldShowFreeTag } from './model-tags';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

export { pickerGroupId, Tag };

// Import from canonical UI component and re-export for consumers
import { Tag } from '@/components/ui/tag';

// The group's display name/label — NEVER the raw `FlatModel.providerName`
// (always "Kortix" under the gateway). Prefer the canonical label for the
// resolved real-provider id; only fall back to the model's own providerName
// for a truly unknown id (e.g. `pickerGroupId` degrading to the raw
// `providerID` because neither `provider` nor a `/` was present — at that
// point `groupID === model.providerID` anyway).
//
// *** BUG THIS FIXES (every model showing under "Kortix", even BYOK Anthropic) ***
// `pickerGroupId` always correctly computed the grouping KEY. The bug was that
// the group's DISPLAY NAME was taken from `model.providerName` (opencode's raw
// name, always "Kortix" under the synthetic gateway provider). Icon keyed off
// the right `providerID`; text always said "Kortix". Fix: resolve the label
// from PROVIDER_LABELS by the real group id — never from raw providerName.
export function pickerGroupLabel(groupID: string, model: FlatModel): string {
  return PROVIDER_LABELS[groupID] ?? model.providerName;
}

// ─── ModelSelector ───────────────────────────────────────────────────────────

type ModelRef = { providerID: string; modelID: string };

// Optional "set this model as a default" controls. When provided, the picker
// shows a footer to pin the selected model as the account default (and, when an
// agent is active, that agent's default). These persist server-side — the LLM
// gateway resolves `auto` against them. Omitted in non-session pickers.
export interface ModelDefaultControls {
  /** Current agent name; enables the per-agent default action when set. */
  agentName?: string;
  onSetAccountDefault: (model: ModelRef) => void;
  onSetAgentDefault?: (model: ModelRef) => void;
  /** When set (in-project picker), pin the model as this project's default. */
  onSetProjectDefault?: (model: ModelRef) => void;
}

/**
 * Harness-native (Claude Code, Codex, Pi) selection — these harnesses don't
 * consume the gateway/BYOK provider catalog; their safe common contract is
 * "use the harness-native default, or pass one explicit model id at session
 * launch." Passing this prop switches `ModelSelector` into that mode: a flat,
 * capped preset list instead of the gateway catalog grouped by provider.
 * Subscription-backed connections (Claude/Codex subscription) render a
 * teaching note instead of a fabricated models.dev catalog. Mutually
 * exclusive with `models`/`selectedModel`/`onSelect` below.
 */
export interface HarnessModelSelection {
  harness: KortixHarness;
  selectedModel: string | null;
  onSelect: (model: string | null) => void;
  presets?: Array<{ id: string; name: string; source: string }>;
  connectionLabel?: string | null;
  /** Resolved auth-kind for the active connection — drives the subscription
   *  "Models managed by …" copy and the "via …" context header. */
  connectionKind?: HarnessAuthKind | null;
  disabled?: boolean;
}

export interface ModelSelectorProps {
  models?: FlatModel[];
  selectedModel?: ModelRef | null;
  onSelect?: (model: ModelRef | null) => void;
  providers?: ProviderListResponse;
  defaultControls?: ModelDefaultControls;
  /**
   * Trigger label shown when `selectedModel` is null. Defaults to "No model"
   * (the chat-input/schedule meaning: falls back to the agent/account/platform
   * chain). Pass e.g. "Project default" where null specifically means "inherit
   * the project's configured default" so the pill never implies nothing was
   * chosen when something concrete will actually run.
   */
  unsetLabel?: string;
  disabled?: boolean;
  /** Switches to harness-native mode — see {@link HarnessModelSelection}. */
  harnessModel?: HarnessModelSelection;
}

/**
 * The ONE model picker. Two data modes, one popover shell, one file:
 *
 * - Catalog mode (default): `models`/`selectedModel`/`onSelect` — the
 *   gateway/BYOK provider catalog grouped by provider, used for OpenCode.
 * - Harness mode: `harnessModel` — Claude Code / Codex / Pi's own default +
 *   preset list (never the gateway catalog), a flat capped list with
 *   subscription-aware copy.
 *
 * Both modes share the same trigger pill, `CommandPopover` shell, pinned
 * "Auto" row with a hover card, and "Manage models" footer — this is the
 * single surface every harness's model pill renders through; there is no
 * flag, no alternate component, and no free-typed "enter a model id" entry.
 */
export function ModelSelector({
  models = [],
  selectedModel = null,
  onSelect,
  defaultControls,
  unsetLabel = 'Default',
  disabled = false,
  harnessModel,
}: ModelSelectorProps) {
  if (harnessModel) {
    return <HarnessSelector {...harnessModel} disabled={disabled || !!harnessModel.disabled} />;
  }
  return (
    <CatalogSelector
      models={models}
      selectedModel={selectedModel}
      onSelect={onSelect ?? (() => {})}
      defaultControls={defaultControls}
      unsetLabel={unsetLabel}
      disabled={disabled}
    />
  );
}

// ─── Catalog mode (gateway/BYOK provider catalog, grouped) ──────────────────

function CatalogSelector({
  models,
  selectedModel,
  onSelect,
  defaultControls,
  unsetLabel,
  disabled,
}: {
  models: FlatModel[];
  selectedModel: ModelRef | null;
  onSelect: (model: ModelRef | null) => void;
  defaultControls?: ModelDefaultControls;
  unsetLabel: string;
  disabled: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Filtering a gateway-sized catalog (thousands of entries once a search
  // query bypasses the default visibility gate below) on every keystroke
  // would block typing — defer it so the input never stutters.
  const deferredSearch = useDeferredValue(search);
  // Where Upgrade / Connect provider should route, given the current route
  // context — shared with the chat input's full-block gate and onboarding so
  // they all open the exact same dialogs.
  const {
    openConnectProvider,
    openUpgrade,
    modal: connectionModal,
    showUpgradeOption,
  } = useModelConnectionGate();

  // When mounted under /projects/[id]/..., route model filtering to the
  // per-project gateway catalog. On every other route (instance dashboard,
  // /milano, /berlin, etc.) we filter to native (non-gateway) models.
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const { llmGatewayEnabled } = useProjectLlmGatewayEnabled(projectId);
  const baseModels = useMemo(() => {
    return llmGatewayEnabled ? models : models.filter((m) => m.providerID !== 'kortix');
  }, [models, llmGatewayEnabled]);

  // Track project secrets whenever we're in a project (not only while the picker
  // is open) so connecting/disconnecting a provider flips model visibility live —
  // the connect mutation invalidates this exact key, and an always-subscribed
  // query refetches immediately instead of waiting for the next picker open.
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId && llmGatewayEnabled,
    staleTime: 10_000,
  });
  const secretNames = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return new Set(items.map((secret: { name: string }) => secret.name));
  }, [secretsQuery.data]);
  // Providers whose key(s) are present — drives which of the gateway's full
  // baked catalog is shown by default in the picker (connected providers light
  // up the instant their secret lands; everything else stays search-only).
  // Re-renders when LlmCatalogBootstrap's live-catalog fetch lands — see
  // use-connected-providers.ts for the same pattern.
  const catalogRevision = useLlmProviderCatalogRevision();
  const connectedProviderIds = useMemo(() => {
    if (!llmGatewayEnabled) return new Set<string>();
    return connectedGatewayProviderIdsFromSecretNames(secretNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogRevision drives a re-read of the module-level LLM_PROVIDERS binding, not a value used directly here
  }, [llmGatewayEnabled, secretNames, catalogRevision]);

  // Free tier (free/no plan AND no active subscription) hides paid/AUTO
  // Kortix models. Managed free models and connected BYOK providers remain.
  const { data: accountState } = useAccountState();
  const freeTier = useMemo(() => computeFreeTier(accountState), [accountState]);

  const modelStore = useModelStore(baseModels, {
    connectedProviderIds,
    freeTier: llmGatewayEnabled && freeTier,
  });

  // Automatic — the recommended-default row. Canonical for gateway projects
  // (not an experiment flag): the backend resolves an unset model to
  // managed-auto, so "no explicit pick" and the AUTO model are the same state
  // and both render as Automatic.
  const autoAvailable = llmGatewayEnabled && !freeTier;
  const isAutoSelected =
    autoAvailable &&
    (!selectedModel ||
      (selectedModel.providerID === 'kortix' && selectedModel.modelID === AUTO_MODEL_ID));

  const current = baseModels.find(
    (m) => m.providerID === selectedModel?.providerID && m.modelID === selectedModel?.modelID,
  );
  // Plain-words trigger label (never a raw model id) — "Auto" wins over
  // whatever catalog name the synthetic auto entry happens to carry.
  const displayName = isAutoSelected ? 'Auto' : current?.modelName || unsetLabel;

  // Reset transient picker state when closing.
  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  // ── Filtered + grouped models ──

  // Ignores the current search query — used only to decide whether a search
  // field earns its place at all (handoff-style "hide the catalog until
  // asked"; see shouldShowModelSearch).
  const usableModelCount = useMemo(() => {
    return baseModels.filter((m) => {
      if (m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID) return false;
      return modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID });
    }).length;
  }, [baseModels, modelStore]);
  const showSearch = shouldShowModelSearch(usableModelCount);

  const visibleModels = useMemo(() => {
    const q = deferredSearch.toLowerCase();
    return baseModels
      .filter((m) => {
        // AUTO is rendered as a standalone toggle above the providers — never
        // inside a provider group.
        if (m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID) return false;
        // A search query reveals everything; otherwise respect visibility from
        // the provider modal's Models tab.
        if (
          !q &&
          !modelStore.isVisible({
            providerID: m.providerID,
            modelID: m.modelID,
            provider: m.provider,
          })
        )
          return false;
        return (
          !q ||
          (m.modelName || '').toLowerCase().includes(q) ||
          (m.modelID || '').toLowerCase().includes(q) ||
          (m.providerName || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [baseModels, deferredSearch, modelStore]);

  // A search query against a gateway-sized catalog (thousands of entries,
  // unconditioned on connected credentials — see gatewayModelCatalog's doc
  // comment) can match hundreds of rows; the default (no-search) view is
  // already bounded by modelStore.isVisible above. Cap what actually mounts
  // either way, same contract as the harness list's filterHarnessPresets.
  const { visible: cappedModels, hiddenCount } = useMemo(
    () => capModelList(visibleModels, selectedModel, RENDERED_MODEL_CAP),
    [visibleModels, selectedModel],
  );

  const grouped = useMemo(() => {
    const groups = new Map<
      string,
      { providerName: string; providerID: string; models: FlatModel[] }
    >();
    for (const m of cappedModels) {
      const groupID = llmGatewayEnabled ? pickerGroupId(m) : m.providerID;
      const existing = groups.get(groupID);
      if (existing) {
        existing.models.push(m);
      } else {
        groups.set(groupID, {
          providerID: groupID,
          // NEVER `m.providerName` here — under the gateway it's always
          // "Kortix" (opencode's raw provider name), which is exactly the
          // "every provider shows as Kortix" bug. Label by the resolved real
          // provider id instead. See pickerGroupLabel's doc comment.
          providerName: llmGatewayEnabled ? pickerGroupLabel(groupID, m) : m.providerName,
          models: [m],
        });
      }
    }
    const entries = Array.from(groups.values());
    entries.sort((a, b) => {
      const ai = MODEL_SELECTOR_PROVIDER_IDS.indexOf(a.providerID);
      const bi = MODEL_SELECTOR_PROVIDER_IDS.indexOf(b.providerID);
      if (ai >= 0 && bi < 0) return -1;
      if (ai < 0 && bi >= 0) return 1;
      if (ai >= 0 && bi >= 0) return ai - bi;
      return a.providerName.localeCompare(b.providerName);
    });
    return entries;
  }, [cappedModels, llmGatewayEnabled]);

  // Auto — the recommended-default row, pinned first with a check when
  // active. A regular list item, never a switch that can read "off" while
  // still selected.
  const autoModel = useMemo(
    () =>
      autoAvailable
        ? baseModels.find((m) => m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID)
        : undefined,
    [baseModels, autoAvailable],
  );

  // ── Handlers ──

  const handleSelect = useCallback(
    (model: FlatModel) => {
      onSelect({ providerID: model.providerID, modelID: model.modelID });
      setOpen(false);
    },
    [onSelect],
  );

  const handleOpenProviderModal = useCallback(() => {
    setOpen(false);
    openConnectProvider();
  }, [openConnectProvider]);

  const handleUpgrade = useCallback(() => {
    setOpen(false);
    openUpgrade();
  }, [openUpgrade]);

  return (
    <>
      {connectionModal}
      <CommandPopover
        open={disabled ? false : open}
        onOpenChange={(next) => !disabled && setOpen(next)}
      >
        <Hint
          side="top"
          label={tHardcodedUi.raw('componentsSessionModelSelector.line218JsxTextChooseModel')}
          className="text-xs"
        >
          <CommandPopoverTrigger>
            <button
              type="button"
              data-testid="catalog-model-selector"
              disabled={disabled}
              aria-label={tHardcodedUi.raw(
                'componentsSessionModelSelector.line207JsxAttrAriaLabelModelPicker',
              )}
              className={cn(
                COMPOSER_PILL_TRIGGER_CLASS,
                open && COMPOSER_PILL_ACTIVE_CLASS,
                disabled && COMPOSER_PILL_DISABLED_CLASS,
              )}
            >
              <span className="max-w-[92px] truncate sm:max-w-[120px]">{displayName}</span>
              <ChevronDown
                className={cn(
                  'size-3 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CommandPopoverTrigger>
        </Hint>

        <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
          {showSearch ? (
            <CommandInput
              compact
              placeholder={tHardcodedUi.raw(
                'componentsSessionModelSelector.line224JsxAttrPlaceholderSearchModels',
              )}
              value={search}
              onValueChange={setSearch}
            />
          ) : null}

          <CommandList className="max-h-[380px]">
            {/* Auto — the recommended default, pinned first with a check when
                active. One line like every model row; the hover card explains
                who picks the model. Steps aside while searching. */}
            {autoModel && !search.trim() ? (
              <CommandGroup forceMount>
                <CommandItemHoverCard
                  content={
                    <div data-testid="model-auto-hover-card">
                      <p className="text-sm font-medium">Auto</p>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug text-pretty">
                        Kortix picks the best model for you.
                      </p>
                    </div>
                  }
                >
                  <CommandItem
                    value="model-automatic"
                    data-testid="model-auto-option"
                    className={cn('!pl-2', isAutoSelected ? 'bg-foreground/[0.06]' : undefined)}
                    onSelect={() => handleSelect(autoModel)}
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm leading-tight',
                        isAutoSelected
                          ? 'text-foreground font-semibold'
                          : 'text-foreground/90 font-medium',
                      )}
                    >
                      Auto
                    </span>
                    {isAutoSelected && <Check className="text-foreground size-4 shrink-0" />}
                  </CommandItem>
                </CommandItemHoverCard>
              </CommandGroup>
            ) : null}

            {grouped.length > 0 ? (
              <>
                {grouped.map((group) => (
                  <CommandGroup
                    key={group.providerID}
                    heading={
                      // A lone connection needs no heading over its own list —
                      // that's how a "Kortix" label ends up floating over every
                      // model for no reason.
                      grouped.length === 1 ? undefined : (
                        <div className="flex items-center gap-2">
                          <ProviderLogo
                            providerID={group.providerID}
                            name={group.providerName}
                            size="small"
                          />
                          <span className="flex-1">{group.providerName}</span>
                          <span className="text-muted-foreground/30 text-xs tracking-normal normal-case">
                            {group.models.length}
                          </span>
                        </div>
                      )
                    }
                    forceMount
                  >
                    {group.models.map((model) => {
                      const isSelected =
                        selectedModel?.providerID === model.providerID &&
                        selectedModel?.modelID === model.modelID;

                      const isFree = shouldShowFreeTag(model);
                      // `.provider` (the real upstream, when the gateway
                      // serves it) makes isVisible's connection-gating
                      // check the correct sub-provider instead of falling
                      // back to string-splitting modelID — see
                      // use-model-store.ts's subProviderOf.
                      const modelKey = {
                        providerID: model.providerID,
                        modelID: model.modelID,
                        provider: model.provider,
                      };
                      // "Latest" models are always shown; older ones get an
                      // activation switch so they can be pinned into the picker.
                      const isLatestModel = modelStore.isLatest(modelKey);
                      const isModelVisible = modelStore.isVisible(modelKey);
                      // Under a BYOK provider group the `<provider>/` prefix is
                      // redundant — show just the bare model id.
                      const displayModelID =
                        group.providerID !== model.providerID && model.modelID.includes('/')
                          ? model.modelID.slice(model.modelID.indexOf('/') + 1)
                          : model.modelID;

                      return (
                        <CommandItem
                          key={`${model.providerID}:${model.modelID}`}
                          value={`model-${model.providerID}-${model.modelID}`}
                          className={cn(
                            '!pl-2',
                            isSelected && 'bg-foreground/[0.06]',
                            !isLatestModel && !isModelVisible && 'opacity-60',
                          )}
                          onSelect={() => handleSelect(model)}
                        >
                          <div className="min-w-0 flex-1 py-0.5">
                            <div
                              className={cn(
                                'truncate text-sm leading-tight',
                                isSelected
                                  ? 'text-foreground font-semibold'
                                  : 'text-foreground/90 font-medium',
                              )}
                            >
                              {model.modelName}
                            </div>
                            {search ? (
                              <p className="text-muted-foreground/55 mt-1 truncate text-xs leading-snug">
                                {displayModelID}
                              </p>
                            ) : null}
                          </div>
                          {isFree && <Tag variant="free">Free</Tag>}
                          {isSelected && <Check className="text-foreground shrink-0" />}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
                {hiddenCount > 0 && (
                  <div
                    data-testid="catalog-model-hidden-count"
                    className="text-muted-foreground/60 px-3 pt-1 pb-2 text-xs"
                  >
                    {hiddenCount.toLocaleString()} more — search to find them
                  </div>
                )}
              </>
            ) : !autoModel ? (
              <div className="px-3 py-5 text-center">
                <div className="text-foreground text-sm font-medium">No models available</div>
                <p className="text-muted-foreground mx-auto mt-1 max-w-[220px] text-xs leading-5">
                  {showUpgradeOption
                    ? 'Upgrade or connect your own provider to start using this session.'
                    : 'Connect your own provider to start using this session.'}
                </p>
                <div className="mt-4 flex items-center justify-center gap-2">
                  {showUpgradeOption && (
                    <Button type="button" size="xs" onClick={handleUpgrade}>
                      <CreditCard className="size-3.5" />
                      Upgrade
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="xs"
                    variant={showUpgradeOption ? 'outline' : 'default'}
                    onClick={() => handleOpenProviderModal()}
                  >
                    <KeyRound className="size-3.5" />
                    Connect a model service
                  </Button>
                </div>
              </div>
            ) : null}
          </CommandList>
          {defaultControls && selectedModel ? (
            <div className="border-border/60 flex flex-col gap-0.5 border-t p-1.5">
              <button
                type="button"
                onClick={() => {
                  defaultControls.onSetAccountDefault(selectedModel);
                  setOpen(false);
                }}
                className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors duration-200"
              >
                <Star className="size-3.5 shrink-0" />
                Set as my default model
              </button>
              {defaultControls.onSetProjectDefault ? (
                <button
                  type="button"
                  onClick={() => {
                    defaultControls.onSetProjectDefault?.(selectedModel);
                    setOpen(false);
                  }}
                  className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors duration-200"
                >
                  <FolderGit2 className="size-3.5 shrink-0" />
                  Set as this project&apos;s default
                </button>
              ) : null}
              {defaultControls.agentName && defaultControls.onSetAgentDefault ? (
                <button
                  type="button"
                  onClick={() => {
                    defaultControls.onSetAgentDefault?.(selectedModel);
                    setOpen(false);
                  }}
                  className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors duration-200"
                >
                  <Bot className="size-3.5 shrink-0" />
                  Set as default for {defaultControls.agentName}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Footer — the giant catalog/connections live on the Models page,
              not in this picker. Same quiet row as the harness picker's. */}
          <button
            type="button"
            onClick={() => handleOpenProviderModal()}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-1.5 border-t px-3.5 py-2.5 text-xs font-medium transition-colors duration-200"
          >
            <SlidersHorizontal className="size-3.5 shrink-0" />
            Manage models
          </button>
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}

// ─── Harness mode (Claude Code / Codex / Pi native selection) ───────────────

/** Most rows a popover list can mount before opening/typing visibly stutters —
 *  everything past the cap stays reachable through search. */
const HARNESS_RENDERED_PRESET_CAP = RENDERED_MODEL_CAP;

function HarnessSelector({
  harness,
  selectedModel,
  onSelect,
  presets = [],
  connectionLabel,
  connectionKind,
  disabled = false,
}: HarnessModelSelection) {
  const presentation = harnessPresentation(harness);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { openConnectProvider, modal: connectionModal } = useModelConnectionGate();

  const isSubscription = isSubscriptionConnection(connectionKind);
  const defaultCopy = defaultOptionCopy({
    connectionKind: connectionKind ?? null,
    harnessLabel: presentation.label,
  });
  const subscriptionCopy = harnessSubscriptionCopy({
    connectionKind,
    harnessLabel: presentation.label,
    connectionLabel,
  });
  const showSearch = !isSubscription && shouldShowModelSearch(presets.length);

  // A gateway-backed preset list can be the entire model catalog (thousands
  // of entries — the Pi-on-Kortix case), so two guards keep this popover
  // lag-free: the search value is deferred (keystrokes never block on
  // re-filtering the full list) and the rendered rows are capped, with a
  // count row telling the user search reaches the rest.
  const deferredSearch = useDeferredValue(search);
  const { visible: visiblePresets, hiddenCount } = useMemo(() => {
    if (isSubscription) return { visible: [], hiddenCount: 0 };
    return filterHarnessPresets({
      presets,
      query: deferredSearch,
      selectedModel,
      cap: HARNESS_RENDERED_PRESET_CAP,
    });
  }, [presets, deferredSearch, selectedModel, isSubscription]);

  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  const handleManageModels = () => {
    setOpen(false);
    openConnectProvider();
  };

  const triggerLabel = selectedModel || defaultCopy.label;

  return (
    <>
      {connectionModal}
      <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
        <Hint
          side="top"
          label={`Choose the model ${presentation.label} launches with`}
          className="max-w-64 text-xs"
        >
          <CommandPopoverTrigger>
            <button
              type="button"
              aria-label={`${presentation.label} model picker`}
              aria-disabled={disabled || undefined}
              data-testid="harness-model-selector"
              data-harness={harness}
              className={cn(
                COMPOSER_PILL_TRIGGER_CLASS,
                open && COMPOSER_PILL_ACTIVE_CLASS,
                disabled && COMPOSER_PILL_DISABLED_CLASS,
              )}
            >
              <span className="max-w-[92px] truncate sm:max-w-[150px]">{triggerLabel}</span>
              <ChevronDown
                className={cn(
                  'size-3 shrink-0 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CommandPopoverTrigger>
        </Hint>

        <CommandPopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="bg-sidebar text-sidebar-foreground hover:text-foreground border-border w-[340px] rounded-md border shadow-xs"
        >
          {showSearch ? (
            <CommandInput
              compact
              placeholder="Search models…"
              value={search}
              onValueChange={setSearch}
            />
          ) : null}

          <CommandList className="max-h-[300px]">
            <CommandGroup forceMount>
              {/* Pinned first; steps aside while the user is searching — a
                  query means they already chose not-auto. One line like every
                  model row; the hover card explains who picks the model. */}
              {!search.trim() && (
                <CommandItemHoverCard
                  content={
                    <div data-testid="harness-model-default-hover-card">
                      <p className="text-sm font-medium">{defaultCopy.label}</p>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug text-pretty">
                        {defaultCopy.subtitle}
                      </p>
                    </div>
                  }
                >
                  <CommandItem
                    value={`${harness}-default-model`}
                    data-testid="harness-model-default"
                    className={!selectedModel ? 'bg-primary/[0.06]' : undefined}
                    onSelect={() => {
                      onSelect(null);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {defaultCopy.label}
                    </span>
                    {!selectedModel ? <Check className="text-foreground size-4 shrink-0" /> : null}
                  </CommandItem>
                </CommandItemHoverCard>
              )}

              {!isSubscription &&
                visiblePresets.map((preset) => {
                  const providerTag = presetProviderTag(preset);
                  return (
                    <CommandItem
                      key={preset.id}
                      value={`${preset.name} ${preset.id}`}
                      data-testid="harness-model-preset"
                      data-model={preset.id}
                      className={selectedModel === preset.id ? 'bg-primary/[0.06]' : undefined}
                      onSelect={() => {
                        onSelect(preset.id);
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{preset.name}</span>
                      {providerTag ? (
                        <span className="text-muted-foreground/60 shrink-0 text-xs">
                          {providerTag}
                        </span>
                      ) : null}
                      {selectedModel === preset.id ? (
                        <Check className="text-foreground size-4 shrink-0" />
                      ) : null}
                    </CommandItem>
                  );
                })}

              {!isSubscription && hiddenCount > 0 && (
                <div
                  data-testid="harness-model-hidden-count"
                  className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs"
                >
                  {hiddenCount.toLocaleString()} more — search to find them
                </div>
              )}
            </CommandGroup>

            {isSubscription && subscriptionCopy ? (
              <div data-testid="harness-model-subscription-note" className="px-3.5 pt-1 pb-3">
                <p className="text-foreground text-sm font-medium">{subscriptionCopy.title}</p>
                <p className="text-muted-foreground mt-1 text-xs">{subscriptionCopy.subtitle}</p>
              </div>
            ) : null}
          </CommandList>

          {!isSubscription && (
            <button
              type="button"
              onClick={handleManageModels}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-1.5 border-t px-3.5 py-2.5 text-xs font-medium transition-colors duration-200"
            >
              <SlidersHorizontal className="size-3.5 shrink-0" />
              Manage models
            </button>
          )}
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}
