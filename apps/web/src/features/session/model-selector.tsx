'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, CreditCard, KeyRound, Plus, SlidersHorizontal } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '@/features/providers/provider-branding';
import { useLlmProviderCatalogRevision } from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { connectedGatewayProviderIdsFromSecretNames } from '@/hooks/runtime/provider-selection';
import { useModelStore } from '@/hooks/runtime/use-model-store';
import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { AUTO_MODEL_ID, DEFAULT_MANAGED_MODEL_IDS, PROVIDER_LABELS } from '@kortix/llm-catalog';
import { featureFlags } from '@kortix/sdk/feature-flags';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { AutoModelToggle } from './auto-model-toggle';
import { shouldShowFreeTag } from './model-tags';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

export { Tag };

// Import from canonical UI component and re-export for consumers
import { Tag } from '@/components/ui/tag';

// `auto` is a synthetic managed entry (not a real upstream model): grouped under
// Kortix and — when exposed (see featureFlags.enableAutoModel) — rendered as a
// special "smart routing" affordance rather than a normal list item. It stays in
// this set so it groups under Kortix and is recognised as managed even while the
// toggle is hidden.
const MANAGED_MODEL_IDS = new Set<string>([...DEFAULT_MANAGED_MODEL_IDS, AUTO_MODEL_ID]);

// The gateway exposes its whole catalog through a single `kortix` provider, with
// model ids namespaced as `<provider>/<model>`. For the picker we recover the
// REAL provider: platform-managed defaults stay under the "Kortix" group, while
// every BYOK model surfaces under its real provider ("Anthropic", "OpenAI", …) —
// so a connected provider reads as its own section, not buried in Kortix.
//
// *** BUG THIS FIXES (every model showing under "Kortix", even BYOK Anthropic) ***
// `pickerGroupId` always correctly computed the grouping KEY (it split
// `modelID` on "/" and returned e.g. "anthropic"). The bug was never in the
// key — it was that the group's DISPLAY NAME, built in `grouped` below, was
// taken verbatim from `model.providerName` (opencode's raw provider name,
// which is ALWAYS "Kortix" — every gateway model is registered under the one
// synthetic `kortix` opencode provider). So the group's icon rendered
// correctly (`ProviderLogo` is keyed off the correct `providerID`), but the
// text label next to it always read "Kortix" regardless of which provider
// actually served the model.
//
// The robust fix (per the live /v1/models trace): the gateway now serves an
// EXPLICIT `provider` field per model (`GatewayModel.provider`, threaded onto
// `FlatModel.provider` by flattenModels) — grouping/labeling should prefer
// that over parsing the wire id at all. String-splitting `modelID` remains
// ONLY as a fallback for a stale/older baked catalog that predates the field.
export function pickerGroupId(model: FlatModel): string {
  if (model.providerID !== 'kortix' || MANAGED_MODEL_IDS.has(model.modelID)) {
    return model.providerID;
  }
  if (model.provider) return model.provider;
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}

// The group's display name/label — NEVER the raw `FlatModel.providerName`
// (always "Kortix" under the gateway, see the bug note above). Prefer the
// canonical label for the resolved real-provider id; only fall back to the
// model's own providerName for a truly unknown id (e.g. `pickerGroupId`
// degrading to the raw `providerID` because neither `provider` nor a `/` was
// present — at that point `groupID === model.providerID` anyway).
export function pickerGroupLabel(groupID: string, model: FlatModel): string {
  return PROVIDER_LABELS[groupID] ?? model.providerName;
}

// ─── ModelSelector ───────────────────────────────────────────────────────────

export interface ModelSelectorProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  /**
   * Trigger label shown when `selectedModel` is null. Defaults to "No model"
   * (the chat-input/schedule meaning: falls back to the agent/account/platform
   * chain). Pass e.g. "Project default" where null specifically means "inherit
   * the project's configured default" so the pill never implies nothing was
   * chosen when something concrete will actually run.
   */
  unsetLabel?: string;
  disabled?: boolean;
}

export function ModelSelector({
  models,
  selectedModel,
  onSelect,
  unsetLabel = 'No model',
  disabled = false,
}: ModelSelectorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // When AUTO is on, the manual provider list is hidden by default. This reveals
  // it (so the user can switch to a specific model) without turning AUTO off yet.
  const [expandManual, setExpandManual] = useState(false);
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
  const projectDetailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);
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

  // Free tier (free/no plan AND no active subscription) hides Kortix managed
  // paid/AUTO models. Managed free models and connected BYOK providers remain.
  const { data: accountState } = useAccountState();
  const freeTier = useMemo(() => {
    const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
    const hasActiveSubscription = !!accountState?.subscription?.subscription_id;
    return (tierKey === 'free' || tierKey === 'none') && !hasActiveSubscription;
  }, [accountState]);

  const modelStore = useModelStore(baseModels, {
    connectedProviderIds,
    freeTier: llmGatewayEnabled && freeTier,
  });

  const current = baseModels.find(
    (m) => m.providerID === selectedModel?.providerID && m.modelID === selectedModel?.modelID,
  );
  const displayName = current?.modelName || unsetLabel;

  // Reset transient picker state when closing.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setExpandManual(false);
    }
  }, [open]);

  // ── Filtered + grouped models ──

  const visibleModels = useMemo(() => {
    const q = search.toLowerCase();
    return baseModels
      .filter((m) => {
        // AUTO is rendered as a standalone toggle above the providers — never
        // inside a provider group.
        if (m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID) return false;
        // A search query reveals everything; otherwise respect visibility from
        // the provider modal's Models tab.
        if (
          !q &&
          !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID, provider: m.provider })
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
  }, [baseModels, search, modelStore]);

  const grouped = useMemo(() => {
    const groups = new Map<
      string,
      { providerName: string; providerID: string; models: FlatModel[] }
    >();
    for (const m of visibleModels) {
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
  }, [visibleModels, llmGatewayEnabled]);

  // AUTO lives outside the provider groups — a standalone toggle. When it's on,
  // the manual model list is hidden unless the user expands it.
  const autoModel = useMemo(
    () =>
      featureFlags.enableAutoModel && llmGatewayEnabled && !freeTier
        ? baseModels.find((m) => m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID)
        : undefined,
    [baseModels, llmGatewayEnabled, freeTier],
  );

  const isAutoSelected =
    featureFlags.enableAutoModel &&
    selectedModel?.providerID === 'kortix' &&
    selectedModel?.modelID === AUTO_MODEL_ID;
  // "On" is the collapsed active view; expanding the manual list to pick a
  // specific model reads as off and reveals the providers. So the switch is on
  // exactly when the manual list is hidden.
  const autoOn = isAutoSelected && !expandManual;
  const showManual = !autoOn;
  const toggleAuto = () => {
    if (!autoModel) return;
    if (autoOn) setExpandManual(true);
    else {
      onSelect({ providerID: autoModel.providerID, modelID: autoModel.modelID });
      setExpandManual(false);
    }
  };

  // ── Handlers ──

  const handleSelect = useCallback(
    (model: FlatModel) => {
      onSelect({ providerID: model.providerID, modelID: model.modelID });
      setOpen(false);
    },
    [onSelect],
  );

  // Adapted from main's `ProviderModalTab` ('providers' | 'models') to this
  // branch's connect modal, whose tabs are 'subscriptions' | 'api-keys' (see
  // `useModelConnectionGate`/`connect-modal-host.tsx` — the account-wide
  // `provider-modal-store` main used doesn't exist here, replaced by the
  // root-mounted `ConnectModalHost`). "+" (add a new provider) maps to the
  // api-keys tab; the sliders "Manage models" affordance has no equivalent
  // tab in the new modal, so it opens the connect modal on its default view.
  const handleOpenProviderModal = useCallback(
    (tab?: 'subscriptions' | 'api-keys') => {
      setOpen(false);
      openConnectProvider(tab);
    },
    [openConnectProvider],
  );

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
        <Tooltip>
          <TooltipTrigger asChild>
            <CommandPopoverTrigger>
              <button
                type="button"
                disabled={disabled}
                aria-label={tHardcodedUi.raw(
                  'componentsSessionModelSelector.line207JsxAttrAriaLabelModelPicker',
                )}
                className={cn(
                  'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-200',
                  open && 'bg-muted text-foreground',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="max-w-[120px] truncate">{displayName}</span>
                <ChevronDown
                  className={cn(
                    'size-3 opacity-50 transition-transform duration-200',
                    open && 'rotate-180',
                  )}
                />
              </button>
            </CommandPopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {tHardcodedUi.raw('componentsSessionModelSelector.line218JsxTextChooseModel')}
          </TooltipContent>
        </Tooltip>

        <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
          {/* AUTO — standalone, above every provider. An elegant on/off control. */}
          {autoModel && <AutoModelToggle autoOn={autoOn} onToggle={toggleAuto} />}

          {showManual && <div className="bg-border/60 h-px" />}

          {showManual ? (
            <>
              <CommandInput
                compact
                placeholder={tHardcodedUi.raw(
                  'componentsSessionModelSelector.line224JsxAttrPlaceholderSearchModels',
                )}
                value={search}
                onValueChange={setSearch}
                rightElement={
                  <div className="-mr-0.5 flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Add provider"
                          onClick={() => handleOpenProviderModal('api-keys')}
                          className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors"
                        >
                          <Plus className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {tHardcodedUi.raw(
                          'componentsSessionModelSelector.line239JsxTextConnectProvider',
                        )}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Manage models"
                          onClick={() => handleOpenProviderModal()}
                          className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors"
                        >
                          <SlidersHorizontal className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {tHardcodedUi.raw(
                          'componentsSessionModelSelector.line251JsxTextManageModels',
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                }
              />

              <CommandList className="max-h-[380px]">
                {grouped.length > 0 ? (
                  <>
                    {grouped.map((group) => (
                      <CommandGroup
                        key={group.providerID}
                        heading={
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
                                '!pl-3',
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
                                <p className="text-muted-foreground/55 mt-1 truncate text-xs leading-snug">
                                  {displayModelID}
                                </p>
                              </div>
                              {isFree && <Tag variant="free">Free</Tag>}
                              {isSelected && <Check className="text-foreground shrink-0" />}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ))}
                  </>
                ) : (
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
                        onClick={() => handleOpenProviderModal('api-keys')}
                      >
                        <KeyRound className="size-3.5" />
                        Connect provider
                      </Button>
                    </div>
                  </div>
                )}
              </CommandList>
            </>
          ) : (
            <div className="p-1.5 pt-0">
              <button
                type="button"
                onClick={() => setExpandManual(true)}
                className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center justify-center rounded-lg px-2.5 py-2 text-xs font-medium transition-colors duration-200"
              >
                Pick a specific model
              </button>
            </div>
          )}
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}
