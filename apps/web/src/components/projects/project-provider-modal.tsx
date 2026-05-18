'use client';

/**
 * ProjectProviderModal — per-project port of the legacy global provider modal.
 *
 * The legacy modal stored credentials in the active OpenCode sandbox via the
 * OpenCode SDK; this one stores them as plain project secrets so every session
 * sandbox for the project picks them up as env vars on boot.
 *
 * Layout intentionally mirrors the legacy three-tab UX so the muscle memory
 * carries over: Connected | Add provider | Models.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Plug,
  Plus,
  Search,
  Unplug,
} from 'lucide-react';

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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import {
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/components/providers/provider-branding';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  deleteProjectSecret,
  listProjectSecrets,
  upsertProjectSecret,
} from '@/lib/projects-client';
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_BY_ID,
  type LlmProviderEntry,
} from '@/lib/llm-providers';

type ActiveTab = 'connected' | 'catalog' | 'models';
type CatalogSubview =
  | { kind: 'list' }
  | { kind: 'detail'; providerId: string }
  | { kind: 'connect'; providerId: string }
  | { kind: 'custom' };

export interface ProjectProviderModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: ActiveTab;
}

export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  defaultTab,
}: ProjectProviderModalProps) {
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
  });

  const secretNames = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : data?.items ?? [];
    return new Set(items.map((item) => item.name));
  }, [secretsQuery.data]);

  // A provider is "connected" only when every one of its env vars is stored.
  // For most providers that's a single key; for Azure/Bedrock/etc. it's two
  // or three. Partial credentials are treated as not-connected on purpose —
  // a half-configured provider would error at session start anyway.
  const connectedProviders = useMemo(
    () =>
      LLM_PROVIDERS.filter(
        (p) => p.envVars.length > 0 && p.envVars.every((v) => secretNames.has(v)),
      ),
    [secretNames],
  );

  const hasConnections = connectedProviders.length > 0;

  const [activeTab, setActiveTab] = useState<ActiveTab>(() =>
    pickInitialTab(defaultTab, hasConnections),
  );
  const [subview, setSubview] = useState<CatalogSubview>({ kind: 'list' });
  const [search, setSearch] = useState('');

  // Reset whenever the dialog is reopened.
  useEffect(() => {
    if (open) {
      setActiveTab(pickInitialTab(defaultTab, hasConnections));
      setSubview({ kind: 'list' });
      setSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTab]);

  const switchTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    setSubview({ kind: 'list' });
    setSearch('');
  }, []);

  const inSubflow = activeTab === 'catalog' && subview.kind !== 'list';

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
            Connect providers — keys are stored per-project and injected as env vars
            into every new session sandbox.
          </DialogDescription>
        </DialogHeader>

        {!inSubflow && (
          <div className="flex items-center gap-3 px-5 pb-3">
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
              </FilterBarItem>
            </FilterBar>

            <div className="relative ml-auto h-9 min-w-0 flex-1 max-w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-full rounded-full border-border/50 bg-foreground/[0.05] pl-9 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-ring/40"
              />
            </div>
          </div>
        )}

        <div className="min-h-0 overflow-y-auto">
          {secretsQuery.isLoading && (
            <div className="flex min-h-[200px] items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!secretsQuery.isLoading && activeTab === 'connected' && (
            <ConnectedTab
              projectId={projectId}
              connectedProviders={connectedProviders}
              search={search}
              onAddProvider={() => switchTab('catalog')}
            />
          )}

          {!secretsQuery.isLoading && activeTab === 'catalog' && (
            <CatalogTab
              projectId={projectId}
              connectedIds={new Set(connectedProviders.map((p) => p.id))}
              search={search}
              subview={subview}
              setSubview={setSubview}
            />
          )}

          {!secretsQuery.isLoading && activeTab === 'models' && (
            <ModelsTab
              connectedProviders={connectedProviders}
              search={search}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function pickInitialTab(
  defaultTab: ActiveTab | undefined,
  hasConnections: boolean,
): ActiveTab {
  if (defaultTab === 'catalog') return 'catalog';
  if (defaultTab === 'connected') return hasConnections ? 'connected' : 'catalog';
  if (defaultTab === 'models') return hasConnections ? 'models' : 'catalog';
  return hasConnections ? 'connected' : 'catalog';
}

// ─── Connected tab ──────────────────────────────────────────────────────────

function ConnectedTab({
  projectId,
  connectedProviders,
  search,
  onAddProvider,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  search: string;
  onAddProvider: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Disconnect deletes every env var the provider owns — for single-key
  // providers that's just one DELETE; for multi-key (Azure etc.) we fire all
  // deletes in parallel and wait for the lot.
  const disconnect = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      await Promise.all(
        provider.envVars.map((envVar) => deleteProjectSecret(projectId, envVar)),
      );
      return provider;
    },
    onSuccess: (provider) => {
      toast.success(`${provider.label} disconnected`);
      setConfirmId(null);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connectedProviders;
    return connectedProviders.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.envVars.some((v) => v.toLowerCase().includes(q)),
    );
  }, [connectedProviders, search]);

  if (connectedProviders.length === 0) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-xs text-muted-foreground/60">No providers connected yet</p>
        <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onAddProvider}>
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

  const confirmProvider = confirmId ? LLM_PROVIDER_BY_ID.get(confirmId) : null;

  return (
    <div className="space-y-1 px-5 pb-4 pt-3">
      {filtered.map((provider) => (
        <div
          key={provider.id}
          className="group flex h-auto w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2.5 text-left"
        >
          <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {PROVIDER_LABELS[provider.id] ?? provider.label}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {provider.envVars.join(' · ')} · {provider.models.length} model
              {provider.models.length === 1 ? '' : 's'}
            </div>
          </div>
          <Button
            type="button"
            onClick={() => setConfirmId(provider.id)}
            disabled={disconnect.isPending}
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0 text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive"
            title="Disconnect"
          >
            {disconnect.isPending && disconnect.variables?.id === provider.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Unplug className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      ))}

      <AlertDialog
        open={!!confirmId}
        onOpenChange={(open) => !open && setConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect provider?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmProvider && (
                <>
                  Remove{' '}
                  <span className="font-medium text-foreground">{confirmProvider.label}</span>?
                  This deletes{' '}
                  {confirmProvider.envVars.length === 1 ? (
                    <>
                      the{' '}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono">
                        {confirmProvider.envVars[0]}
                      </code>{' '}
                      project secret.
                    </>
                  ) : (
                    <>
                      {confirmProvider.envVars.length} project secrets (
                      {confirmProvider.envVars.map((envVar, index) => (
                        <span key={envVar}>
                          {index > 0 && ', '}
                          <code className="rounded bg-muted px-1 py-0.5 font-mono">{envVar}</code>
                        </span>
                      ))}
                      ).
                    </>
                  )}{' '}
                  You&apos;ll need to reconnect to use it again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmProvider && disconnect.mutate(confirmProvider)}
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

// ─── Catalog tab (add provider) ────────────────────────────────────────────

function CatalogTab({
  projectId,
  connectedIds,
  search,
  subview,
  setSubview,
}: {
  projectId: string;
  connectedIds: Set<string>;
  search: string;
  subview: CatalogSubview;
  setSubview: (next: CatalogSubview) => void;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return LLM_PROVIDERS;
    return LLM_PROVIDERS.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.envVars.some((v) => v.toLowerCase().includes(q)),
    );
  }, [search]);

  if (subview.kind === 'detail') {
    const provider = LLM_PROVIDER_BY_ID.get(subview.providerId);
    if (!provider) {
      setSubview({ kind: 'list' });
      return null;
    }
    return (
      <ProviderDetail
        provider={provider}
        isConnected={connectedIds.has(provider.id)}
        onBack={() => setSubview({ kind: 'list' })}
        onConnect={() => setSubview({ kind: 'connect', providerId: provider.id })}
      />
    );
  }

  if (subview.kind === 'connect') {
    const provider = LLM_PROVIDER_BY_ID.get(subview.providerId);
    if (!provider) {
      setSubview({ kind: 'list' });
      return null;
    }
    return (
      <ConnectForm
        projectId={projectId}
        provider={provider}
        onBack={() => setSubview({ kind: 'detail', providerId: provider.id })}
        onConnected={() => setSubview({ kind: 'list' })}
      />
    );
  }

  if (subview.kind === 'custom') {
    return (
      <CustomProviderForm
        projectId={projectId}
        onBack={() => setSubview({ kind: 'list' })}
        onDone={() => setSubview({ kind: 'list' })}
      />
    );
  }

  return (
    <div className="space-y-1 px-5 pb-4 pt-3">
      {/* Custom provider always pinned to the top — same affordance the legacy
          modal had. Wires an OpenAI-compatible endpoint without needing it to
          be on the models.dev catalog. */}
      <Button
        type="button"
        variant="ghost"
        onClick={() => setSubview({ kind: 'custom' })}
        className="group flex h-auto w-full items-center gap-3 rounded-xl border border-dashed border-border bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-border/60 text-muted-foreground/70">
          <Plus className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Custom provider
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Connect any OpenAI-compatible endpoint with your own base URL
          </div>
        </div>
        <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      </Button>

      {filtered.length === 0 && (
        <div className="px-4 py-8 text-center">
          <p className="text-xs text-muted-foreground/60">
            {search ? `No providers match "${search}"` : 'No providers'}
          </p>
        </div>
      )}

      {filtered.map((provider) => {
        const isConnected = connectedIds.has(provider.id);
        return (
          <Button
            key={provider.id}
            type="button"
            variant="ghost"
            onClick={() => setSubview({ kind: 'detail', providerId: provider.id })}
            className="group flex h-auto w-full items-center gap-3 rounded-xl border border-border/50 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35"
          >
            <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                {PROVIDER_LABELS[provider.id] ?? provider.label}
                {isConnected && (
                  <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                    Connected
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {provider.hint}
              </div>
            </div>
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
          </Button>
        );
      })}
    </div>
  );
}

// ─── Provider detail (model preview) ───────────────────────────────────────

function ProviderDetail({
  provider,
  isConnected,
  onBack,
  onConnect,
}: {
  provider: LlmProviderEntry;
  isConnected: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  // Catalog already pre-sorts newest-first; we just render. Lots of providers
  // ship 100+ models — let the dialog body scroll rather than virtualizing.
  const models = provider.models;
  const helpHostname = useMemo(() => {
    if (!provider.helpUrl) return null;
    try {
      return new URL(provider.helpUrl).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }, [provider.helpUrl]);

  return (
    <div className="space-y-3 px-5 pb-5 pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
        onClick={onBack}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to providers
      </Button>

      <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            {PROVIDER_LABELS[provider.id] ?? provider.label}
            {isConnected && (
              <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                Connected
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {provider.envVars.join(' · ')} · {models.length} model
            {models.length === 1 ? '' : 's'}
          </div>
        </div>
        <Button size="sm" className="ml-auto shrink-0" onClick={onConnect}>
          {isConnected ? 'Reconnect' : 'Connect'}
        </Button>
      </div>

      {helpHostname && provider.helpUrl && (
        <a
          href={provider.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          {helpHostname}
        </a>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Models
          </span>
          <span className="text-[10px] text-muted-foreground/40 tabular-nums">
            newest first
          </span>
        </div>
        {models.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-xs text-muted-foreground">
            No models declared.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/40 bg-background/40">
            {models.map((model, i) => (
              <div
                key={model.id}
                className={cn(
                  'flex items-start gap-3 px-3 py-2',
                  i > 0 && 'border-t border-border/20',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{model.name}</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
                    {model.id}
                  </div>
                </div>
                {model.released && (
                  <span
                    className="shrink-0 self-center text-[10px] tabular-nums text-muted-foreground/50"
                    title={`Released ${model.released}`}
                  >
                    {releasedAgo(model.released)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact relative date — "3w", "5mo", "2y". null when unparseable. */
function releasedAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  if (days < 7) return days === 0 ? 'today' : `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

// ─── Connect form (API-key only — OAuth is a separate workstream) ─────────

function ConnectForm({
  projectId,
  provider,
  onBack,
  onConnected,
}: {
  projectId: string;
  provider: LlmProviderEntry;
  onBack: () => void;
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  // One entry per env var the provider declares. Render order is the order in
  // the catalog — for multi-key providers like Azure that means
  // AZURE_RESOURCE_NAME first, AZURE_API_KEY second.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(provider.envVars.map((v) => [v, ''])),
  );
  const [error, setError] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: async () => {
      // Save every env var. We fire them in sequence so any one server-side
      // rejection (reserved name, value length, etc.) surfaces cleanly without
      // having to roll back partial state.
      for (const envVar of provider.envVars) {
        await upsertProjectSecret(projectId, {
          name: envVar,
          value: values[envVar] ?? '',
        });
      }
    },
    onSuccess: () => {
      toast.success(`${provider.label} connected`);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      onConnected();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Failed to save credentials'),
  });

  const allFilled = provider.envVars.every((envVar) => values[envVar]?.trim());
  const helpHostname = useMemo(() => {
    if (!provider.helpUrl) return null;
    try {
      return new URL(provider.helpUrl).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }, [provider.helpUrl]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!allFilled) {
      setError(
        provider.envVars.length === 1
          ? 'API key is required'
          : `All ${provider.envVars.length} fields are required`,
      );
      return;
    }
    upsert.mutate();
  }

  return (
    <div className="space-y-3 px-5 pb-5 pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
        onClick={onBack}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to providers
      </Button>

      <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {provider.label}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {provider.envVars.length === 1 ? 'Stored as' : 'Stored as'}{' '}
            {provider.envVars.map((envVar, index) => (
              <span key={envVar}>
                {index > 0 && ' · '}
                <code className="rounded bg-background px-1 py-0.5 font-mono">
                  {envVar}
                </code>
              </span>
            ))}
          </div>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className={cn(
          'space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4',
        )}
      >
        {provider.envVars.map((envVar, index) => (
          <div key={envVar}>
            <label
              htmlFor={`provider-${provider.id}-${envVar}`}
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
            >
              {prettyFieldLabel(envVar)}
            </label>
            <Input
              id={`provider-${provider.id}-${envVar}`}
              type="text"
              value={values[envVar] ?? ''}
              onChange={(e) =>
                setValues((current) => ({ ...current, [envVar]: e.target.value }))
              }
              placeholder={envVarPlaceholder(provider, envVar)}
              className="h-9 rounded-xl border-border/50 bg-background text-sm"
              autoFocus={index === 0}
              autoComplete="off"
            />
          </div>
        ))}

        {provider.helpUrl && helpHostname && (
          <a
            href={provider.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Get credentials from {helpHostname}
          </a>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button
          type="submit"
          size="sm"
          className="px-4"
          disabled={upsert.isPending || !allFilled}
        >
          {upsert.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Connecting…
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </form>

      <p className="px-1 text-[11px] text-muted-foreground">
        Values are encrypted at rest (AES-256-GCM, per-project key) and injected
        into every new session sandbox as env vars. Restart any running session
        for this provider to take effect there.
      </p>
    </div>
  );
}

// ─── Custom provider (OpenAI-compatible base URL + key) ───────────────────

interface CustomFormState {
  providerId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
  modelName: string;
}

function CustomProviderForm({
  projectId,
  onBack,
  onDone,
}: {
  projectId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomFormState>({
    providerId: '',
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
    modelName: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [savedSnippet, setSavedSnippet] = useState<{
    snippet: string;
    secretName: string | null;
  } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed: CustomFormState = {
        providerId: form.providerId.trim().toLowerCase(),
        name: form.name.trim(),
        baseURL: form.baseURL.trim(),
        apiKey: form.apiKey.trim(),
        modelId: form.modelId.trim(),
        modelName: form.modelName.trim(),
      };

      if (!trimmed.providerId || !trimmed.name || !trimmed.baseURL) {
        throw new Error('Provider ID, name, and base URL are required');
      }
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed.providerId)) {
        throw new Error('Provider ID can only use letters, numbers, dashes, underscores');
      }
      if (!/^https?:\/\//.test(trimmed.baseURL)) {
        throw new Error('Base URL must start with http:// or https://');
      }
      if (!trimmed.modelId || !trimmed.modelName) {
        throw new Error('At least one model (ID + name) is required');
      }

      // If the user typed a plaintext key, store it as a project secret named
      // after the provider — keeps the secret + the manifest reference cleanly
      // separated. If they leave the field blank, the manifest still emits
      // without an apiKey ref (some endpoints don't need one).
      const secretName = trimmed.apiKey
        ? `CUSTOM_${trimmed.providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`
        : null;
      if (secretName) {
        await upsertProjectSecret(projectId, { name: secretName, value: trimmed.apiKey });
      }

      const snippet = buildCustomProviderSnippet({
        providerId: trimmed.providerId,
        name: trimmed.name,
        baseURL: trimmed.baseURL,
        secretName,
        modelId: trimmed.modelId,
        modelName: trimmed.modelName,
      });

      return { snippet, secretName };
    },
    onSuccess: (result) => {
      setSavedSnippet(result);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save'),
  });

  function setField<K extends keyof CustomFormState>(key: K, value: CustomFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (error) setError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    save.mutate();
  }

  if (savedSnippet) {
    return (
      <CustomProviderSnippetView
        snippet={savedSnippet.snippet}
        secretName={savedSnippet.secretName}
        onDone={onDone}
      />
    );
  }

  return (
    <div className="space-y-3 px-5 pb-5 pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
        onClick={onBack}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to providers
      </Button>

      <div className="rounded-xl border border-border/50 bg-muted/20 px-3.5 py-3">
        <div className="text-sm font-medium text-foreground">Custom provider</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Connect any OpenAI-compatible endpoint. The API key is saved as a
          project secret; the provider declaration goes in your repo&apos;s{' '}
          <code className="rounded bg-background px-1 py-0.5 font-mono">.opencode/opencode.jsonc</code>.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Provider ID
            </label>
            <Input
              type="text"
              value={form.providerId}
              onChange={(e) =>
                setField(
                  'providerId',
                  e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
                )
              }
              placeholder="my-llm"
              className="h-9 rounded-xl border-border/50 bg-background font-mono text-xs"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Display name
            </label>
            <Input
              type="text"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="My LLM"
              className="h-9 rounded-xl border-border/50 bg-background text-sm"
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Base URL
          </label>
          <Input
            type="text"
            value={form.baseURL}
            onChange={(e) => setField('baseURL', e.target.value)}
            placeholder="https://api.example.com/v1"
            className="h-9 rounded-xl border-border/50 bg-background font-mono text-xs"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            API key{' '}
            <span className="font-normal text-muted-foreground/60">(optional)</span>
          </label>
          <Input
            type="text"
            value={form.apiKey}
            onChange={(e) => setField('apiKey', e.target.value)}
            placeholder="sk-… (saved as a project secret)"
            className="h-9 rounded-xl border-border/50 bg-background font-mono text-xs"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Model ID
            </label>
            <Input
              type="text"
              value={form.modelId}
              onChange={(e) => setField('modelId', e.target.value)}
              placeholder="my-llm/foo-7b"
              className="h-9 rounded-xl border-border/50 bg-background font-mono text-xs"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Model name
            </label>
            <Input
              type="text"
              value={form.modelName}
              onChange={(e) => setField('modelName', e.target.value)}
              placeholder="Foo 7B"
              className="h-9 rounded-xl border-border/50 bg-background text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" size="sm" className="px-4" disabled={save.isPending}>
          {save.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Generating…
            </>
          ) : (
            'Generate snippet'
          )}
        </Button>
      </form>
    </div>
  );
}

function CustomProviderSnippetView({
  snippet,
  secretName,
  onDone,
}: {
  snippet: string;
  secretName: string | null;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success('Snippet copied');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select and copy manually');
    }
  }

  return (
    <div className="space-y-3 px-5 pb-5 pt-3">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] px-3.5 py-3">
        <div className="text-sm font-medium text-foreground">
          {secretName ? 'API key saved' : 'Snippet ready'}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {secretName ? (
            <>
              Your key is stored as{' '}
              <code className="rounded bg-background px-1 py-0.5 font-mono">{secretName}</code>{' '}
              and will be injected into sessions as an env var.
            </>
          ) : (
            <>No API key was provided — the snippet below omits the apiKey field.</>
          )}
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Add to <code className="font-mono normal-case">.opencode/opencode.jsonc</code>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={handleCopy}
          >
            <Copy className="h-3 w-3" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className="max-h-[280px] overflow-auto rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5 font-mono text-[11px] leading-snug text-foreground">
          {snippet}
        </pre>
      </div>

      <p className="px-1 text-[11px] text-muted-foreground">
        Paste this into your project repo&apos;s{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">.opencode/opencode.jsonc</code>{' '}
        and commit. Restart any running session for the change to land in the sandbox.
      </p>

      <Button size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function buildCustomProviderSnippet(input: {
  providerId: string;
  name: string;
  baseURL: string;
  secretName: string | null;
  modelId: string;
  modelName: string;
}): string {
  const options: Record<string, string> = { baseURL: input.baseURL };
  if (input.secretName) options.apiKey = `{env:${input.secretName}}`;

  const snippet = {
    provider: {
      [input.providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: input.name,
        options,
        models: {
          [input.modelId]: {
            id: input.modelId,
            name: input.modelName,
            family: input.providerId,
          },
        },
      },
    },
  };

  return JSON.stringify(snippet, null, 2);
}

function prettyFieldLabel(envVar: string): string {
  // ANTHROPIC_API_KEY → "API key"; AZURE_RESOURCE_NAME → "Resource name".
  // Strip the provider prefix where it's predictable, then humanize.
  const trimmed = envVar.replace(/^[A-Z0-9]+_/, '').replace(/_/g, ' ').toLowerCase();
  const upper = trimmed.toUpperCase();
  // Common acronyms we don't want lowercased back into "api"/"url"/etc.
  if (upper === 'API KEY') return 'API key';
  if (upper === 'API URL') return 'API URL';
  if (upper === 'BASE URL') return 'Base URL';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function envVarPlaceholder(provider: LlmProviderEntry, envVar: string): string {
  if (provider.envVars.length === 1) {
    return `Paste your ${provider.label} API key…`;
  }
  return `Enter ${envVar}…`;
}

// ─── Models tab ─────────────────────────────────────────────────────────────

function ModelsTab({
  connectedProviders,
  search,
}: {
  connectedProviders: LlmProviderEntry[];
  search: string;
}) {
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return connectedProviders
      .map((provider) => ({
        provider,
        models: provider.models.filter(
          (model) =>
            !q ||
            model.name.toLowerCase().includes(q) ||
            model.id.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [connectedProviders, search]);

  if (connectedProviders.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-xs text-muted-foreground/60">
          Connect a provider to see its models.
        </p>
      </div>
    );
  }

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
    <div className="space-y-3 px-5 pb-4 pt-3">
      {grouped.map(({ provider, models }) => (
        <div key={provider.id}>
          <div className="flex items-center gap-2 px-1 pb-1">
            <ProviderLogo providerID={provider.id} name={provider.label} size="small" />
            <span className="text-xs font-medium text-foreground/70">
              {PROVIDER_LABELS[provider.id] ?? provider.label}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground/40">
              {models.length}
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-border/40 bg-background/40">
            {models.map((model, i) => (
              <div
                key={model.id}
                className={cn(
                  'flex items-center gap-3 px-3 py-2',
                  i > 0 && 'border-t border-border/20',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{model.name}</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
                    {model.id}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Convenience: small trigger button that opens the modal. */
export function ConnectProviderButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <Plug className="h-3.5 w-3.5" />
        Connect provider
      </Button>
      <ProjectProviderModal projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}
