'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams } from 'next/navigation';
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Plus,
  SlidersHorizontal,
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
} from '@/components/ui/command';

import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { FlatModel } from './session-chat-input';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/components/providers/provider-branding';
import { ProjectProviderModal } from '@/components/projects/project-provider-modal';

type ProviderModalTab = 'providers' | 'connected' | 'models';

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
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  if (!projectId) return null;

  return (
    <ProjectProviderModal
      projectId={projectId}
      open={open}
      onOpenChange={onOpenChange}
      defaultTab="catalog"
    />
  );
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
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  if (!projectId) return null;

  return (
    <ProjectProviderModal
      projectId={projectId}
      open={open}
      onOpenChange={onOpenChange}
      defaultTab="models"
    />
  );
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Reveal models the "latest" filter hides by default (older releases /
  // superseded models in a family). Off by default to keep the picker tidy.
  const [showHidden, setShowHidden] = useState(false);
  const modelStore = useModelStore(models);

  // When mounted under /projects/[id]/..., route the action buttons to the
  // per-project provider modal so credentials land in `project_secrets`.
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalTab, setProjectModalTab] =
    useState<'connected' | 'catalog' | 'models'>('catalog');

  const current = models.find(
    (m) => m.providerID === selectedModel?.providerID && m.modelID === selectedModel?.modelID,
  );
  const displayName = current?.modelName || models[0]?.modelName || 'Model';

  // Reset search + collapse "older" reveal when closing
  useEffect(() => {
    if (!open) {
      setSearch('');
      setShowHidden(false);
    }
  }, [open]);

  // ── Filtered + grouped models ──

  // Are there any models the "latest" filter is currently hiding? Drives the
  // "Show older models" footer — no point showing it when nothing is hidden.
  const hasHidden = useMemo(
    () => models.some((m) => !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID })),
    [models, modelStore],
  );

  const visibleModels = useMemo(() => {
    const q = search.toLowerCase();
    return models
      .filter((m) => {
        // A search query reveals everything; otherwise respect visibility
        // unless the user expanded the "older models" section.
        if (!q && !showHidden && !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID })) return false;
        return !q || (m.modelName || '').toLowerCase().includes(q) || (m.modelID || '').toLowerCase().includes(q) || (m.providerName || '').toLowerCase().includes(q);
      })
      .sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [models, search, showHidden, modelStore]);

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
    if (!projectId) return;
    // Legacy tabs: 'providers' | 'connected' | 'models'. Map 'providers'
    // (the "add" view in the old modal) to our 'catalog' tab.
    setProjectModalTab(tab === 'providers' ? 'catalog' : tab);
    setProjectModalOpen(true);
  }, [projectId]);

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
              aria-label={tHardcodedUi.raw('componentsSessionModelSelector.line207JsxAttrAriaLabelModelPicker')}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer',
                open && 'bg-muted text-foreground',
              )}
            >
              <span className="truncate max-w-[120px]">{displayName}</span>
              <ChevronDown className={cn('size-3 opacity-50 transition-transform duration-200', open && 'rotate-180')} />
            </button>
          </CommandPopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{tHardcodedUi.raw('componentsSessionModelSelector.line218JsxTextChooseModel')}</TooltipContent>
      </Tooltip>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
        <CommandInput
          compact
          placeholder={tHardcodedUi.raw('componentsSessionModelSelector.line224JsxAttrPlaceholderSearchModels')}
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
                <TooltipContent side="top" className="text-xs">{tHardcodedUi.raw('componentsSessionModelSelector.line239JsxTextConnectProvider')}</TooltipContent>
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
                <TooltipContent side="top" className="text-xs">{tHardcodedUi.raw('componentsSessionModelSelector.line251JsxTextManageModels')}</TooltipContent>
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
                      <span className="flex-1">{PROVIDER_LABELS[group.providerID] || group.providerName}</span>
                      <span className="text-xs text-muted-foreground/30 normal-case tracking-normal">
                        {group.models.length}
                      </span>
                    </div>
                  }
                  forceMount
                >
                  {group.models.map((model) => {
                    const isSelected = selectedModel?.providerID === model.providerID && selectedModel?.modelID === model.modelID;
                    const isFree = model.providerID === 'opencode' && (!model.cost || model.cost.input === 0);
                    const modelKey = { providerID: model.providerID, modelID: model.modelID };
                    // "Latest" models are always shown; older ones get an
                    // activation switch so they can be pinned into the picker.
                    const isLatestModel = modelStore.isLatest(modelKey);
                    const isModelVisible = modelStore.isVisible(modelKey);

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
                          <div className={cn(
                            'truncate text-sm leading-tight',
                            isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground/90',
                          )}>
                            {model.modelName}
                          </div>
                          <p className="truncate text-xs text-muted-foreground/55 leading-snug mt-1">{model.modelID}</p>
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
            <div className="py-8 text-center text-xs text-muted-foreground/50">{tHardcodedUi.raw('componentsSessionModelSelector.line304JsxTextNoModelsFound')}</div>
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
            className="cursor-pointer select-none hover:bg-foreground/[0.04] hover:text-foreground transition-colors"
          >
            {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span>{showHidden ? 'Hide older models' : 'Show older models'}</span>
          </CommandFooter>
        )}
      </CommandPopoverContent>
    </CommandPopover>
    </>
  );
}
