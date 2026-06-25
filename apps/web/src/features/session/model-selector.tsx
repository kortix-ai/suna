'use client';

import { useTranslations } from 'next-intl';

import {
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Eye, EyeOff, Plus, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ProjectProviderModal } from '@/components/projects/project-provider-modal';
import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/features/providers/provider-branding';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { LLM_PROVIDERS } from '@/lib/llm-providers';
import { listProjectSecrets } from '@/lib/projects-client';
import { useGatewayOverlayStore } from '@/stores/gateway-overlay-store';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { AUTO_MODEL_ID, DEFAULT_MANAGED_MODEL_IDS } from '@kortix/shared/llm-catalog';
import { useQuery } from '@tanstack/react-query';
import type { FlatModel } from './session-chat-input';

// Re-export for consumers
export { ConnectProviderContent } from '@/features/providers/connect-provider-content';
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

export function ManageModelsDialog({
  open,
  onOpenChange,
  models: _models,
  modelStore: _modelStore,
  onConnectProvider: _onConnectProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: FlatModel[];
  modelStore: ReturnType<typeof useModelStore>;
  onConnectProvider: () => void;
}) {
  const { openProviderModal, closeProviderModal } = useProviderModalStore();

  useEffect(() => {
    if (open) openProviderModal('models');
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

const SHOW_OPENCODE_ZEN = true;

// `auto` is a synthetic managed entry (not a real upstream model): grouped under
// Kortix and always shown, but rendered as a special "smart routing" affordance.
const MANAGED_MODEL_IDS = new Set<string>([...DEFAULT_MANAGED_MODEL_IDS, AUTO_MODEL_ID]);

// The gateway exposes its whole catalog through a single `kortix` provider, with
// model ids namespaced as `<provider>/<model>`. For the picker we split that
// back out: platform-managed defaults stay under the "Kortix" group, while every
// BYOK model surfaces under its real provider ("Anthropic", "OpenAI", …) — so a
// connected provider reads as its own section, not buried in Kortix.
function pickerGroupId(model: FlatModel): string {
  if (model.providerID !== 'kortix' || MANAGED_MODEL_IDS.has(model.modelID)) {
    return model.providerID;
  }
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}

// ─── ModelSelector ───────────────────────────────────────────────────────────

export interface ModelSelectorProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
}

export function ModelSelector({ models, selectedModel, onSelect }: ModelSelectorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Reveal models the "latest" filter hides by default (older releases /
  // superseded models in a family). Off by default to keep the picker tidy.
  const [showHidden, setShowHidden] = useState(false);
  // When AUTO is on, the manual provider list is hidden by default. This reveals
  // it (so the user can switch to a specific model) without turning AUTO off yet.
  const [expandManual, setExpandManual] = useState(false);
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openGateway = useGatewayOverlayStore((s) => s.openGateway);
  const baseModels = useMemo(
    () => (SHOW_OPENCODE_ZEN ? models : models.filter((m) => m.providerID !== 'opencode')),
    [models],
  );

  // When mounted under /projects/[id]/..., route the action buttons to the
  // per-project provider modal so credentials land in `project_secrets`. On
  // every other route (instance dashboard, /milano, /berlin, etc.) we keep
  // the legacy GlobalProviderModal that writes to the active sandbox.
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalTab, setProjectModalTab] = useState<'connected' | 'catalog' | 'models'>(
    'catalog',
  );
  const [projectModalProviderId, setProjectModalProviderId] = useState<string | undefined>(
    undefined,
  );

  // Track project secrets whenever we're in a project (not only while the picker
  // is open) so connecting/disconnecting a provider flips model visibility live —
  // the connect mutation invalidates this exact key, and an always-subscribed
  // query refetches immediately instead of waiting for the next picker open.
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId,
    staleTime: 10_000,
  });
  const secretNames = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return new Set(items.map((secret: { name: string }) => secret.name));
  }, [secretsQuery.data]);
  const openaiConnected = secretNames.has('OPENAI_API_KEY');

  // Providers whose key(s) are present — drives which of the gateway's full
  // baked catalog is shown by default in the picker (connected providers light
  // up the instant their secret lands; everything else stays search-only).
  const connectedProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of LLM_PROVIDERS) {
      if (provider.envVars.length > 0 && provider.envVars.every((v) => secretNames.has(v))) {
        ids.add(provider.id);
      }
    }
    // ChatGPT subscription (Codex) — its auth is a JSON blob, not an env var, so
    // it isn't in LLM_PROVIDERS. Surface it so codex/* models light up the instant
    // the subscription is connected (same live-reflection as BYOK keys).
    if (secretNames.has('CODEX_AUTH_JSON') || secretNames.has('OPENCODE_AUTH_JSON')) {
      ids.add('codex');
    }
    return ids;
  }, [secretNames]);

  const modelStore = useModelStore(baseModels, { connectedProviderIds });

  const current = models.find(
    (m) => m.providerID === selectedModel?.providerID && m.modelID === selectedModel?.modelID,
  );
  const displayName = current?.modelName || models[0]?.modelName || 'Model';

  // Reset search + collapse "older" reveal when closing
  useEffect(() => {
    if (!open) {
      setSearch('');
      setShowHidden(false);
      setExpandManual(false);
    }
  }, [open]);

  // ── Filtered + grouped models ──

  // Are there any models the "latest" filter is currently hiding? Drives the
  // "Show older models" footer — no point showing it when nothing is hidden.
  const hasHidden = useMemo(
    () =>
      models.some((m) => !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID })),
    [models, modelStore],
  );

  const visibleModels = useMemo(() => {
    const q = search.toLowerCase();
    return models
      .filter((m) => {
        // AUTO is rendered as a standalone toggle above the providers — never
        // inside a provider group.
        if (m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID) return false;
        // A search query reveals everything; otherwise respect visibility
        // unless the user expanded the "older models" section.
        if (
          !q &&
          !showHidden &&
          !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID })
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
  }, [models, search, showHidden, modelStore]);

  const grouped = useMemo(() => {
    const groups = new Map<
      string,
      { providerName: string; providerID: string; models: FlatModel[] }
    >();
    for (const m of visibleModels) {
      const groupID = pickerGroupId(m);
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
  }, [visibleModels]);

  // AUTO lives outside the provider groups — a standalone toggle. When it's on,
  // the manual model list is hidden unless the user expands it.
  const autoModel = useMemo(
    () => baseModels.find((m) => m.providerID === 'kortix' && m.modelID === AUTO_MODEL_ID),
    [baseModels],
  );
  const isAutoSelected =
    selectedModel?.providerID === 'kortix' && selectedModel?.modelID === AUTO_MODEL_ID;
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

  const handleOpenProviderModal = useCallback(
    (tab: ProviderModalTab) => {
      setOpen(false);
      if (projectId) {
        openGateway({ section: tab === 'models' ? 'models' : 'providers' });
        return;
      }
      openProviderModal(tab);
    },
    [projectId, openProviderModal, openGateway],
  );

  const openConnectOpenAI = useCallback(() => {
    setOpen(false);
    if (projectId) {
      openGateway({ section: 'providers' });
      return;
    }
    openProviderModal('providers');
  }, [projectId, openProviderModal, openGateway]);

  return (
    <>
      {projectId && (
        <ProjectProviderModal
          projectId={projectId}
          open={projectModalOpen}
          onOpenChange={setProjectModalOpen}
          defaultTab={projectModalTab}
        />
      )}
      <CommandPopover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CommandPopoverTrigger>
              <button
                type="button"
                aria-label={tHardcodedUi.raw(
                  'componentsSessionModelSelector.line207JsxAttrAriaLabelModelPicker',
                )}
                className={cn(
                  'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-200',
                  open && 'bg-muted text-foreground',
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
          {autoModel && (
            <div className="p-1.5">
              <div
                role="button"
                tabIndex={0}
                onClick={toggleAuto}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleAuto();
                  }
                }}
                className={cn(
                  'group flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-200 select-none',
                  autoOn ? 'bg-primary/[0.07]' : 'hover:bg-foreground/[0.04]',
                )}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-200',
                    autoOn
                      ? 'bg-primary/15 text-primary'
                      : 'bg-foreground/[0.06] text-foreground/70 group-hover:text-foreground',
                  )}
                >
                  <Sparkles className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-[13px] leading-tight font-medium">Auto</div>
                  <p className="text-muted-foreground/70 mt-0.5 text-xs leading-tight">
                    Best model, chosen for each task
                  </p>
                </div>
                <Switch
                  checked={autoOn}
                  onCheckedChange={toggleAuto}
                  tabIndex={-1}
                  className="pointer-events-none shrink-0"
                />
              </div>
            </div>
          )}

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
                  <div className="-mr-1 flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleOpenProviderModal('providers')}
                          className="text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
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
                          onClick={() => handleOpenProviderModal('models')}
                          className="text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
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
                            <span className="flex-1">
                              {PROVIDER_LABELS[group.providerID] || group.providerName}
                            </span>
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

                          // Every opencode (Zen) model is free: it routes natively,
                          // never through the gateway, so kortix never bills it.
                          const isFree = model.providerID === 'opencode';
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
                  <div className="text-muted-foreground/50 py-8 text-center text-xs">
                    {tHardcodedUi.raw('componentsSessionModelSelector.line304JsxTextNoModelsFound')}
                  </div>
                )}
              </CommandList>

              {hasHidden && !search && (
                <CommandFooter
                  role="button"
                  tabIndex={0}
                  onClick={() => setShowHidden((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setShowHidden((v) => !v);
                    }
                  }}
                  className="hover:bg-foreground/[0.04] hover:text-foreground cursor-pointer transition-colors select-none"
                >
                  {showHidden ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                  <span>{showHidden ? 'Hide older models' : 'Show older models'}</span>
                </CommandFooter>
              )}
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
