'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Search,
  Unplug,
} from 'lucide-react';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
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
import { ConnectProviderContent } from '@/components/providers/connect-provider-content';
import {
  MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/components/providers/provider-branding';
import { ProviderRowContent } from '@/components/providers/provider-card';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { FlatModel } from '@/components/session/session-chat-input';
import { getClient } from '@/lib/opencode-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { opencodeKeys } from '@/hooks/opencode/use-opencode-sessions';
import { toast } from '@/lib/toast';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import type { ProviderModalTab } from '@/stores/provider-modal-store';

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
        toast.success(`${PROVIDER_LABELS[providerID] || providerID} disconnected`);
        onDisconnected?.();
      } catch {
        toast.error('Failed to disconnect provider');
      } finally {
        setDisconnecting(null);
      }
    },
    [onDisconnected, queryClient],
  );

  if (connectedProviders.length === 0) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-xs text-muted-foreground/60">
          No providers connected yet
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-[11px]"
          onClick={onAddProvider}
        >
          Add provider
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-xs text-muted-foreground/60">
          No connected providers match &ldquo;{search}&rdquo;
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-3 pb-4 pt-3">
      {filtered.map((provider) => {
        const modelCount = Object.keys(provider.models ?? {}).length;
        const isDisconnecting = disconnecting === provider.id;
        const source = (provider as { source?: string }).source;
        return (
          <div
            key={provider.id}
            className="group flex h-auto w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35"
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
                <Button
                  type="button"
                  onClick={() => setConfirmDisconnect(provider.id)}
                  disabled={isDisconnecting}
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto shrink-0 text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive"
                  title="Disconnect"
                >
                  {isDisconnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unplug className="h-3.5 w-3.5" />
                  )}
                </Button>
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
            <AlertDialogTitle>Disconnect provider?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmDisconnect && (
                <>
                  Remove{' '}
                  <span className="font-medium text-foreground">
                    {PROVIDER_LABELS[confirmDisconnect] || confirmDisconnect}
                  </span>
                  ? You&apos;ll need to reconnect it to use it again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDisconnect && doDisconnect(confirmDisconnect)}
              className="bg-destructive text-white hover:bg-destructive/90"
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

function ModelsTabBody({
  models,
  modelStore,
  search,
}: {
  models: FlatModel[];
  modelStore: ReturnType<typeof useModelStore>;
  search: string;
}) {
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
      ([id, list]) =>
        [id, list.sort((a, b) => a.modelName.localeCompare(b.modelName))] as const,
    );
  }, [models, search]);

  if (grouped.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-xs text-muted-foreground/60">
          {search ? `No models match "${search}"` : 'No models'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-3 pb-4 pt-3">
      {grouped.map(([providerID, list]) => (
        <div key={providerID}>
          <div className="flex items-center gap-2 px-1 pb-1">
            <ProviderLogo
              providerID={providerID}
              name={list[0]?.providerName || providerID}
              size="small"
            />
            <span className="text-xs font-medium text-foreground/70">
              {PROVIDER_LABELS[providerID] || list[0]?.providerName || providerID}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground/40">
              {list.length}
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-border/40 bg-background/40">
            {list.map((m, i) => {
              const key = { providerID: m.providerID, modelID: m.modelID };
              const visible = modelStore.isVisible(key);
              return (
                <label
                  key={`${m.providerID}:${m.modelID}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/30',
                    i > 0 && 'border-t border-border/20',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{m.modelName}</div>
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
                      {m.modelID}
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
  const { data: fetchedProviders } = useOpenCodeProviders();
  const providers = providersProp ?? fetchedProviders;

  const connectedProviders = useMemo(() => {
    if (!providers) return [];
    const connectedIds = new Set(providers.connected ?? []);
    return (providers.all ?? []).filter((provider) =>
      connectedIds.has(provider.id),
    );
  }, [providers]);

  const hasConnections = connectedProviders.length > 0;

  const [activeTab, setActiveTab] = useState<ActiveTab>(() =>
    mapInitialTab(defaultTab, hasConnections),
  );
  const [search, setSearch] = useState('');
  const [catalogSubview, setCatalogSubview] = useState<
    'list' | 'connect' | 'custom'
  >('list');

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
  const switchTab = useCallback(
    (next: ActiveTab) => {
      setActiveTab(next);
      setSearch('');
    },
    [],
  );

  const searchPlaceholder =
    activeTab === 'connected'
      ? 'Search connected providers...'
      : activeTab === 'models'
        ? 'Search models...'
        : 'Search providers...';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!grid h-[min(80vh,680px)] w-[calc(100vw-2rem)] max-w-[600px] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-0.5 px-5 pt-5 pb-3 pr-12">
          <DialogTitle className="text-sm font-semibold">LLM Providers</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground/60">
            Connect providers and manage which models appear in chat.
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar — pills on the left, search input on the right, same row.
            Both at h-9 so they line up. Hidden in connect/custom sub-flow so
            the form takes over cleanly. */}
        {!inSubflow && (
          <div className="flex h-9 items-center gap-3 px-5 pb-3 box-content">
            <FilterBar>
              <FilterBarItem
                data-state={activeTab === 'connected' ? 'active' : 'inactive'}
                onClick={() => switchTab('connected')}
                className="text-[12px] data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                Connected
                {connectedProviders.length > 0 && (
                  <span className="ml-0.5 text-[10px] text-muted-foreground/40 tabular-nums">
                    {connectedProviders.length}
                  </span>
                )}
              </FilterBarItem>
              <FilterBarItem
                data-state={activeTab === 'catalog' ? 'active' : 'inactive'}
                onClick={() => switchTab('catalog')}
                className="text-[12px] data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                Add provider
              </FilterBarItem>
              <FilterBarItem
                data-state={activeTab === 'models' ? 'active' : 'inactive'}
                onClick={() => switchTab('models')}
                className="text-[12px] data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                Models
                {hasModels && (
                  <span className="ml-0.5 text-[10px] text-muted-foreground/40 tabular-nums">
                    {visibleModelCount}/{models!.length}
                  </span>
                )}
              </FilterBarItem>
            </FilterBar>

            <div className="relative ml-auto h-9 w-72 shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-xl border-border/50 bg-muted/20 pl-9 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-ring/40"
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
            <ModelsTabBody
              models={models!}
              modelStore={modelStore}
              search={search}
            />
          )}

          {activeTab === 'models' && !hasModels && (
            <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
              <p className="text-xs text-muted-foreground/60">
                Connect a provider to see its models.
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
