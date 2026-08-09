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
import Loading from '@/components/ui/loading';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
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
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '@/features/providers/provider-branding';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, modelKeyToWire, qk, type ProviderListResponse } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { resolveAvailableSelectedModel } from './model-availability';
import { pickerGroupId, pickerGroupLabel } from './model-grouping';
import { computeModelExtrasRows } from './model-popover-extras';
import { shouldShowFreeTag } from './model-tags';
import { reasoningEffortValuesFor, useReasoningEffortControl } from './reasoning-effort-selector';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

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

// ─── ModelSelector ───────────────────────────────────────────────────────────

type ModelRef = { providerID: string; modelID: string };

// Optional "set this model as a default" controls. When provided, the picker
// shows a footer to pin the selected model as the account default (and, when an
// agent is active, that agent's default). These persist server-side. Omitted in
// non-session pickers.
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
  /** True while the runtime provider catalog request has not resolved. */
  modelsLoading?: boolean;
  /** Overrides the trigger label's `max-w-[120px]` (twMerge picks the last
   *  conflicting utility, so this cleanly replaces rather than stacks).
   *  Composer passes `max-w-[7rem]` so a long model name can't widen the
   *  toolbar row; every other call site leaves this unset and keeps the
   *  120px default unchanged. */
  triggerLabelClassName?: string;

  /**
   * Variant (thinking-mode) and reasoning-effort controls, folded into the
   * popover below the model list (Task 10) instead of sitting inline in the
   * composer toolbar. All optional — every non-composer call site (schedules,
   * gateway playground/routing/view, channels, agent detail/editor) omits
   * them, so the extras section renders nothing and their layout is
   * unchanged. See `computeModelExtrasRows` for the exact show/hide rule.
   */
  variants?: string[];
  selectedVariant?: string | null;
  onVariantChange?: (variant: string | null) => void;
  /** Scopes the reasoning-effort control to a project's routing policy —
   *  same meaning as `ReasoningEffortSelector`'s `projectId`. */
  projectId?: string;
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
  // Aliased: this component ALSO derives a `projectId` internally from the
  // route (`params.id`, below) for gateway catalog filtering — a different
  // concept (which catalog to show) from this prop (which project's routing
  // policy the reasoning-effort control reads/writes). Keep them distinct
  // rather than quietly conflating "current route project" with "project
  // this picker was told to scope reasoning effort to".
  projectId: extrasProjectId,
}: ModelSelectorProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Where Upgrade / Connect provider should route, given the current route
  // context — shared with the chat input's full-block gate and onboarding so
  // they all open the exact same dialogs.
  const {
    openConnectProvider,
    openUpgrade,
    modal: connectionModal,
    entitlementsPending,
    isSelectableModel,
    showUpgradeOption,
  } = useModelConnectionGate(models);

  // When mounted under /projects/[id]/..., route model filtering to the
  // per-project gateway catalog. On every other route (instance dashboard,
  // /milano, /berlin, etc.) we filter to native (non-gateway) models.
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

  // NOTE: the picker deliberately derives NO availability of its own. Which
  // models a project can call (connected BYOK providers, plan entitlement) and
  // which of those it offers are both resolved server-side by `/model-picker`
  // — the route this list already comes from. Re-deriving either here from
  // project secrets + account tier is what let this view disagree with both
  // the "Manage models" tab and the gateway.

  const availableSelectedModel = entitlementsPending
    ? selectedModel
    : resolveAvailableSelectedModel(selectedModel, isSelectableModel);
  const current = baseModels.find(
    (m) =>
      m.providerID === availableSelectedModel?.providerID &&
      m.modelID === availableSelectedModel?.modelID,
  );
  const displayName = current?.modelName || unsetLabel;

  // Extras section (variant + reasoning effort) — show/hide is a pure
  // function of what the caller wired up, so the 8 non-composer call sites
  // (which pass none of this) are provably unaffected. `reasoningEffortValuesFor`
  // is the SAME capability-gate function `ReasoningEffortSelector` uses —
  // reused, not re-derived, so a model's effort ladder can never disagree
  // between the two.
  const wireModel = availableSelectedModel ? modelKeyToWire(availableSelectedModel) : undefined;
  const reasoningEffortValues = useMemo(() => reasoningEffortValuesFor(wireModel), [wireModel]);
  const extrasRows = computeModelExtrasRows({
    variants,
    hasVariantHandler: !!onVariantChange,
    reasoningEffortValues,
    hasProjectId: !!extrasProjectId,
  });

  // Reset transient picker state when closing.
  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  // ── Filtered + grouped models ──

  // The list is exactly what the project OFFERS. `enabled` is resolved by the
  // server (`/model-picker`), so the picker applies no visibility rule of its
  // own — a second, client-only filter here is precisely what made "Manage
  // models" report 15 of 15 shown while this rendered 3. Turn a model on in
  // "Manage models" and it appears here; there is nothing else to check.
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
                <span className={cn('max-w-[120px] truncate', triggerLabelClassName)}>
                  {displayName}
                </span>
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
                {extrasRows.showReasoningEffortRow && (
                  <ModelPopoverReasoningEffortRow
                    model={availableSelectedModel}
                    projectId={extrasProjectId}
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

// ─── Model popover extras (variant + reasoning effort) ──────────────────────
//
// Both rows render as a flat chip list rather than reusing the standalone
// `VariantSelector` (a single cycling button) or `ReasoningEffortSelector`
// (its own `CommandPopover`) verbatim. Nesting a second Radix `Popover`
// inside this already-open one is fragile — the child's portaled content
// sits outside the parent's content subtree, so the parent's outside-click
// dismissal can treat a click inside the child as "outside" and close both.
// A flat row sidesteps that entirely and reads better in a footer anyway.
// Neither standalone component is modified: this reuses their exported pure
// logic (`reasoningEffortValuesFor`, `useReasoningEffortControl`) directly,
// so `reasoning-effort-selector.tsx`'s gating predicate is untouched and its
// own tests keep covering it unchanged.

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

function ModelPopoverReasoningEffortRow({
  model,
  projectId,
}: {
  model: ModelRef;
  projectId: string | undefined;
}) {
  const { values, current, canWrite, pending, wireModel, setEffort } = useReasoningEffortControl(
    model,
    projectId,
  );
  const locked = !canWrite;

  return (
    <div className="flex flex-col gap-1">
      <span className={extrasRowLabel}>Reasoning effort</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex flex-wrap gap-1 px-1">
            <button
              type="button"
              disabled={locked || pending}
              onClick={() => setEffort(null)}
              className={cn(
                extrasChipBase,
                current === null && extrasChipSelected,
                (locked || pending) && extrasChipLocked,
              )}
            >
              Auto
            </button>
            {values.map((value) => (
              <button
                key={value}
                type="button"
                disabled={locked || pending}
                onClick={() => setEffort(value)}
                className={cn(
                  extrasChipBase,
                  current === value && extrasChipSelected,
                  (locked || pending) && extrasChipLocked,
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px]">
          {locked ? (
            <p>Only project editors can change reasoning effort for this model.</p>
          ) : (
            <p>
              Reasoning effort for <span className="font-mono">{wireModel}</span> — applies to
              every session in this project using this model.
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
