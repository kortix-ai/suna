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
import {
  Bot,
  Check,
  ChevronDown,
  CreditCard,
  FolderGit2,
  KeyRound,
  Sparkles,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/features/providers/provider-branding';
import { useAccountState } from '@/hooks/billing';
import { connectedGatewayProviderIdsFromSecretNames } from '@/hooks/runtime/provider-selection';
import { computeFreeTier } from '@/hooks/runtime/use-runtime-local';
import { useModelStore } from '@/hooks/runtime/use-model-store';
import { useProjectLlmGatewayEnabled } from '@/hooks/runtime/use-project-llm-gateway-enabled';
import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { AUTO_MODEL_ID } from '@kortix/llm-catalog';
import { listProjectSecrets } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { COMPOSER_PILL_ACTIVE_CLASS, COMPOSER_PILL_TRIGGER_CLASS } from './composer-pill';
import { shouldShowModelSearch } from './harness-model-selector-helpers';
import { modelSelectorContextLine, pickerGroupId } from './model-selector-helpers';
import { shouldShowFreeTag } from './model-tags';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

export { Tag };

// ─── Backward-compat wrappers ────────────────────────────────────────────────

export function ConnectProviderDialog({
  open,
  onOpenChange,
  providers: _providers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderListResponse | undefined;
}) {
  const { openProviderModal, closeProviderModal } = useProviderModalStore();

  useEffect(() => {
    if (open) openProviderModal('providers');
    else closeProviderModal();
  }, [open, openProviderModal, closeProviderModal]);

  const isStoreOpen = useProviderModalStore((s) => s.isOpen);
  useEffect(() => {
    if (!isStoreOpen && open) onOpenChange(false);
  }, [isStoreOpen, open, onOpenChange]);

  return null;
}

// Import from canonical UI component and re-export for consumers
import { Tag } from '@/components/ui/tag';

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

export interface ModelSelectorProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (model: { providerID: string; modelID: string } | null) => void;
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
}

export function ModelSelector({
  models,
  selectedModel,
  onSelect,
  defaultControls,
  unsetLabel = 'Default',
  disabled = false,
}: ModelSelectorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Where Upgrade / Connect provider should route, given the current route
  // context — shared with the chat input's full-block gate and onboarding so
  // they all open the exact same dialogs.
  const { openConnectProvider, openUpgrade, modal: connectionModal } = useModelConnectionGate();

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
  const connectedProviderIds = useMemo(() => {
    if (!llmGatewayEnabled) return new Set<string>();
    return connectedGatewayProviderIdsFromSecretNames(secretNames);
  }, [llmGatewayEnabled, secretNames]);

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
  // Plain-words trigger label (never a raw model id) — "Automatic" wins over
  // whatever catalog name the synthetic auto entry happens to carry.
  const displayName = isAutoSelected ? 'Automatic' : current?.modelName || unsetLabel;

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
    const q = search.toLowerCase();
    return baseModels
      .filter((m) => {
        // AUTO is rendered as a standalone toggle above the providers — never
        // inside a provider group.
        if (m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID) return false;
        // A search query reveals everything; otherwise respect visibility from
        // the provider modal's Models tab.
        if (!q && !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID }))
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
          providerName: PROVIDER_LABELS[groupID] || m.providerName,
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

  // One-line "what will this agent run on" context header — only meaningful
  // once the visible list resolves to a single connection/group.
  const contextLine = useMemo(() => modelSelectorContextLine(grouped), [grouped]);

  // Automatic — the recommended-default row, pinned first with a check when
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

  const handleOpenProviderModal = useCallback(
    (tab: ProviderModalTab) => {
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
                data-testid="catalog-model-selector"
                disabled={disabled}
                aria-label={tHardcodedUi.raw(
                  'componentsSessionModelSelector.line207JsxAttrAriaLabelModelPicker',
                )}
                className={cn(
                  COMPOSER_PILL_TRIGGER_CLASS,
                  open && COMPOSER_PILL_ACTIVE_CLASS,
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
          {/* Context header — the resolved connection in plain words. Muted,
              not clickable; omitted once more than one group is visible. */}
          {contextLine ? (
            <div className="text-muted-foreground/70 border-b px-4 pt-2.5 pb-2 text-[11px] font-medium tracking-wide">
              {contextLine}
            </div>
          ) : null}

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
            {/* Automatic — the recommended default, pinned first with a check
                when active. A regular row, never a switch. */}
            {autoModel ? (
              <CommandGroup forceMount>
                <CommandItem
                  value="model-automatic"
                  data-testid="model-auto-option"
                  className={isAutoSelected ? 'bg-foreground/[0.06]' : undefined}
                  onSelect={() => handleSelect(autoModel)}
                >
                  <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg">
                    <Sparkles className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 py-0.5">
                    <div
                      className={cn(
                        'truncate text-sm leading-tight',
                        isAutoSelected
                          ? 'text-foreground font-semibold'
                          : 'text-foreground/90 font-medium',
                      )}
                    >
                      Automatic
                    </div>
                    <p className="text-muted-foreground/55 mt-1 truncate text-xs leading-snug">
                      Kortix picks the best model
                    </p>
                  </div>
                  {isAutoSelected && <Check className="text-foreground shrink-0" />}
                </CommandItem>
              </CommandGroup>
            ) : null}

            {grouped.length > 0 ? (
                  <>
                    {grouped.map((group) => (
                      <CommandGroup
                        key={group.providerID}
                        heading={
                          // The context header already names a lone connection —
                          // repeating it as a group heading reads twice.
                          contextLine && grouped.length === 1 ? undefined : (
                            <div className="flex items-center gap-2">
                              <ProviderLogo
                                providerID={group.providerID}
                                name={group.providerName}
                                size="small"
                              />
                              <span className="flex-1">
                                {PROVIDER_LABELS[group.providerID] || group.providerName}
                              </span>
                              <span className="text-muted-foreground/30 text-xs normal-case tracking-normal">
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
                          const modelKey = { providerID: model.providerID, modelID: model.modelID };
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
                  </>
            ) : !autoModel ? (
                  <div className="px-3 py-5 text-center">
                    <div className="text-foreground text-sm font-medium">No models available</div>
                    <p className="text-muted-foreground mx-auto mt-1 max-w-[220px] text-xs leading-5">
                      Upgrade or connect your own provider to start using this session.
                    </p>
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <Button type="button" size="xs" onClick={handleUpgrade}>
                        <CreditCard className="size-3.5" />
                        Upgrade
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => handleOpenProviderModal('providers')}
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
              not in this picker. */}
          <button
            type="button"
            onClick={() => handleOpenProviderModal('models')}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-2 border-t px-4 py-2.5 text-xs font-medium transition-colors duration-200"
          >
            <SlidersHorizontal className="size-3.5 shrink-0" />
            Manage models
          </button>
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}
