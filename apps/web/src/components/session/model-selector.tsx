'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Check,
  ChevronDown,
  Plus,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  CommandPopover,
  CommandPopoverTrigger,
  CommandPopoverContent,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandFooter,
  CommandKbd,
} from '@/components/ui/command';

import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { FlatModel } from './session-chat-input';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/components/providers/provider-branding';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import type { ProviderModalTab } from '@/stores/provider-modal-store';

// Re-export for consumers
export { ConnectProviderContent } from '@/components/providers/connect-provider-content';

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
export { Tag };

// ─── ModelSelector ───────────────────────────────────────────────────────────

export interface ModelSelectorProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
}

export function ModelSelector({ models, selectedModel, onSelect }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const modelStore = useModelStore(models);

  const current = models.find(
    (m) => m.providerID === selectedModel?.providerID && m.modelID === selectedModel?.modelID,
  );
  const displayName = current?.modelName || models[0]?.modelName || 'Model';

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  // ── Filtered + grouped models ──

  const visibleModels = useMemo(() => {
    const q = search.toLowerCase();
    return models
      .filter((m) => {
        if (!q && !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID })) return false;
        return !q || (m.modelName || '').toLowerCase().includes(q) || (m.modelID || '').toLowerCase().includes(q) || (m.providerName || '').toLowerCase().includes(q);
      })
      .sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [models, search, modelStore]);

  const grouped = useMemo(() => {
    const groups = new Map<string, { providerName: string; providerID: string; models: FlatModel[] }>();
    for (const m of visibleModels) {
      const existing = groups.get(m.providerID);
      if (existing) {
        existing.models.push(m);
      } else {
        groups.set(m.providerID, { providerID: m.providerID, providerName: PROVIDER_LABELS[m.providerID] || m.providerName, models: [m] });
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

  // ── Handlers ──

  const handleSelect = useCallback(
    (model: FlatModel) => {
      onSelect({ providerID: model.providerID, modelID: model.modelID });
      setOpen(false);
    },
    [onSelect],
  );

  const handleOpenProviderModal = useCallback((tab: ProviderModalTab) => {
    setOpen(false);
    openProviderModal(tab);
  }, [openProviderModal]);

  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CommandPopoverTrigger>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer',
                open && 'bg-muted text-foreground',
              )}
            >
              <span className="truncate max-w-[120px]">{displayName}</span>
              <ChevronDown className={cn('size-3 opacity-50 transition-transform duration-200', open && 'rotate-180')} />
            </button>
          </CommandPopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">Choose model</TooltipContent>
      </Tooltip>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[340px]">
        <CommandInput
          compact
          placeholder="Search models..."
          value={search}
          onValueChange={setSearch}
          rightElement={
            <div className="flex items-center gap-0.5 -mr-1 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleOpenProviderModal('providers')}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Connect provider</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleOpenProviderModal('models')}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Manage models</TooltipContent>
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
                      <ProviderLogo providerID={group.providerID} name={group.providerName} size="small" />
                      <span>{PROVIDER_LABELS[group.providerID] || group.providerName}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground/30 normal-case tracking-normal">
                        {group.models.length}
                      </span>
                    </div>
                  }
                  forceMount
                >
                  {group.models.map((model) => {
                    const isSelected = selectedModel?.providerID === model.providerID && selectedModel?.modelID === model.modelID;
                    const isFree = model.providerID === 'opencode' && (!model.cost || model.cost.input === 0);

                    return (
                      <CommandItem
                        key={`${model.providerID}:${model.modelID}`}
                        value={`model-${model.providerID}-${model.modelID}`}
                        onSelect={() => handleSelect(model)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-[13px]">{model.modelName}</div>
                          <div className="text-[11px] text-muted-foreground/50 truncate mt-0.5">{model.modelID}</div>
                        </div>
                        {isFree && <Tag variant="free">Free</Tag>}
                        {isSelected && <Check className="h-3.5 w-3.5 text-foreground flex-shrink-0" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </>
          ) : (
            <div className="py-8 text-center text-xs text-muted-foreground/50">
              No models found
            </div>
          )}
        </CommandList>

        <CommandFooter>
          <div className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3" />
            <ArrowDown className="h-3 w-3" />
            <span>navigate</span>
          </div>
          <div className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            <span>select</span>
          </div>
          <div className="flex items-center gap-1">
            <CommandKbd>esc</CommandKbd>
            <span>close</span>
          </div>
        </CommandFooter>
      </CommandPopoverContent>
    </CommandPopover>
  );
}
