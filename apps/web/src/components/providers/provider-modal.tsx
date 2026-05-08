'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Unplug,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
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
import {
  GroupHeading,
  ProviderRowContent,
} from '@/components/providers/provider-card';
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

// ─── Connected section ──────────────────────────────────────────────────────

function ConnectedSection({
  connectedProviders,
  onDisconnected,
}: {
  connectedProviders: Provider[];
  onDisconnected?: () => void;
}) {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

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

  return (
    <div className="space-y-1">
      <GroupHeading>Connected</GroupHeading>
      {connectedProviders.map((provider) => {
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

// ─── Models section ─────────────────────────────────────────────────────────

function ModelsSection({
  models,
  modelStore,
}: {
  models: FlatModel[];
  modelStore: ReturnType<typeof useModelStore>;
}) {
  const visibleCount = useMemo(
    () =>
      models.filter((m) =>
        modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID }),
      ).length,
    [models, modelStore],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, FlatModel[]>();
    for (const m of models) {
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
  }, [models]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 px-1 pb-1 pt-1">
        <GroupHeading className="p-0">Models</GroupHeading>
        <span className="text-[10px] text-muted-foreground/50">
          {visibleCount} of {models.length} visible
        </span>
      </div>
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
// Single-page layout. No tabs, no mode switching. Everything visible at once,
// scroll for more. Sub-flows (connect / custom) are the only place we push
// a new view, because OAuth and API-key entry need their own form.

export interface ProviderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: ProviderModalTab;
  providers: ProviderListResponse | undefined;
  models?: FlatModel[];
  onProviderConnected?: () => void;
}

export function ProviderModal({
  open,
  onOpenChange,
  defaultTab: _defaultTab,
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

  const [catalogSubview, setCatalogSubview] = useState<
    'list' | 'connect' | 'custom'
  >('list');
  const inSubflow = catalogSubview !== 'list';

  const modelStore = useModelStore(models ?? []);
  const hasConnections = connectedProviders.length > 0;
  const hasModels = !!models?.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!grid h-[min(80vh,680px)] w-[calc(100vw-2rem)] max-w-[520px] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-0.5 px-5 pt-5 pb-4 pr-12">
          <DialogTitle className="text-sm font-semibold">LLM Providers</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground/60">
            Connect providers and manage which models appear in chat.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          <div className={cn(!inSubflow && 'space-y-5 px-4 pb-5')}>
            {!inSubflow && hasConnections && (
              <ConnectedSection
                connectedProviders={connectedProviders}
                onDisconnected={onProviderConnected}
              />
            )}

            {/* ConnectProviderContent stays mounted at all times so its
                internal navigation + form state survives across sections.
                When in list subview, the section heading sits above it.
                When in connect/custom subview, the body takes over the modal
                with its own padding + back arrow. */}
            <div className={cn(!inSubflow && 'space-y-1')}>
              {/* Heading only when something sits above (Connected section).
                  First-run users see ONLY the catalog — no need for a label. */}
              {!inSubflow && hasConnections && (
                <GroupHeading>Add provider</GroupHeading>
              )}
              <ConnectProviderContent
                providers={providers}
                onSubviewChange={setCatalogSubview}
                onProviderConnected={onProviderConnected}
              />
            </div>

            {!inSubflow && hasModels && (
              <ModelsSection models={models!} modelStore={modelStore} />
            )}
          </div>
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
