'use client';

import { useTranslations } from 'next-intl';

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
  Info,
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
import { Button, buttonVariants } from '@/components/ui/button';
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
  SharingPicker,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/components/projects/sharing-picker';
import {
  PROVIDER_LABELS,
  ProviderLogo,
} from '@/components/providers/provider-branding';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  completeProjectChatGptHeadlessAuth,
  deleteProjectSecret,
  deletePersonalProjectSecret,
  listProjectSecrets,
  setPersonalProjectSecret,
  startProjectChatGptHeadlessAuth,
  upsertProjectSecret,
} from '@/lib/projects-client';
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_BY_ID,
  type LlmProviderEntry,
  type LlmProviderModel,
} from '@/lib/llm-providers';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { FlatModel } from '@/components/session/session-chat-input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
const LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME = 'OPENCODE_AUTH_JSON';

function providerCredentialSummary(provider: LlmProviderEntry): string {
  if (provider.id === 'openai') return 'OpenAI API key or ChatGPT subscription';
  return provider.envVars.join(' · ');
}

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Gate the secrets fetch on `open`. The modal is always mounted by callers
  // like ModelSelector (so `<Dialog>` can animate in/out cleanly), and firing
  // this query on mount produces a noisy toast for users who can't manage the
  // project, so we only run it once the dialog is actually opened.
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
    enabled: open,
  });

  const secretNames = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : data?.items ?? [];
    return new Set(items.map((item) => item.name));
  }, [secretsQuery.data]);

  // The managed Kortix gateway. It's injected into every sandbox by the
  // platform (no API key, no connect step), so it never shows up via project
  // secrets — we surface it here as an always-connected "Managed" provider,
  // sourcing its model list from the live OpenCode provider list.
  const { data: ocProviders } = useOpenCodeProviders();
  const kortixProvider = useMemo<LlmProviderEntry | null>(() => {
    const connectedIds = new Set(ocProviders?.connected ?? []);
    const kortix = (ocProviders?.all ?? []).find((p) => p.id === 'kortix');
    if (!kortix || !connectedIds.has('kortix')) return null;
    const models: LlmProviderModel[] = Object.entries(kortix.models ?? {}).map(
      ([id, m]) => ({
        id,
        name: ((m as { name?: string }).name || id).replace('(latest)', '').trim(),
        released: (m as { release_date?: string }).release_date ?? null,
      }),
    );
    return {
      id: 'kortix',
      label: kortix.name || 'Kortix',
      envVars: [],
      helpUrl: null,
      hint: 'Included with your plan',
      models,
      featured: true,
      managed: true,
    };
  }, [ocProviders]);

  // A provider is "connected" when its API-key route is fully wired (every
  // env var stored). Partial API-key state stays not-connected on purpose — a
  // half-configured provider would error at session start anyway. The managed
  // Kortix provider is always pinned first.
  const connectedProviders = useMemo(() => {
    const byo = LLM_PROVIDERS.filter(
      (p) =>
        p.id !== 'kortix' &&
        ((p.envVars.length > 0 && p.envVars.every((v) => secretNames.has(v))) ||
          (p.id === 'openai' &&
            (secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) ||
              secretNames.has(LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME)))),
    );
    return kortixProvider ? [kortixProvider, ...byo] : byo;
  }, [secretNames, kortixProvider]);

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
          <DialogTitle className="text-sm font-semibold">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line151JsxTextLlmProviders')}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground/60">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line153JsxTextConnectProvidersKeysAreStoredPerProjectAnd')}</DialogDescription>
        </DialogHeader>

        {!inSubflow && (
          <div className="flex items-center gap-3 px-5 pb-3">
            <FilterBar>
              <FilterBarItem
                data-state={activeTab === 'connected' ? 'active' : 'inactive'}
                onClick={() => switchTab('connected')}
                className="text-xs data-[state=active]:shadow-none data-[state=active]:ring-0"
              >
                Connected
                {connectedProviders.length > 0 && (
                  <span className="ml-0.5 text-xs text-muted-foreground/40 tabular-nums">
                    {connectedProviders.length}
                  </span>
                )}
              </FilterBarItem>
              <FilterBarItem
                data-state={activeTab === 'catalog' ? 'active' : 'inactive'}
                onClick={() => switchTab('catalog')}
                className="text-xs data-[state=active]:shadow-none data-[state=active]:ring-0"
              >{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line178JsxTextAddProvider')}</FilterBarItem>
              <FilterBarItem
                data-state={activeTab === 'models' ? 'active' : 'inactive'}
                onClick={() => switchTab('models')}
                className="text-xs data-[state=active]:shadow-none data-[state=active]:ring-0"
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Disconnect tears down every credential the provider owns: each env-var
  // secret (one DELETE per row). Fired in parallel so partial state can't
  // survive a disconnect on a multi-key provider.
  const disconnect = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      const names = provider.id === 'openai'
        ? [
            ...provider.envVars,
            CODEX_AUTH_JSON_SECRET_NAME,
            LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
          ]
        : provider.envVars;
      await Promise.all(
        names.flatMap((envVar) => [
          deleteProjectSecret(projectId, envVar).catch(() => undefined),
          deletePersonalProjectSecret(projectId, envVar).catch(() => undefined),
        ]),
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
        <p className="text-xs text-muted-foreground/60">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line300JsxTextNoProvidersConnectedYet')}</p>
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={onAddProvider}>{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line302JsxTextAddProvider')}</Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-xs text-muted-foreground/60">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line312JsxTextNoConnectedProvidersMatchLdquo')}{search}{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line312JsxTextRdquo')}</p>
      </div>
    );
  }

  const confirmProvider = confirmId ? LLM_PROVIDER_BY_ID.get(confirmId) : null;

  return (
    <div className="space-y-1 px-5 pb-4 pt-3">
      {filtered.map((provider) => (
        <div
          key={provider.id}
          className="group flex h-auto w-full items-center gap-3 rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-2.5 text-left"
        >
          <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {PROVIDER_LABELS[provider.id] ?? provider.label}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {provider.managed
                ? `${provider.hint} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`
                : `${providerCredentialSummary(provider)} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`}
            </div>
          </div>
          {provider.managed ? (
            <Badge size="sm" variant="secondary" className="ml-auto shrink-0">
              Managed
            </Badge>
          ) : (
            <Button
              type="button"
              onClick={() => setConfirmId(provider.id)}
              disabled={disconnect.isPending}
              variant="ghost"
              size="icon-sm"
              className="ml-auto shrink-0 text-muted-foreground/40 hover:bg-muted hover:text-foreground"
              title="Disconnect"
            >
              {disconnect.isPending && disconnect.variables?.id === provider.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Unplug className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      ))}

      <AlertDialog
        open={!!confirmId}
        onOpenChange={(open) => !open && setConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line361JsxTextDisconnectProvider')}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmProvider && (
                <>
                  Remove{' '}
                  <span className="font-medium text-foreground">{confirmProvider.label}</span>{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line366JsxTextThisDeletes')}{' '}
                  {confirmProvider.envVars.length === 1 ? (
                    <>
                      the{' '}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono">
                        {confirmProvider.envVars[0]}
                      </code>{' '}{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line374JsxTextProjectSecret')}</>
                  ) : (
                    <>
                      {confirmProvider.envVars.length}{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line378JsxTextProjectSecrets')}{confirmProvider.envVars.map((envVar, index) => (
                        <span key={envVar}>
                          {index > 0 && ', '}
                          <code className="rounded bg-muted px-1 py-0.5 font-mono">{envVar}</code>
                        </span>
                      ))}
                      ).
                    </>
                  )}{' '}{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line388JsxTextYouAposLlNeedToReconnectToUse')}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmProvider && disconnect.mutate(confirmProvider)}
              className={buttonVariants({ variant: 'destructive' })}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        className="group flex h-auto w-full items-center gap-3 rounded-2xl border border-dashed border-border bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-border/60 text-muted-foreground/70">
          <Plus className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line492JsxTextCustomProvider')}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line495JsxTextConnectAnyOpenaiCompatibleEndpointWithYourOwn')}</div>
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
            className="group flex h-auto w-full items-center gap-3 rounded-2xl border border-border/50 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35"
          >
            <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                {PROVIDER_LABELS[provider.id] ?? provider.label}
                {isConnected && (
                  <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Connected
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        <ChevronLeft className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line576JsxTextBackToProviders')}</Button>

      <div className="flex items-center gap-3 rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            {PROVIDER_LABELS[provider.id] ?? provider.label}
            {isConnected && (
              <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                Connected
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {providerCredentialSummary(provider)} · {models.length} model
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
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          {helpHostname}
        </a>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
            Models
          </span>
          <span className="text-xs text-muted-foreground/40 tabular-nums">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line618JsxTextNewestFirst')}</span>
        </div>
        {models.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/40 px-4 py-6 text-center text-xs text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line623JsxTextNoModelsDeclared')}</div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/40 bg-background/40">
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
                  <div className="mt-0.5 truncate text-xs text-muted-foreground/50">
                    {model.id}
                  </div>
                </div>
                {model.released && (
                  <span
                    className="shrink-0 self-center text-xs tabular-nums text-muted-foreground/50"
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

// ─── Connect form — API key entry (stored as project secrets) ──────────────

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
  return (
    <ApiKeyConnectForm
      projectId={projectId}
      provider={provider}
      onBack={onBack}
      onConnected={onConnected}
    />
  );
}

function ApiKeyConnectForm({
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  // One entry per env var the provider declares. Render order is the order in
  // the catalog — for multi-key providers like Azure that means
  // AZURE_RESOURCE_NAME first, AZURE_API_KEY second.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(provider.envVars.map((v) => [v, ''])),
  );
  const [sharing, setSharing] = useState<SharingSelection>({
    mode: 'project',
    memberIds: [],
  });
  const [error, setError] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: async () => {
      // Save every env var. We fire them in sequence so any one server-side
      // rejection (reserved name, value length, etc.) surfaces cleanly without
      // having to roll back partial state.
      for (const envVar of provider.envVars) {
        if (sharing.mode === 'private') {
          await setPersonalProjectSecret(projectId, envVar, {
            value: values[envVar] ?? '',
            active: true,
          });
        } else {
          await upsertProjectSecret(projectId, {
            name: envVar,
            value: values[envVar] ?? '',
            sharing: selectionToIntent(sharing),
          });
        }
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
    if (!isSharingComplete(sharing)) {
      setError('Pick at least one member, or choose another access option.');
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
        <ChevronLeft className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line767JsxTextBackToProviders')}</Button>

      <div className="flex items-center gap-3 rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {provider.label}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
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

      {provider.id === 'openai' && (
        <ChatGptSubscriptionConnect
          projectId={projectId}
          sharing={sharing}
          onConnected={onConnected}
        />
      )}

      <form
        onSubmit={handleSubmit}
        className={cn(
          'space-y-3 rounded-2xl border border-border/50 bg-muted/20 p-4',
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
              className="h-9 text-sm"
              autoFocus={index === 0}
              autoComplete="off"
            />
          </div>
        ))}

        <SharingPicker
          projectId={projectId}
          value={sharing}
          onChange={setSharing}
          showHeading
        />

        {provider.helpUrl && helpHostname && (
          <a
            href={provider.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line827JsxTextGetCredentialsFrom')}{' '}{helpHostname}
          </a>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-2xl bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
          <p className="text-xs leading-relaxed text-foreground/80">
            A sandbox picks up new providers when it starts. To use this in a running session,
            restart its sandbox from the session list.
          </p>
        </div>

        <Button
          type="submit"
          size="sm"
          className="px-4"
          disabled={upsert.isPending || !allFilled || !isSharingComplete(sharing)}
        >
          {upsert.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line847JsxTextConnecting')}</>
          ) : (
            'Connect'
          )}
        </Button>
      </form>

      <p className="px-1 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line856JsxTextValuesAreEncryptedAtRestAes256Gcm')}</p>
    </div>
  );
}

function ChatGptSubscriptionConnect({
  projectId,
  sharing,
  onConnected,
}: {
  projectId: string;
  sharing: SharingSelection;
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authId, setAuthId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authInstructions, setAuthInstructions] = useState<string | null>(null);

  function formatProviderError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err && typeof err === 'object') {
      const record = err as Record<string, unknown>;
      const data = record.data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const message = (data as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
      const message = record.message;
      if (typeof message === 'string' && message.trim()) return message;
      try {
        return JSON.stringify(err);
      } catch {
        // fall through
      }
    }
    return 'Failed to connect ChatGPT subscription';
  }

  async function handleStartHeadlessConnect() {
    setBusy(true);
    setError(null);
    setAuthId(null);
    setAuthUrl(null);
    setAuthInstructions(null);
    try {
      const authData = await startProjectChatGptHeadlessAuth(projectId);
      setAuthId(authData.authId);
      setAuthUrl(authData.url);
      setAuthInstructions(authData.instructions);
      if (authData.url) {
        window.open(authData.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(formatProviderError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteHeadlessConnect() {
    if (!authId) return;
    setBusy(true);
    setError(null);
    try {
      if (!isSharingComplete(sharing)) {
        throw new Error('Pick at least one member, or choose another access option.');
      }
      await completeProjectChatGptHeadlessAuth(projectId, {
        authId,
        sharing: selectionToIntent(sharing),
      });

      toast.success('ChatGPT subscription connected to this project');
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      onConnected();
    } catch (err) {
      setError(formatProviderError(err));
    } finally {
      setBusy(false);
    }
  }

  const deviceCode = authInstructions?.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0] ?? null;

  return (
    <div className="rounded-2xl border border-border/50 bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID="openai" name="OpenAI" size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">ChatGPT Plus/Pro</div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Use OpenCode headless auth, then save the resulting login as an encrypted project secret for future sessions.
          </p>
        </div>
      </div>
      {(authInstructions || authUrl) && (
        <div className="mt-3 rounded-2xl border border-border/50 bg-background/70 p-3">
          <div className="text-xs font-medium text-foreground">Complete authorization</div>
          {authUrl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2 h-8 gap-1.5 px-3"
              onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open auth page
            </Button>
          )}
          {deviceCode ? (
            <div className="mt-3">
              <div className="text-xs text-muted-foreground">Enter this code on the auth page:</div>
              <div className="mt-1 w-fit rounded-2xl border border-border/60 bg-muted px-3 py-2 font-mono text-lg font-semibold tracking-normal text-foreground">
                {deviceCode}
              </div>
            </div>
          ) : authInstructions ? (
            <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-border/60 bg-muted p-3 text-xs text-muted-foreground">
              {authInstructions}
            </pre>
          ) : null}
          {busy && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Connecting
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-2xl bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="px-4"
          onClick={handleStartHeadlessConnect}
          disabled={busy}
        >
          {busy ? (
            <>
              {!(authInstructions || authUrl) && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Connecting
            </>
          ) : (
            'Connect with headless auth'
          )}
        </Button>
        {authId && (
          <Button
            type="button"
            size="sm"
            className="px-4"
            onClick={handleCompleteHeadlessConnect}
            disabled={busy}
          >
            Complete authorization
          </Button>
        )}
      </div>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomFormState>({
    providerId: '',
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
    modelName: '',
  });
  const [sharing, setSharing] = useState<SharingSelection>({
    mode: 'project',
    memberIds: [],
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
        if (!isSharingComplete(sharing)) {
          throw new Error('Pick at least one member, or choose another access option.');
        }
        if (sharing.mode === 'private') {
          await setPersonalProjectSecret(projectId, secretName, {
            value: trimmed.apiKey,
            active: true,
          });
        } else {
          await upsertProjectSecret(projectId, {
            name: secretName,
            value: trimmed.apiKey,
            sharing: selectionToIntent(sharing),
          });
        }
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
        <ChevronLeft className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line983JsxTextBackToProviders')}</Button>

      <div className="rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-3">
        <div className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line987JsxTextCustomProvider')}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line989JsxTextConnectAnyOpenaiCompatibleEndpointTheApiKey')}{' '}
          <code className="rounded bg-background px-1 py-0.5 font-mono">.opencode/opencode.jsonc</code>.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-3 rounded-2xl border border-border/50 bg-muted/20 p-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1002JsxTextProviderId')}</label>
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
              className="h-9 font-mono text-xs"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1020JsxTextDisplayName')}</label>
            <Input
              type="text"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder={tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1026JsxAttrPlaceholderMyLlm')}
              className="h-9 text-sm"
            />
          </div>
        </div>

        {form.apiKey.trim() && (
          <SharingPicker
            projectId={projectId}
            value={sharing}
            onChange={setSharing}
            showHeading
          />
        )}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1033JsxTextBaseUrl')}</label>
          <Input
            type="text"
            value={form.baseURL}
            onChange={(e) => setField('baseURL', e.target.value)}
            placeholder="https://api.example.com/v1"
            className="h-9 font-mono text-xs"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1045JsxTextApiKey')}{' '}
            <span className="font-normal text-muted-foreground/60">(optional)</span>
          </label>
          <Input
            type="text"
            value={form.apiKey}
            onChange={(e) => setField('apiKey', e.target.value)}
            placeholder={tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1052JsxAttrPlaceholderSkSavedAsAProjectSecret')}
            className="h-9 font-mono text-xs"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1059JsxTextModelId')}</label>
            <Input
              type="text"
              value={form.modelId}
              onChange={(e) => setField('modelId', e.target.value)}
              placeholder="my-llm/foo-7b"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1071JsxTextModelName')}</label>
            <Input
              type="text"
              value={form.modelName}
              onChange={(e) => setField('modelName', e.target.value)}
              placeholder={tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1077JsxAttrPlaceholderFoo7b')}
              className="h-9 text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-2xl bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button
          type="submit"
          size="sm"
          className="px-4"
          disabled={save.isPending || (Boolean(form.apiKey.trim()) && !isSharingComplete(sharing))}
        >
          {save.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1094JsxTextGenerating')}</>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.04] px-3.5 py-3">
        <div className="text-sm font-medium text-foreground">
          {secretName ? 'API key saved' : 'Snippet ready'}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {secretName ? (
            <>{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1136JsxTextYourKeyIsStoredAs')}{' '}
              <code className="rounded bg-background px-1 py-0.5 font-mono">{secretName}</code>{' '}{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1138JsxTextAndWillBeInjectedIntoSessionsAsAn')}</>
          ) : (
            <>{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1141JsxTextNoApiKeyWasProvidedTheSnippetBelow')}</>
          )}
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1149JsxTextAddTo')}<code className="font-mono normal-case">.opencode/opencode.jsonc</code>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={handleCopy}
          >
            <Copy className="h-3 w-3" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className="max-h-[280px] overflow-auto rounded-2xl border border-border/40 bg-muted/20 px-3 py-2.5 font-mono text-xs leading-snug text-foreground">
          {snippet}
        </pre>
      </div>

      <p className="px-1 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1168JsxTextPasteThisIntoYourProjectRepoAposS')}{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">.opencode/opencode.jsonc</code>{' '}{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1170JsxTextAndCommitRestartAnyRunningSessionForThe')}</p>

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
  const tHardcodedUi = useTranslations('hardcodedUi');

  // Visibility (show/hide per model in the picker) is a global, browser-level
  // preference shared with the session model selector — same store, same keys.
  const flatModels = useMemo<FlatModel[]>(
    () =>
      connectedProviders.flatMap((p) =>
        p.models.map((m) => ({
          providerID: p.id,
          providerName: p.label,
          modelID: m.id,
          modelName: m.name,
          releaseDate: m.released ?? undefined,
        })),
      ),
    [connectedProviders],
  );
  const modelStore = useModelStore(flatModels);

  const enabledCount = useMemo(
    () =>
      flatModels.filter((m) =>
        modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID }),
      ).length,
    [flatModels, modelStore],
  );
  const hasOverrides = modelStore.userPrefs.length > 0;

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
        <p className="text-xs text-muted-foreground/60">{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1258JsxTextConnectAProviderToSeeItsModels')}</p>
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
    <div className="px-5 pb-4 pt-3">
      {!search && (
        <div className="flex items-center justify-between gap-3 px-1 pb-2.5">
          <p className="text-xs text-muted-foreground/60">
            {enabledCount} of {flatModels.length} shown in the model picker
          </p>
          {hasOverrides && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => modelStore.resetVisibility()}
            >
              Reset to defaults
            </Button>
          )}
        </div>
      )}
      <div className="space-y-3">
        {grouped.map(({ provider, models }) => (
          <div key={provider.id}>
            <div className="flex items-center gap-2 px-1 pb-1">
              <ProviderLogo providerID={provider.id} name={provider.label} size="small" />
              <span className="text-xs font-medium text-foreground/70">
                {PROVIDER_LABELS[provider.id] ?? provider.label}
              </span>
              <span className="ml-auto text-xs text-muted-foreground/40">
                {models.length}
              </span>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border/40 bg-background/40">
              {models.map((model, i) => {
                const key = { providerID: provider.id, modelID: model.id };
                const visible = modelStore.isVisible(key);
                return (
                  <label
                    key={model.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/30',
                      i > 0 && 'border-t border-border/20',
                      !visible && 'opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-foreground">{model.name}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground/50">
                        {model.id}
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

/** Convenience: small trigger button that opens the modal. */
export function ConnectProviderButton({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <Plug className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1323JsxTextConnectProvider')}</Button>
      <ProjectProviderModal projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}
