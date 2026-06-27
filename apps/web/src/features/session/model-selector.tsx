'use client';

import { useTranslations } from 'next-intl';

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
import { Check, ChevronDown, Plus, SlidersHorizontal } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/features/providers/provider-branding';
import { connectedGatewayProviderIdsFromSecretNames } from '@/hooks/opencode/provider-selection';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { listProjectSecrets } from '@/lib/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { AUTO_MODEL_ID, DEFAULT_MANAGED_MODEL_IDS } from '@kortix/shared/llm-catalog';
import { useQuery } from '@tanstack/react-query';
import { AutoModelToggle } from './auto-model-toggle';
import { shouldShowFreeTag } from './model-tags';
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

// Import from canonical UI component and re-export for consumers
import { Tag } from '@/components/ui/tag';

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
  // When AUTO is on, the manual provider list is hidden by default. This reveals
  // it (so the user can switch to a specific model) without turning AUTO off yet.
  const [expandManual, setExpandManual] = useState(false);
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openCustomize = useCustomizeStore((s) => s.openCustomize);

  // When mounted under /projects/[id]/..., route the action buttons to the
  // per-project provider modal so credentials land in `project_secrets`. On
  // every other route (instance dashboard, /milano, /berlin, etc.) we keep
  // the legacy GlobalProviderModal that writes to the active sandbox.
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  // opencode-native: the model list already reconciles the always-on managed
  // `kortix` catalog + every connected BYOK provider (see flattenModels), so the
  // picker renders it verbatim — no gateway/native fork, nothing to strip.
  const baseModels = models;

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
  // Connected subscriptions (notably ChatGPT/codex) — gates the ChatGPT models
  // the managed `kortix` provider serves under `codex/<id>` so they only show
  // once the subscription is linked. BYOK providers list natively now, so this
  // no longer needs to gate them.
  const connectedProviderIds = useMemo(
    () => connectedGatewayProviderIdsFromSecretNames(secretNames),
    [secretNames],
  );

  const modelStore = useModelStore(baseModels, {
    connectedProviderIds,
  });

  const current = baseModels.find(
    (m) => m.providerID === selectedModel?.providerID && m.modelID === selectedModel?.modelID,
  );
  const displayName = current?.modelName || baseModels[0]?.modelName || 'Model';

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
      // Managed models stay under "Kortix"; ChatGPT (codex/<id>) splits into its
      // own group; native BYOK providers group by their real id.
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
  // the manual model list is hidden unless the user expands it. It's the managed
  // smart-router (`kortix/auto`), always present in the managed catalog.
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
      // In a project, the BYOK connect surface is the Providers customize panel
      // (providers-view). Elsewhere (dashboard / instance), fall back to the
      // global provider modal.
      if (projectId) {
        openCustomize('llm-providers');
        return;
      }
      openProviderModal(tab);
    },
    [projectId, openProviderModal, openCustomize],
  );

  return (
    <>
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
