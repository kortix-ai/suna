'use client';

import { useTranslations } from 'next-intl';

import type { FlatModel } from '@/components/session/session-chat-input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { ConnectProviderContent } from '@/features/providers/connect-provider-content';
import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/features/providers/provider-branding';
import { ProviderRowContent } from '@/features/providers/provider-card';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { opencodeKeys, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { getClient } from '@/lib/opencode-sdk';
import { cn } from '@/lib/utils';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Search, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type { ProviderModalTab };

type Provider = NonNullable<ProviderListResponse['all']>[number];
type ActiveTab = 'connected' | 'catalog' | 'models';

// ─── Connected tab ──────────────────────────────────────────────────────────

function ConnectedTabBody({
  connectedProviders,
  search,
  onDisconnected,
  onAddProvider,
}: {
  connectedProviders: Provider[];
  search: string;
  onDisconnected?: () => void;
  onAddProvider: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connectedProviders;
    return connectedProviders.filter((p) => {
      const label = (PROVIDER_LABELS[p.id] || p.name || p.id).toLowerCase();
      return label.includes(q) || p.id.toLowerCase().includes(q);
    });
  }, [connectedProviders, search]);

  const doDisconnect = useCallback(
    async (providerID: string) => {
      setDisconnecting(providerID);
      setConfirmDisconnect(null);
      try {
        const client = getClient();
        try {
          await client.auth.remove({ providerID });
        } catch (err) {
          const isEndpointMissing =
            err instanceof Error &&
            (err.message.includes('404') ||
              err.message.includes('405') ||
              err.message.includes('Not Found') ||
              err.message.includes('Method Not Allowed'));
          if (isEndpointMissing) {
            await client.auth.set({ providerID, auth: { type: 'api', key: '' } });
          } else {
            throw err;
          }
        }
        await client.global.dispose();
        await queryClient.refetchQueries({ queryKey: opencodeKeys.providers() });
        successToast(`${PROVIDER_LABELS[providerID] || providerID} disconnected`);
        onDisconnected?.();
      } catch {
        errorToast('Failed to disconnect provider');
      } finally {
        setDisconnecting(null);
      }
    },
    [onDisconnected, queryClient],
  );

  if (connectedProviders.length === 0) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw(
            'componentsProvidersProviderModal.line118JsxTextNoProvidersConnectedYet',
          )}
        </p>
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={onAddProvider}>
          {tHardcodedUi.raw('componentsProvidersProviderModal.line126JsxTextAddProvider')}
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw(
            'componentsProvidersProviderModal.line136JsxTextNoConnectedProvidersMatchLdquo',
          )}
          {search}
          {tHardcodedUi.raw('componentsProvidersProviderModal.line136JsxTextRdquo')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-3 pt-3 pb-4">
      {filtered.map((provider) => {
        const modelCount = Object.keys(provider.models ?? {}).length;
        const isDisconnecting = disconnecting === provider.id;
        const source = (provider as { source?: string }).source;
        return (
          <div
            key={provider.id}
            className="group border-border/50 bg-muted/20 hover:bg-muted/35 flex h-auto w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors"
          >
            <ProviderRowContent
              providerID={provider.id}
              name={PROVIDER_LABELS[provider.id] || provider.name || provider.id}
              connected
              description={
                <>
                  {modelCount} model{modelCount === 1 ? '' : 's'}
                  {source ? ` · ${source}` : ''}
                </>
              }
              rightSlot={
                provider.id === 'kortix' ? (
                  <Badge size="sm" variant="secondary" className="ml-auto shrink-0">
                    Managed
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    onClick={() => setConfirmDisconnect(provider.id)}
                    disabled={isDisconnecting}
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive ml-auto shrink-0"
                    title="Disconnect"
                  >
                    {isDisconnecting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Unplug className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )
              }
            />
          </div>
        );
      })}

      <AlertDialog
        open={!!confirmDisconnect}
        onOpenChange={(open) => !open && setConfirmDisconnect(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tHardcodedUi.raw(
                'componentsProvidersProviderModal.line191JsxTextDisconnectProvider',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmDisconnect && (
                <>
                  Remove{' '}
                  <span className="text-foreground font-medium">
                    {PROVIDER_LABELS[confirmDisconnect] || confirmDisconnect}
                  </span>
                  {tHardcodedUi.raw(
                    'componentsProvidersProviderModal.line199JsxTextYouAposLlNeedToReconnectItTo',
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDisconnect && doDisconnect(confirmDisconnect)}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Models tab ─────────────────────────────────────────────────────────────

/** "1M ctx" / "256K ctx" — compact context-window label for a model row. */
function formatContext(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M ctx`;
  }
  return `${Math.round(tokens / 1000)}K ctx`;
}

function ModelsTabBody({
  models,
  modelStore,
  search,
}: {
  models: FlatModel[];
  modelStore: ReturnType<typeof useModelStore>;
  search: string;
}) {
  const enabledCount = useMemo(
    () =>
      models.filter((m) => modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID }))
        .length,
    [models, modelStore],
  );
  const hasOverrides = modelStore.userPrefs.length > 0;

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = models.filter(
      (m) =>
        !q ||
        m.modelName.toLowerCase().includes(q) ||
        m.modelID.toLowerCase().includes(q) ||
        m.providerName.toLowerCase().includes(q) ||
        (PROVIDER_LABELS[m.providerID] || '').toLowerCase().includes(q),
    );
    const groups = new Map<string, FlatModel[]>();
    for (const m of filtered) {
      const list = groups.get(m.providerID) || [];
      list.push(m);
      groups.set(m.providerID, list);
    }
    const entries = Array.from(groups.entries());
    entries.sort((a, b) => {
      const ai = MODEL_SELECTOR_PROVIDER_IDS.indexOf(a[0]);
      const bi = MODEL_SELECTOR_PROVIDER_IDS.indexOf(b[0]);
      if (ai >= 0 && bi < 0) return -1;
      if (ai < 0 && bi >= 0) return 1;
      if (ai >= 0 && bi >= 0) return ai - bi;
      return a[0].localeCompare(b[0]);
    });
    return entries.map(
      ([id, list]) => [id, list.sort((a, b) => a.modelName.localeCompare(b.modelName))] as const,
    );
  }, [models, search]);

  if (grouped.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-muted-foreground/60 text-xs">
          {search ? `No models match "${search}"` : 'No models'}
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 pt-3 pb-4">
      {!search && (
        <div className="flex items-center justify-between gap-3 px-1 pb-2.5">
          <p className="text-muted-foreground/60 text-xs">
            {enabledCount} of {models.length} shown in the model picker
          </p>
          {hasOverrides && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-7 shrink-0 px-2 text-xs"
              onClick={() => modelStore.resetVisibility()}
            >
              Reset to defaults
            </Button>
          )}
        </div>
      )}
      <div className="space-y-3">
        {grouped.map(([providerID, list]) => (
          <div key={providerID}>
            <div className="flex items-center gap-2 px-1 pb-1">
              <ProviderLogo
                providerID={providerID}
                name={list[0]?.providerName || providerID}
                size="small"
              />
              <span className="text-foreground/70 text-xs font-medium">
                {PROVIDER_LABELS[providerID] || list[0]?.providerName || providerID}
              </span>
              <span className="text-muted-foreground/40 ml-auto text-xs">{list.length}</span>
            </div>
            <div className="border-border/40 bg-background/40 overflow-hidden rounded-2xl border">
              {list.map((m, i) => {
                const key = { providerID: m.providerID, modelID: m.modelID };
                const visible = modelStore.isVisible(key);
                const ctx = formatContext(m.contextWindow);
                return (
                  <label
                    key={`${m.providerID}:${m.modelID}`}
                    className={cn(
                      'hover:bg-muted/30 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors',
                      i > 0 && 'border-border/20 border-t',
                      !visible && 'opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm">{m.modelName}</span>
                        {m.capabilities?.reasoning && (
                          <Badge size="sm" variant="outline" className="shrink-0">
                            Reasoning
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground/50 mt-0.5 flex items-center gap-1.5 truncate text-xs">
                        <span className="truncate">{m.modelID}</span>
                        {ctx && <span className="shrink-0">· {ctx}</span>}
                      </div>
                    </div>
                    <Switch
                      checked={visible}
                      onCheckedChange={(c) => modelStore.setVisibility(key, c)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ProviderModal ──────────────────────────────────────────────────────────

export interface ProviderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: ProviderModalTab;
  providers: ProviderListResponse | undefined;
  models?: FlatModel[];
  onProviderConnected?: () => void;
}

function mapInitialTab(
  defaultTab: ProviderModalTab | undefined,
  hasConnections: boolean,
): ActiveTab {
  if (defaultTab === 'providers') return 'catalog';
  if (defaultTab === 'connected') return hasConnections ? 'connected' : 'catalog';
  if (defaultTab === 'models') return hasConnections ? 'models' : 'catalog';
  return hasConnections ? 'connected' : 'catalog';
}

export function ProviderModal({
  open,
  onOpenChange,
  defaultTab = 'providers',
  providers: providersProp,
  models,
  onProviderConnected,
}: ProviderModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: fetchedProviders } = useOpenCodeProviders();
  const providers = providersProp ?? fetchedProviders;

  const connectedProviders = useMemo(() => {
    if (!providers) return [];
    const connectedIds = new Set(providers.connected ?? []);
    return (providers.all ?? []).filter((provider) => connectedIds.has(provider.id));
  }, [providers]);

  const hasConnections = connectedProviders.length > 0;

  const [activeTab, setActiveTab] = useState<ActiveTab>(() =>
    mapInitialTab(defaultTab, hasConnections),
  );
  const [search, setSearch] = useState('');
  const [catalogSubview, setCatalogSubview] = useState<'list' | 'connect' | 'custom'>('list');

  // Reset on open
  useEffect(() => {
    if (open) {
      setActiveTab(mapInitialTab(defaultTab, hasConnections));
      setSearch('');
      setCatalogSubview('list');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTab]);

  const modelStore = useModelStore(models ?? []);
  const hasModels = !!models?.length;

  const visibleModelCount = useMemo(() => {
    if (!hasModels) return 0;
    return models!.filter((m) =>
      modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID }),
    ).length;
  }, [models, modelStore, hasModels]);

  const inSubflow = activeTab === 'catalog' && catalogSubview !== 'list';

  // Switch tabs from catalog sub-flow — return catalog to list view first so
  // re-entry doesn't drop the user back into a stale connect form.
  const switchTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    setSearch('');
  }, []);

  const searchPlaceholder =
    activeTab === 'connected'
      ? 'Search connected providers...'
      : activeTab === 'models'
        ? 'Search models...'
        : 'Search providers...';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!grid h-[min(80vh,680px)] w-[calc(100vw-2rem)] max-w-[600px] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-0.5 px-5 pt-5 pr-12 pb-3">
          <DialogTitle className="text-sm font-semibold">
            {tHardcodedUi.raw('componentsProvidersProviderModal.line413JsxTextLlmProviders')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground/60 text-xs">
            {tHardcodedUi.raw(
              'componentsProvidersProviderModal.line415JsxTextConnectProvidersAndManageWhichModelsAppearIn',
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar — pills on the left, search input on the right, same row.
            Both at h-9 so they line up. Hidden in connect/custom sub-flow so
            the form takes over cleanly. */}
        {!inSubflow && (
          <div className="box-content flex h-9 items-center gap-3 px-5 pb-3">
            <FilterBar>
              <FilterBarItem
                data-state={activeTab === 'connected' ? 'active' : 'inactive'}
                onClick={() => switchTab('connected')}
                className="text-xs data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                Connected
                {connectedProviders.length > 0 && (
                  <span className="text-muted-foreground/40 ml-0.5 text-xs tabular-nums">
                    {connectedProviders.length}
                  </span>
                )}
              </FilterBarItem>
              <FilterBarItem
                data-state={activeTab === 'catalog' ? 'active' : 'inactive'}
                onClick={() => switchTab('catalog')}
                className="text-xs data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                {tHardcodedUi.raw('componentsProvidersProviderModal.line442JsxTextAddProvider')}
              </FilterBarItem>
              <FilterBarItem
                data-state={activeTab === 'models' ? 'active' : 'inactive'}
                onClick={() => switchTab('models')}
                className="text-xs data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                Models
                {hasModels && (
                  <span className="text-muted-foreground/40 ml-0.5 text-xs tabular-nums">
                    {visibleModelCount}/{models!.length}
                  </span>
                )}
              </FilterBarItem>
            </FilterBar>

            <div className="relative ml-auto h-9 w-72 shrink-0">
              <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border-border/50 bg-muted/20 focus-visible:ring-ring/40 h-9 rounded-xl pl-9 text-sm shadow-none focus-visible:ring-1"
              />
            </div>
          </div>
        )}

        {/* Body */}
        <div className="min-h-0 overflow-y-auto">
          {/* Catalog: ConnectProviderContent stays mounted so its sub-flow
              state survives tab switches. Hidden when another tab is active. */}
          <div className={cn(activeTab !== 'catalog' && 'hidden')}>
            <ConnectProviderContent
              providers={providers}
              searchValue={search}
              onSubviewChange={setCatalogSubview}
              onProviderConnected={onProviderConnected}
            />
          </div>

          {activeTab === 'connected' && (
            <ConnectedTabBody
              connectedProviders={connectedProviders}
              search={search}
              onDisconnected={onProviderConnected}
              onAddProvider={() => switchTab('catalog')}
            />
          )}

          {activeTab === 'models' && hasModels && (
            <ModelsTabBody models={models!} modelStore={modelStore} search={search} />
          )}

          {activeTab === 'models' && !hasModels && (
            <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
              <p className="text-muted-foreground/60 text-xs">
                {tHardcodedUi.raw(
                  'componentsProvidersProviderModal.line505JsxTextConnectAProviderToSeeItsModels',
                )}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Global Provider Modal ───────────────────────────────────────────────────

export function GlobalProviderModal() {
  const { isOpen, defaultTab, closeProviderModal } = useProviderModalStore();
  const { data: providers } = useOpenCodeProviders();

  const models = useMemo(() => {
    if (!providers) return [];
    const connectedIds = new Set(providers.connected ?? []);
    // If kortix provider is connected, it serves all models — hide redundant
    // built-in providers so users see a clean Kortix-only model list.
    const KORTIX_SUPERSEDED = [
      'anthropic',
      'openai',
      'google',
      'xai',
      'moonshotai',
      'minimax',
      'zhipuai',
    ];
    const kortixConnected = connectedIds.has('kortix');
    const result: FlatModel[] = [];
    for (const provider of providers.all ?? []) {
      if (!connectedIds.has(provider.id)) continue;
      if (kortixConnected && KORTIX_SUPERSEDED.includes(provider.id)) continue;
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const caps = (model as any).capabilities;
        const modalities = (model as any).modalities;
        result.push({
          providerID: provider.id,
          providerName: provider.name,
          modelID,
          modelName: ((model as any).name || modelID).replace('(latest)', '').trim(),
          variants: (model as any).variants,
          capabilities: caps
            ? {
                reasoning: caps.reasoning ?? false,
                vision: caps.input?.image ?? false,
                toolcall: caps.toolcall ?? false,
              }
            : {
                reasoning: (model as any).reasoning ?? false,
                vision: modalities?.input?.includes('image') ?? false,
                toolcall: (model as any).tool_call ?? false,
              },
          contextWindow: (model as any).limit?.context,
          releaseDate: (model as any).release_date,
          family: (model as any).family,
          cost: (model as any).cost,
          providerSource: (provider as any).source,
        });
      }
    }
    return result;
  }, [providers]);

  if (!isOpen) return null;

  return (
    <ProviderModal
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) closeProviderModal();
      }}
      defaultTab={defaultTab}
      providers={providers}
      models={models.length > 0 ? models : undefined}
    />
  );
}
