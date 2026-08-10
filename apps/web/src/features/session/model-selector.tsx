'use client';

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
import Loading from '@/components/ui/loading';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '@/features/providers/provider-branding';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { cn } from '@/lib/utils';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, modelKeyToWire, qk, type ProviderListResponse } from '@kortix/sdk/react';
import {
  RobotIcon as Bot,
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CreditCardIcon as CreditCard,
  GitBranchIcon as FolderGit2,
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  SlidersHorizontalIcon as SlidersHorizontal,
  StarIcon as Star,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveAvailableSelectedModel } from './model-availability';
import { pickerGroupId, pickerGroupLabel } from './model-grouping';
import { computeModelExtrasRows } from './model-popover-extras';
import { shouldShowFreeTag } from './model-tags';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

export { ConnectProviderContent } from '@/features/providers/connect-provider-content';
export { Tag };

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

import Hint from '@/components/ui/hint';
import { Tag } from '@/components/ui/tag';

type ModelRef = { providerID: string; modelID: string };

export interface ModelDefaultControls {
  agentName?: string;
  onSetAccountDefault: (model: ModelRef) => void;
  onSetAgentDefault?: (model: ModelRef) => void;
  onSetProjectDefault?: (model: ModelRef) => void;
}

export interface ModelSelectorProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  defaultControls?: ModelDefaultControls;
  unsetLabel?: string;
  disabled?: boolean;
  modelsLoading?: boolean;
  triggerLabelClassName?: string;

  variants?: string[];
  selectedVariant?: string | null;
  onVariantChange?: (variant: string | null) => void;
  projectId?: string;

  /**
   * Controlled open state. Omit for the normal case — the trigger owns its
   * own popover and nothing changes.
   *
   * This exists so the composer's `/` palette can open this popover for its
   * "Switch model" row (`composer.tsx`'s `handleSelectAction`). That row
   * previously did nothing at all: the menu closed, the editor refocused, and
   * the picker stayed shut, because this component's `open` was internal
   * state with no way in.
   *
   * "Set reasoning effort" no longer routes here — it opens
   * `ReasoningEffortSelector` in the toolbar instead.
   *
   * Controlled/uncontrolled is decided by whether `open` is `undefined`, the
   * same rule Radix itself uses — so every existing call site keeps its
   * internal state untouched.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ModelSelector({
  models,
  selectedModel,
  onSelect,
  defaultControls,
  unsetLabel = 'No model',
  disabled = false,
  modelsLoading = false,
  triggerLabelClassName,
  variants = [],
  selectedVariant = null,
  onVariantChange,
  projectId: extrasProjectId,
  open: openProp,
  onOpenChange,
}: ModelSelectorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  // Controlled when `open` is supplied, uncontrolled otherwise — Radix's own
  // rule. `setOpen` below is the single write path every internal caller
  // already goes through (`setOpen(false)` after picking a model or a
  // default), so a controlled parent hears about those closes too rather than
  // being silently desynced from a popover that shut itself.
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

  const [search, setSearch] = useState('');
  const {
    openConnectProvider,
    openUpgrade,
    modal: connectionModal,
    entitlementsPending,
    isSelectableModel,
    showUpgradeOption,
  } = useModelConnectionGate(models);

  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);
  const baseModels = useMemo(() => {
    return llmGatewayEnabled ? models : models.filter((m) => m.providerID !== 'kortix');
  }, [models, llmGatewayEnabled]);

  const availableSelectedModel = entitlementsPending
    ? selectedModel
    : resolveAvailableSelectedModel(selectedModel, isSelectableModel);
  const current = baseModels.find(
    (m) =>
      m.providerID === availableSelectedModel?.providerID &&
      m.modelID === availableSelectedModel?.modelID,
  );
  const displayName = current?.modelName || unsetLabel;

  const extrasRows = computeModelExtrasRows({
    variants,
    hasVariantHandler: !!onVariantChange,
  });

  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  const visibleModels = useMemo(() => {
    const q = search.toLowerCase();
    return baseModels
      .filter(
        (m) =>
          m.enabled !== false &&
          (!q ||
            (m.modelName || '').toLowerCase().includes(q) ||
            (m.modelID || '').toLowerCase().includes(q) ||
            (m.providerName || '').toLowerCase().includes(q)),
      )
      .sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [baseModels, search]);

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

  const handleSelect = useCallback(
    (model: FlatModel) => {
      onSelect({ providerID: model.providerID, modelID: model.modelID });
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  const handleOpenProviderModal = useCallback(
    (tab: ProviderModalTab) => {
      setOpen(false);
      openConnectProvider(tab);
    },
    [openConnectProvider, setOpen],
  );

  const handleUpgrade = useCallback(() => {
    setOpen(false);
    openUpgrade();
  }, [openUpgrade, setOpen]);

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
        >
          <CommandPopoverTrigger>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground/70 rounded-full"
            >
              <span className={cn('max-w-30 truncate', triggerLabelClassName)}>
                {displayName}
              </span>
              <ChevronDown className={cn('size-3', open && 'rotate-180')} />
            </Button>
          </CommandPopoverTrigger>
        </Hint>

        <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
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
                        onClick={() => handleOpenProviderModal('providers')}
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
                        onClick={() => handleOpenProviderModal('models')}
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
              {modelsLoading || entitlementsPending ? (
                <div
                  className="flex min-h-32 items-center justify-center"
                  role="status"
                  aria-label="Loading models"
                >
                  <Loading className="text-muted-foreground size-4 shrink-0" />
                </div>
              ) : grouped.length > 0 ? (
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
                          availableSelectedModel?.providerID === model.providerID &&
                          availableSelectedModel?.modelID === model.modelID;

                        const isFree = shouldShowFreeTag(model);
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
                            className={cn('!pl-3', isSelected && 'bg-foreground/[0.06]')}
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
                      onClick={() => handleOpenProviderModal('providers')}
                    >
                      <KeyRound className="size-3.5" />
                      Connect provider
                    </Button>
                  </div>
                </div>
              )}
            </CommandList>
            {extrasRows.showSection && availableSelectedModel ? (
              <div className="border-border/60 flex flex-col gap-2 border-t p-2">
                {extrasRows.showVariantRow && (
                  <ModelPopoverVariantRow
                    variants={variants}
                    selectedVariant={selectedVariant}
                    onSelect={onVariantChange!}
                  />
                )}
              </div>
            ) : null}
            {defaultControls && availableSelectedModel ? (
              <div className="border-border/60 flex flex-col gap-0.5 border-t p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    defaultControls.onSetAccountDefault(availableSelectedModel);
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
                      defaultControls.onSetProjectDefault?.(availableSelectedModel);
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
                      defaultControls.onSetAgentDefault?.(availableSelectedModel);
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
          </>
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}

// ─── Model popover extras (variant) ─────────────────────────────────────────
//
// The variant row renders as a flat chip list rather than nesting a second
// Radix `Popover` inside this already-open one — that pattern is fragile: the
// child's portaled content sits outside the parent's content subtree, so the
// parent's outside-click dismissal can treat a click inside the child as
// "outside" and close both. A flat row sidesteps that entirely.
//
// Reasoning effort used to be the second row here. It is now its own toolbar
// control (`reasoning-effort-selector.tsx`'s `ReasoningEffortSelector`) — a
// per-PROJECT setting does not belong folded inside a per-message picker,
// where it was two clicks deep and invisible at rest. Do not fold it back in.

const extrasChipBase =
  'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2.5 text-[11px] font-medium capitalize transition-colors duration-200';
const extrasChipSelected = 'bg-foreground/[0.06] text-foreground';
const extrasChipLocked =
  'hover:text-muted-foreground pointer-events-none cursor-not-allowed opacity-60 hover:bg-transparent';
const extrasRowLabel =
  'text-muted-foreground/60 px-1 text-[10px] font-semibold tracking-wide uppercase';

function ModelPopoverVariantRow({
  variants,
  selectedVariant,
  onSelect,
}: {
  variants: string[];
  selectedVariant: string | null;
  onSelect: (variant: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={extrasRowLabel}>Thinking mode</span>
      <div className="flex flex-wrap gap-1 px-1">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(extrasChipBase, !selectedVariant && extrasChipSelected)}
        >
          Default
        </button>
        {variants.map((variant) => (
          <button
            key={variant}
            type="button"
            onClick={() => onSelect(variant)}
            className={cn(extrasChipBase, selectedVariant === variant && extrasChipSelected)}
          >
            {variant}
          </button>
        ))}
      </div>
    </div>
  );
}

