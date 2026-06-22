'use client';

import { useTranslations } from 'next-intl';
/**
 * Connectors — a master/detail surface (no management dialogs). The left rail
 * lists every connected app + a pinned "Global rules" entry + "Add app"; the
 * right pane manages the SELECTED app entirely inline: its Profile (the account
 * it signs in with + who can use it), its Permissions (per-tool Allow/Ask/Block
 * + glob/regex rules with inline schema preview), and removal. One place per
 * app — the model is App → Profile → Tools → Permissions.
 */

import { createFrontendClient } from '@pipedream/sdk/browser';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  KeyRound,
  Loader2,
  MessageSquare,
  Monitor,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useCustomizeStore } from '@/stores/customize-store';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { CodeBlockCode } from '@/components/ui/code-block';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup } from '@/components/ui/radio-group';
import { SectionCard } from '@/components/ui/section-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ShareOption, SharingPicker } from '@/features/co-worker/shared/sharing-picker';
import {
  createConnector,
  deleteConnector,
  getConnectorConfig,
  getConnectorPolicies,
  listConnectors,
  listPipedreamApps,
  pipedreamConnect,
  pipedreamFinalize,
  setConnectorCredential,
  setConnectorCredentialMode,
  setConnectorName,
  setConnectorPolicies,
  setConnectorSharing,
  syncConnectors,
  type AdminConnector,
  type ConnectorAction,
  type ConnectorConfig,
  type ConnectorDraftInput,
  type ConnectorPolicyAction,
  type ConnectorPolicyRule,
  type ConnectorSharing,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const PROVIDER_ICON: Record<AdminConnector['provider'], LucideIcon> = {
  pipedream: Zap,
  mcp: Boxes,
  openapi: Globe,
  graphql: Globe,
  http: Globe,
  channel: MessageSquare,
  computer: Monitor,
};

const RISK_VARIANT: Record<ConnectorAction['risk'], 'outline' | 'secondary' | 'destructive'> = {
  read: 'outline',
  write: 'secondary',
  destructive: 'destructive',
};

/** Forward-facing provider label — "App" for the 1-click (Pipedream) connectors. */
function providerLabel(p: AdminConnector['provider']): string {
  if (p === 'pipedream') return 'App';
  if (p === 'channel') return 'Channel';
  if (p === 'computer') return 'Computer';
  return p.toUpperCase();
}

// ─── Pipedream Connect overlay escape (used by the connect flow) ─────────────

const PIPEDREAM_IFRAME_SELECTOR = 'iframe[id^="pipedream-connect-iframe-"]';

/**
 * The Pipedream Connect SDK portals its overlay <iframe> onto <body>, outside
 * the Customize Radix Dialog. While that modal is open it (a) sets
 * `pointer-events: none` on <body> and (b) traps focus — both kill the popup.
 * Neutralize them for the lifetime of the connect flow; returns a cleanup fn.
 */
function withPipedreamOverlayEscape(): () => void {
  if (typeof document === 'undefined') return () => {};

  const releasePointerEvents = () => {
    document.querySelectorAll<HTMLIFrameElement>(PIPEDREAM_IFRAME_SELECTOR).forEach((el) => {
      el.style.pointerEvents = 'auto';
    });
  };
  const observer = new MutationObserver(releasePointerEvents);
  observer.observe(document.body, { childList: true });
  releasePointerEvents();

  const isPipedreamFrame = (node: EventTarget | null): boolean =>
    node instanceof Element && node.matches(PIPEDREAM_IFRAME_SELECTOR);

  const guardFocus = (event: FocusEvent) => {
    if (isPipedreamFrame(event.target) || isPipedreamFrame(event.relatedTarget)) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener('focusin', guardFocus, true);
  document.addEventListener('focusout', guardFocus, true);

  const guardEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (document.querySelector(PIPEDREAM_IFRAME_SELECTOR)) event.stopImmediatePropagation();
  };
  document.addEventListener('keydown', guardEscape, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', guardFocus, true);
    document.removeEventListener('focusout', guardFocus, true);
    document.removeEventListener('keydown', guardEscape, true);
  };
}

/** Pipedream 1-click connect, as a reusable mutation (in-page SDK overlay + finalize). */
function usePipedreamConnect(projectId: string, slug: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async () => {
      const { token, app } = await pipedreamConnect(projectId, slug);
      if (!token || !app) throw new Error('App connect is not configured');
      const pd = createFrontendClient({
        externalUserId: `${projectId}:${slug}`,
        tokenCallback: async () => ({ token, connect_link_url: undefined, expires_at: '' }) as any,
      });
      const release = withPipedreamOverlayEscape();
      let connected = false;
      try {
        connected = await new Promise<boolean>((resolve, reject) => {
          pd.connectAccount({
            app,
            token,
            onSuccess: () => resolve(true),
            onClose: (status: { successful: boolean }) => resolve(status.successful),
            onError: (err: unknown) =>
              reject(new Error((err as Error)?.message || 'Connection cancelled')),
          });
        });
      } finally {
        release();
      }
      if (!connected) return { connected: false };
      await pipedreamFinalize(projectId, slug);
      return { connected: true };
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      toast.success('Connected');
      onConnected();
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

// ─── Master / detail shell ──────────────────────────────────────────────────

type Selection = { kind: 'connector'; slug: string } | { kind: 'global' } | { kind: 'add' };

/** Connectors section — rendered inside the Customize overlay. */
export function ConnectorsView({ projectId }: { projectId: string }) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader icon={Plug} title="Connectors" />
      <ConnectorsMasterDetail projectId={projectId} />
    </div>
  );
}

function ConnectorsMasterDetail({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const queryKey = ['project-connectors', projectId];
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const query = useQuery({
    queryKey,
    queryFn: () => listConnectors(projectId),
    staleTime: 10_000,
  });
  const connectors = useMemo(() => query.data?.connectors ?? [], [query.data]);
  const isForbidden = query.isError && /403|forbidden/i.test((query.error as Error)?.message ?? '');

  // Selection persists in ?c= (slug | "global" | "add") for deep links.
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawC = search?.get('c') ?? '';
  const select = (sel: Selection) => {
    const key = sel.kind === 'connector' ? sel.slug : sel.kind;
    const params = new URLSearchParams(search?.toString() ?? '');
    params.set('c', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Resolve the active selection, defaulting to the first connector (or Add).
  const selection: Selection = useMemo(() => {
    if (rawC === 'global') return { kind: 'global' };
    if (rawC === 'add') return { kind: 'add' };
    if (rawC && connectors.some((c) => c.slug === rawC)) return { kind: 'connector', slug: rawC };
    if (connectors.length > 0) return { kind: 'connector', slug: connectors[0]!.slug };
    return { kind: 'add' };
  }, [rawC, connectors]);

  const sync = useMutation({
    mutationFn: () => syncConnectors(projectId),
    onSuccess: (res) => {
      invalidate();
      if (res.errors.length)
        toast.warning(`Synced ${res.synced}, ${res.errors.length} with issues`);
      else toast.success(`Synced ${res.synced} connector(s)`);
    },
    onError: (err: Error) => toast.error(err.message || 'Sync failed'),
  });

  if (query.isLoading) return <MasterDetailSkeleton />;
  if (isForbidden) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <InfoBanner
          tone="warning"
          icon={ShieldAlert}
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleAdminb2173330',
          )}
        >
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextOnlyProject51266c7d',
          )}
        </InfoBanner>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <InfoBanner
          tone="destructive"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleFailed959d47d5',
          )}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        >
          {(query.error as Error)?.message ?? 'Unknown error'}
        </InfoBanner>
      </div>
    );
  }

  const active =
    selection.kind === 'connector'
      ? (connectors.find((c) => c.slug === selection.slug) ?? null)
      : null;

  return (
    <div className="flex min-h-0 flex-1">
      <ConnectorRail
        projectId={projectId}
        connectors={connectors}
        selection={selection}
        onSelect={select}
        onSync={() => sync.mutate()}
        syncing={sync.isPending}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selection.kind === 'add' ? (
          <AddAppPanel
            projectId={projectId}
            onAdded={(slug) => {
              invalidate();
              if (slug) select({ kind: 'connector', slug });
            }}
          />
        ) : selection.kind === 'global' ? (
          <GlobalRulesPanel projectId={projectId} />
        ) : active ? (
          <ConnectorDetail
            key={active.slug}
            projectId={projectId}
            connector={active}
            onChanged={invalidate}
            onRemoved={() => {
              invalidate();
              select({ kind: 'add' });
            }}
          />
        ) : (
          <div className="grid h-full place-items-center p-10">
            <EmptyState
              icon={Plug}
              title={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitlePickd2faa3e2',
              )}
              description={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionChoose1df54e4e',
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Left rail ──────────────────────────────────────────────────────────────

function statusDot(c: AdminConnector): string {
  if (c.status === 'error') return 'bg-destructive';
  if (c.authSecret && !c.secretSet) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/** Forward-facing status as a calm badge (the detail header). */
function ConnectorStatusBadge({ connector }: { connector: AdminConnector }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  if (connector.status === 'error')
    return (
      <Badge variant="destructive" size="sm">
        Error
      </Badge>
    );
  if (!connector.authSecret)
    return (
      <Badge variant="outline" size="sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNoAuth45c43558',
        )}
      </Badge>
    );
  if (!connector.secretSet)
    return (
      <Badge variant="warning" size="sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNeedsSetupbefdbc49',
        )}
      </Badge>
    );
  return (
    <Badge variant="success" size="sm">
      Connected
    </Badge>
  );
}

/**
 * The one save affordance for an editable section — a quiet footer that only
 * appears when there are unsaved changes, with an optional Reset. Keeps every
 * section (Connection / Profile / Permissions) consistent and avoids the
 * "button pops in at the bottom" layout jump being different each place.
 */
function SaveBar({
  dirty,
  saving,
  disabled,
  onSave,
  onReset,
  label = 'Save',
}: {
  dirty: boolean;
  saving?: boolean;
  disabled?: boolean;
  onSave: () => void;
  onReset?: () => void;
  label?: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  if (!dirty) return null;
  return (
    <div className="border-border/60 mt-5 flex items-center justify-end gap-2 border-t pt-4">
      <span className="text-muted-foreground mr-auto flex items-center gap-1.5 text-xs">
        <span className="size-1.5 rounded-full bg-amber-500" />
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextUnsavedChanges4682b870',
        )}
      </span>
      {onReset && (
        <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>
          Reset
        </Button>
      )}
      <Button size="sm" onClick={onSave} disabled={saving || disabled} className="gap-1.5">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </Button>
    </div>
  );
}

function ConnectorRail({
  projectId,
  connectors,
  selection,
  onSelect,
  onSync,
  syncing,
}: {
  projectId: string;
  connectors: AdminConnector[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? connectors.filter((c) => c.slug.toLowerCase().includes(q.trim().toLowerCase()))
    : connectors;
  const ready = filtered.filter((c) => !(c.authSecret && !c.secretSet));
  const needsSetup = filtered.filter((c) => c.authSecret && !c.secretSet);
  const isSel = (slug: string) => selection.kind === 'connector' && selection.slug === slug;

  return (
    <nav
      aria-label="Connectors"
      className="border-border/60 bg-muted/20 flex w-72 shrink-0 flex-col border-r"
    >
      <div className="border-border/60 space-y-2 border-b p-3">
        <Button
          size="sm"
          className="w-full justify-start gap-2"
          variant={selection.kind === 'add' ? 'secondary' : 'default'}
          onClick={() => onSelect({ kind: 'add' })}
        >
          <Plus className="h-4 w-4" />
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAddAppb53818fa',
          )}
        </Button>
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrPlaceholderSearch833758cc',
            )}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto p-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <RailItem
          icon={ShieldCheck}
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleGlobal199e18a1',
          )}
          subtitle={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrSubtitleApply5b0aa03c',
          )}
          active={selection.kind === 'global'}
          onClick={() => onSelect({ kind: 'global' })}
        />

        {connectors.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNoConnectors6d11de92',
            )}
          </p>
        ) : (
          <>
            {ready.length > 0 && <RailGroupLabel>Connected</RailGroupLabel>}
            {ready.map((c) => (
              <RailItem
                key={c.slug}
                leading={<ConnectorAppIcon projectId={projectId} connector={c} size="sm" />}
                title={c.name || c.slug}
                subtitle={`${c.actions.length} ${c.actions.length === 1 ? 'tool' : 'tools'}`}
                dot={statusDot(c)}
                active={isSel(c.slug)}
                onClick={() => onSelect({ kind: 'connector', slug: c.slug })}
              />
            ))}
            {needsSetup.length > 0 && (
              <RailGroupLabel>
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNeedsSetupbefdbc49',
                )}
              </RailGroupLabel>
            )}
            {needsSetup.map((c) => (
              <RailItem
                key={c.slug}
                leading={<ConnectorAppIcon projectId={projectId} connector={c} size="sm" />}
                title={c.name || c.slug}
                subtitle={tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrSubtitleNot1feeff2e',
                )}
                dot={statusDot(c)}
                active={isSel(c.slug)}
                onClick={() => onSelect({ kind: 'connector', slug: c.slug })}
              />
            ))}
            {filtered.length === 0 && (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNoMatchf1f9a197',
                )}
                {q}”.
              </p>
            )}
          </>
        )}
      </div>

      <div className="border-border/60 border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground w-full justify-start gap-2"
          onClick={onSync}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSyncFromb820661f',
          )}
        </Button>
      </div>
    </nav>
  );
}

function RailGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground/50 px-3 pt-3 pb-1 text-xs font-medium tracking-wider uppercase">
      {children}
    </div>
  );
}

function appIconTileClass(size: 'sm' | 'lg'): string {
  return size === 'lg' ? 'size-10 rounded-md' : 'size-6 rounded-sm';
}

/**
 * The connected app's real logo. For Pipedream connectors we resolve it from
 * the same catalogue the "Add app" grid uses (connector slug === app slug),
 * falling back to the provider glyph for custom (http/mcp/…) connectors or
 * while the logo loads.
 */
function ConnectorAppIcon({
  projectId,
  connector,
  size = 'lg',
}: {
  projectId: string;
  connector: AdminConnector;
  size?: 'sm' | 'lg';
}) {
  const enabled = connector.provider === 'pipedream' && !!projectId && !!connector.slug;
  const appQuery = useQuery({
    queryKey: ['pipedream-app-icon', projectId, connector.slug],
    queryFn: () => listPipedreamApps(projectId, connector.slug),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
  });
  const imgSrc = appQuery.data?.apps.find((a) => a.slug === connector.slug)?.imgSrc ?? null;

  if (enabled && imgSrc) {
    return (
      <span
        className={cn(
          'border-border/60 bg-card flex shrink-0 items-center justify-center overflow-hidden border',
          appIconTileClass(size),
        )}
      >
        <img
          src={imgSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full object-contain p-1"
        />
      </span>
    );
  }
  return (
    <EntityAvatar
      icon={PROVIDER_ICON[connector.provider] ?? Plug}
      size={size}
      label={connector.name}
    />
  );
}

/** A syntax-highlighted (Shiki) code block — replaces the old plain `<pre>`. */
function CodeSnippet({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border/60 bg-card flex w-full overflow-x-auto rounded-2xl border',
        className,
      )}
    >
      <CodeBlockCode
        code={code}
        language={language}
        className="text-xs [&_pre]:!rounded-none [&_pre]:!bg-transparent [&_pre]:!p-3"
      />
    </div>
  );
}

function RailItem({
  icon: Icon,
  appIcon,
  leading,
  title,
  subtitle,
  dot,
  active,
  onClick,
}: {
  icon?: LucideIcon;
  appIcon?: LucideIcon;
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  dot?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
        active ? 'bg-primary/10' : 'hover:bg-muted/60',
      )}
    >
      {leading ? (
        leading
      ) : appIcon ? (
        <EntityAvatar icon={appIcon} size="sm" />
      ) : Icon ? (
        <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-lg">
          <Icon className="h-3.5 w-3.5" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{title}</span>
        {subtitle && (
          <span className="text-muted-foreground block truncate text-xs">{subtitle}</span>
        )}
      </span>
      {dot && <span className={cn('size-2 shrink-0 rounded-full', dot)} />}
    </button>
  );
}

// ─── Connector detail (profile + permissions + remove) ──────────────────────

function ConnectorDetail({
  projectId,
  connector,
  onChanged,
  onRemoved,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const isPipedream = connector.provider === 'pipedream';
  // Channel connectors (Slack) are credentialed + connected/removed via their
  // platform install in the Channels tab — not the generic credential UI here.
  const isChannel = connector.provider === 'channel';
  // Computer (Agent Computer Tunnel) connectors, like channels, are managed from
  // a dedicated tab (Computers): no generic credential / connect / remove UI.
  const isComputer = connector.provider === 'computer';
  const isManaged = isChannel || isComputer;
  const setSection = useCustomizeStore((s) => s.setSection);
  const connected = connector.secretSet;
  const reconnect = usePipedreamConnect(projectId, connector.slug, onChanged);
  const [credOpen, setCredOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const displayName = connector.name?.trim() || connector.slug;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  useEffect(() => {
    setEditingName(false);
    setNameDraft(displayName);
  }, [connector.slug, displayName]);

  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, connector.slug, nameDraft.trim()),
    onSuccess: () => {
      toast.success('Renamed');
      setEditingName(false);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to rename'),
  });

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, connector.slug),
    onSuccess: () => {
      toast.success(`Removed ${displayName}`);
      onRemoved();
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to remove'),
  });

  const toolCount = connector.actions.length;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-7">
      {/* Header */}
      <div className="flex items-start gap-3.5">
        <ConnectorAppIcon projectId={projectId} connector={connector} size="lg" />
        <div className="min-w-0 flex-1">
          {editingName ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (nameDraft.trim() && nameDraft.trim() !== displayName) rename.mutate();
                else setEditingName(false);
              }}
            >
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="h-9 max-w-xs text-lg font-semibold"
                autoFocus
              />
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="h-9 w-9"
                disabled={rename.isPending}
                aria-label={tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrAriaLabela08f6c74',
                )}
              >
                {rename.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingName(false);
                  setNameDraft(displayName);
                }}
                disabled={rename.isPending}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="group flex items-center gap-2">
              <h2 className="text-foreground truncate text-lg font-semibold">{displayName}</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    aria-label="Rename"
                    className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Rename</TooltipContent>
              </Tooltip>
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            <Badge variant="outline" size="sm">
              {providerLabel(connector.provider)}
            </Badge>
            <ConnectorStatusBadge connector={connector} />
            <InlineMeta>
              <code className="font-mono">{connector.slug}</code>
              {toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null}
            </InlineMeta>
          </div>
        </div>
        {/* When connected, a compact Reconnect/Replace lives in the header.
            When NOT connected, the connect action is a big CTA below — not a
            small header button buried next to the title. (Channel connectors
            are managed from the Channels tab, so neither shows.) */}
        {connector.authSecret &&
          connected &&
          !isChannel &&
          (isPipedream ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => reconnect.mutate()}
              disabled={reconnect.isPending}
            >
              {reconnect.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Reconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => setCredOpen(true)}
            >
              <KeyRound className="h-4 w-4" />
              Replace credential
            </Button>
          ))}
      </div>

      <div className="mt-7 space-y-5">
        {/* Channel connectors (Slack) are credentialed + connected via their
            platform install — point management at the Channels tab instead of
            the generic credential / connection / remove controls. */}
        {isChannel && (
          <InfoBanner
            tone="info"
            icon={MessageSquare}
            title={`${displayName} is managed in Channels`}
            action={
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => setSection('channels')}
              >
                <MessageSquare className="h-4 w-4" />
                Open Channels
              </Button>
            }
          >
            Connecting or disconnecting the workspace, and the bot token, live in the Channels
            tab. Here you control who can use it and review its tools.
          </InfoBanner>
        )}
        {/* Computer connectors are connected + permissioned in the Computers tab
            (device pairing, per-capability grants, audit) — point management
            there instead of the generic credential / connection / remove UI. */}
        {isComputer && (
          <InfoBanner
            tone="info"
            icon={Monitor}
            title={`${displayName} is managed in Computers`}
            action={
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => setSection('computers')}
              >
                <Monitor className="h-4 w-4" />
                Open Computers
              </Button>
            }
          >
            Connect a machine, and grant or revoke per-capability access, in the Computers
            tab. Here you control who can use it and review its tools.
          </InfoBanner>
        )}
        {/* Prominent connect CTA — the first thing you see on an unconnected connector. */}
        {connector.authSecret && !connected && !isChannel && (
          <InfoBanner
            tone="info"
            icon={KeyRound}
            title={`Connect ${displayName}`}
            action={
              <Button
                size="lg"
                className="h-11 shrink-0 gap-2 px-5 font-semibold"
                onClick={() => (isPipedream ? reconnect.mutate() : setCredOpen(true))}
                disabled={isPipedream && reconnect.isPending}
              >
                {isPipedream && reconnect.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {isPipedream ? `Connect ${displayName}` : 'Set credential'}
              </Button>
            }
          >
            {isPipedream
              ? `Authorize your ${displayName} account so the agent and your triggers can use it.`
              : `Add the credential so the agent and your triggers can use ${displayName}.`}
          </InfoBanner>
        )}
        <Tabs defaultValue="profile" className="gap-3">
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
          </TabsList>
          <TabsContent value="profile" className="space-y-5">
            {!isPipedream && !isManaged && (
              <ConnectionSection
                projectId={projectId}
                connector={connector}
                onChanged={onChanged}
              />
            )}
            <ProfileSection projectId={projectId} connector={connector} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="permissions">
            <PermissionsSection projectId={projectId} connector={connector} />
          </TabsContent>
        </Tabs>

        {!isManaged && (
          <SectionCard
            tone="destructive"
            title={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleRemove74be1411',
            )}
            description={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionDeletes0a130396',
            )}
            action={
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            }
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove ${displayName}?`}
        description={
          <>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextThisRemoves82d0b969',
            )}
            <code className="font-mono">{connector.slug}</code>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextFromKortixeb47b479',
            )}
          </>
        }
        confirmLabel={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrConfirmLabelRemoved2120640',
        )}
        confirmVariant="destructive"
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      <SetCredentialDialog
        projectId={projectId}
        connector={credOpen ? connector : null}
        open={credOpen}
        onOpenChange={setCredOpen}
        onSaved={onChanged}
      />
    </div>
  );
}

// ─── Profile section (the account + who can use it) ─────────────────────────

function sharingToAccess(s: ConnectorSharing | null | undefined): {
  mode: 'project' | 'private' | 'members';
  memberIds: string[];
} {
  if (!s || s.mode === 'project') return { mode: 'project', memberIds: [] };
  if (s.mode === 'private') return { mode: 'private', memberIds: [] };
  return { mode: 'members', memberIds: s.memberIds ?? [] };
}

function ProfileSection({
  projectId,
  connector,
  onChanged,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // Channel connectors (Slack) are always one shared install token, and computer
  // connectors have no credential at all — the per-user credential mode doesn't
  // apply to either, so we hide that choice and keep only "who can use it".
  const isChannel = connector.provider === 'channel' || connector.provider === 'computer';
  const [credential, setCredential] = useState<'shared' | 'per_user'>(connector.credentialMode);
  const initialAccess = sharingToAccess(connector.sharing);
  const [access, setAccess] = useState(initialAccess.mode);
  const [memberIds, setMemberIds] = useState<string[]>(initialAccess.memberIds);

  useEffect(() => {
    setCredential(connector.credentialMode);
    const a = sharingToAccess(connector.sharing);
    setAccess(a.mode);
    setMemberIds(a.memberIds);
  }, [connector]);

  const modeChanged = credential !== connector.credentialMode;
  const saved = sharingToAccess(connector.sharing);
  const accessChanged =
    credential === 'shared' &&
    (access !== saved.mode ||
      (access === 'members' &&
        memberIds.slice().sort().join() !== saved.memberIds.slice().sort().join()));
  const dirty = modeChanged || accessChanged;

  const reset = () => {
    setCredential(connector.credentialMode);
    const a = sharingToAccess(connector.sharing);
    setAccess(a.mode);
    setMemberIds(a.memberIds);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (modeChanged) await setConnectorCredentialMode(projectId, connector.slug, credential);
      const intent: ConnectorSharing =
        credential === 'per_user' || access === 'project'
          ? { mode: 'project' }
          : access === 'private'
            ? { mode: 'private', ownerId: '' }
            : { mode: 'members', memberIds };
      if (modeChanged || accessChanged)
        await setConnectorSharing(projectId, connector.slug, intent);
    },
    onSuccess: () => {
      toast.success('Profile saved');
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to save profile'),
  });

  return (
    <SectionCard
      title="Profile"
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionThe33be3829',
      )}
    >
      {!isChannel && (
        <RadioGroup
          value={credential}
          onValueChange={(v) => setCredential(v as 'shared' | 'per_user')}
          className="space-y-2"
        >
          <ShareOption
            value="shared"
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelOnec565aa8b',
            )}
            desc={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescConnect5c9357c5',
            )}
          />
          <ShareOption
            value="per_user"
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelEache6c3d706',
            )}
            desc={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescEvery9811ed05',
            )}
          />
        </RadioGroup>
      )}

      {modeChanged && (
        <InfoBanner
          tone="warning"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleThis580eabca',
          )}
          className="mt-3"
        >
          {credential === 'per_user'
            ? 'The shared profile stops being used — each member will be asked to connect their own.'
            : 'Each member’s personal profile stops being used — connect one shared profile after saving.'}
        </InfoBanner>
      )}

      {credential === 'shared' && (
        <div className="mt-4 space-y-1.5">
          <Label className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextWhoCana896d6c5',
            )}
          </Label>
          <SharingPicker
            projectId={projectId}
            showHeading={false}
            value={{ mode: access, memberIds }}
            onChange={(s) => {
              setAccess(s.mode);
              setMemberIds(s.memberIds);
            }}
            copy={{
              project: {
                label: 'Everyone in the project',
                desc: 'Any member can use the shared profile',
              },
              private: { label: 'Only me', desc: 'Just you' },
              members: { label: 'Specific members', desc: 'A chosen list of members' },
            }}
          />
        </div>
      )}

      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        disabled={credential === 'shared' && access === 'members' && memberIds.length === 0}
        onSave={() => save.mutate()}
        onReset={reset}
        label={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSave5ba72522',
        )}
      />
    </SectionCard>
  );
}

// ─── Connection section (the connector definition: provider + url + auth) ────

function configToDraft(cfg: ConnectorConfig): ConnectorDraftInput {
  return {
    slug: cfg.slug,
    provider: cfg.provider,
    url: cfg.url ?? undefined,
    transport: cfg.transport ?? undefined,
    endpoint: cfg.endpoint ?? undefined,
    baseUrl: cfg.baseUrl ?? undefined,
    spec: cfg.spec ?? undefined,
    auth: {
      type: cfg.auth.type,
      in: cfg.auth.in,
      name: cfg.auth.name ?? undefined,
      prefix: cfg.auth.prefix ?? undefined,
    },
  };
}

/** Stable signature over the connection fields — drives the dirty/Save state. */
function connectionSig(d: ConnectorDraftInput): string {
  return JSON.stringify({
    provider: d.provider,
    url: d.url ?? '',
    transport: d.transport ?? '',
    endpoint: d.endpoint ?? '',
    baseUrl: d.baseUrl ?? '',
    spec: d.spec ?? '',
    auth: {
      type: d.auth?.type ?? 'none',
      in: d.auth?.in ?? 'header',
      name: d.auth?.name ?? '',
      prefix: d.auth?.prefix ?? '',
    },
  });
}

/**
 * Edit an existing connector's definition (the same fields as "Add connector"),
 * written back to kortix.toml via the create-or-update path. Credential mode and
 * access are owned by Profile, so we resend the current mode to leave it intact.
 */
function ConnectionSection({
  projectId,
  connector,
  onChanged,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['connector-config', projectId, connector.slug],
    queryFn: () => getConnectorConfig(projectId, connector.slug),
    staleTime: 5_000,
  });

  const [draft, setDraft] = useState<ConnectorDraftInput | null>(null);
  const [savedSig, setSavedSig] = useState('');
  useEffect(() => {
    if (!configQuery.data) return;
    const d = configToDraft(configQuery.data);
    setDraft(d);
    setSavedSig(connectionSig(d));
  }, [configQuery.data]);

  const dirty = !!draft && connectionSig(draft) !== savedSig;

  const reset = () => {
    if (configQuery.data) setDraft(configToDraft(configQuery.data));
  };

  const save = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        ...draft!,
        slug: connector.slug,
        credential: connector.credentialMode,
      }),
    onSuccess: () => {
      toast.success('Connection saved');
      queryClient.invalidateQueries({ queryKey: ['connector-config', projectId, connector.slug] });
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to save connection'),
  });

  return (
    <SectionCard
      title="Connection"
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionHowa31daf50',
      )}
    >
      {configQuery.isError ? (
        <InfoBanner
          tone="destructive"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleCouldn277b73a0',
          )}
          action={
            <Button size="sm" variant="outline" onClick={() => configQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {(configQuery.error as Error)?.message ?? 'Unknown error'}
        </InfoBanner>
      ) : configQuery.isLoading || !draft ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full rounded-2xl" />
          <Skeleton className="h-9 w-2/3 rounded-2xl" />
          <Skeleton className="h-9 w-full rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-4">
          <ConnectorConfigFields draft={draft} onChange={setDraft} />
          <SaveBar
            dirty={dirty}
            saving={save.isPending}
            disabled={!connectionValid(draft)}
            onSave={() => save.mutate()}
            onReset={reset}
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSave8c6f945f',
            )}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ─── Permissions section (per-tool + glob/regex rules + inline preview) ──────

type PolicyChoice = 'default' | ConnectorPolicyAction;

const POLICY_CHOICES: { value: PolicyChoice; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'always_run', label: 'Allow' },
  { value: 'require_approval', label: 'Ask' },
  { value: 'block', label: 'Block' },
];

const POLICY_LABEL: Record<ConnectorPolicyAction, { label: string; tint: string }> = {
  always_run: { label: 'Allow', tint: 'text-emerald-600 dark:text-emerald-400' },
  require_approval: { label: 'Ask', tint: 'text-amber-600 dark:text-amber-400' },
  block: { label: 'Block', tint: 'text-destructive' },
};

/** Quiet per-row permission control: muted "Default", colored only when overridden. */
function PermissionPicker({
  value,
  onChange,
}: {
  value: PolicyChoice;
  onChange: (c: PolicyChoice) => void;
}) {
  const meta =
    value === 'default'
      ? { label: 'Default', tint: 'text-muted-foreground' }
      : { label: POLICY_LABEL[value].label, tint: POLICY_LABEL[value].tint };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'hover:bg-muted inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
            meta.tint,
          )}
        >
          {meta.label}
          <ChevronDown className="size-3 opacity-40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-28">
        {POLICY_CHOICES.map((c) => (
          <DropdownMenuItem key={c.value} onClick={() => onChange(c.value)} className="text-xs">
            <span className={cn(c.value !== 'default' && POLICY_LABEL[c.value].tint)}>
              {c.label}
            </span>
            {c.value === value && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

let _rid = 0;
const ruleId = () => `r${++_rid}`;

function isPatternMatch(m: string): boolean {
  return m === '*' || m.includes('*') || /^\/.*\/[a-z]*$/.test(m);
}

function clientMatch(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  const rx = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  try {
    if (rx) {
      const flags = rx[2]!.includes('i') ? rx[2]! : `${rx[2]}i`;
      return new RegExp(rx[1]!, flags).test(path);
    }
    const glob = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    return new RegExp(glob, 'i').test(path);
  } catch {
    return false;
  }
}

function policiesSig(
  perTool: Record<string, ConnectorPolicyAction>,
  rules: { match: string; action: ConnectorPolicyAction }[],
): string {
  const pt = Object.entries(perTool)
    .filter(([, a]) => a)
    .sort()
    .map(([k, a]) => `${k}=${a}`)
    .join(',');
  const rl = rules
    .filter((r) => r.match.trim())
    .map((r) => `${r.match.trim()}=${r.action}`)
    .join(',');
  return `${pt}|${rl}`;
}

function tsSignature(slug: string, action: ConnectorAction): string {
  const props =
    (action.inputSchema as { properties?: Record<string, { type?: string }> } | null)?.properties ??
    {};
  const required: string[] = (action.inputSchema as { required?: string[] } | null)?.required ?? [];
  const args = Object.entries(props).map(([k, v]) => {
    const t = v?.type === 'integer' ? 'number' : (v?.type ?? 'string');
    return `  ${k}${required.includes(k) ? '' : '?'}: ${t};`;
  });
  const argBlock = args.length ? `{\n${args.join('\n')}\n}` : '{}';
  return `executor.call("${slug}", "${action.path}", ${argBlock}): Promise<unknown>`;
}

function PermissionsSection({
  projectId,
  connector,
}: {
  projectId: string;
  connector: AdminConnector;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const tools = connector.actions;
  const toolPaths = useMemo(() => new Set(tools.map((t) => t.path)), [tools]);

  const policiesQuery = useQuery({
    queryKey: ['connector-policies', projectId, connector.slug],
    queryFn: () => getConnectorPolicies(projectId, connector.slug),
    staleTime: 5_000,
  });

  const [perTool, setPerTool] = useState<Record<string, ConnectorPolicyAction>>({});
  const [rules, setRules] = useState<
    { id: string; match: string; action: ConnectorPolicyAction }[]
  >([]);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [serverSig, setServerSig] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!policiesQuery.data) return;
    const pt: Record<string, ConnectorPolicyAction> = {};
    const rl: { id: string; match: string; action: ConnectorPolicyAction }[] = [];
    for (const p of policiesQuery.data.policies) {
      if (!isPatternMatch(p.match) && toolPaths.has(p.match)) pt[p.match] = p.action;
      else rl.push({ id: ruleId(), match: p.match, action: p.action });
    }
    setPerTool(pt);
    setRules(rl);
    setShowRules(rl.length > 0);
    setServerSig(policiesSig(pt, rl));
  }, [policiesQuery.data, toolPaths]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? tools.filter((t) => `${t.path} ${t.description ?? ''}`.toLowerCase().includes(q))
      : tools;
  }, [tools, search]);

  const dirty = policiesSig(perTool, rules) !== serverSig;

  const save = useMutation({
    mutationFn: () => {
      const policies: ConnectorPolicyRule[] = [
        ...tools
          .filter((t) => perTool[t.path])
          .map((t) => ({ match: t.path, action: perTool[t.path]! })),
        ...rules
          .filter((r) => r.match.trim())
          .map((r) => ({ match: r.match.trim(), action: r.action })),
      ];
      return setConnectorPolicies(projectId, connector.slug, policies);
    },
    onSuccess: () => {
      toast.success('Permissions saved');
      queryClient.invalidateQueries({
        queryKey: ['connector-policies', projectId, connector.slug],
      });
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to save permissions'),
  });

  const setChoice = (path: string, choice: PolicyChoice) =>
    setPerTool((m) => {
      const next = { ...m };
      if (choice === 'default') delete next[path];
      else next[path] = choice;
      return next;
    });
  const governingRule = (path: string) =>
    rules.find((r) => r.match.trim() && clientMatch(r.match.trim(), path));

  // ── Multi-select + bulk apply ──
  const filteredPaths = useMemo(() => filtered.map((t) => t.path), [filtered]);
  const allFilteredSelected =
    filteredPaths.length > 0 && filteredPaths.every((p) => selected.has(p));
  const someFilteredSelected = filteredPaths.some((p) => selected.has(p));
  const toggleSel = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const toggleAllFiltered = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allFilteredSelected) filteredPaths.forEach((p) => n.delete(p));
      else filteredPaths.forEach((p) => n.add(p));
      return n;
    });
  const applyBulk = (choice: PolicyChoice) => {
    setPerTool((m) => {
      const next = { ...m };
      for (const p of selected) {
        if (choice === 'default') delete next[p];
        else next[p] = choice;
      }
      return next;
    });
  };

  const reset = () => {
    const pt: Record<string, ConnectorPolicyAction> = {};
    const rl: { id: string; match: string; action: ConnectorPolicyAction }[] = [];
    for (const p of policiesQuery.data?.policies ?? []) {
      if (!isPatternMatch(p.match) && toolPaths.has(p.match)) pt[p.match] = p.action;
      else rl.push({ id: ruleId(), match: p.match, action: p.action });
    }
    setPerTool(pt);
    setRules(rl);
    setShowRules(rl.length > 0);
    setSelected(new Set());
  };

  return (
    <SectionCard
      title="Permissions"
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionWhat4e375237',
      )}
      action={
        tools.length > 6 ? (
          <div className="relative w-48">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrPlaceholderFiltere5f64efb',
              )}
              className="h-8 pl-8 text-sm"
            />
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {tools.length === 0 ? (
          <InfoBanner
            tone="neutral"
            title={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleNo0e439be9',
            )}
          >
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextConnectThec56fd30b',
            )}
          </InfoBanner>
        ) : (
          <div className="border-border/60 overflow-hidden rounded-2xl border">
            {/* Select-all + bulk apply */}
            <div className="border-border/60 bg-muted/30 flex h-9 items-center gap-2 border-b px-3">
              <Checkbox
                checked={
                  allFilteredSelected ? true : someFilteredSelected ? 'indeterminate' : false
                }
                onCheckedChange={toggleAllFiltered}
                aria-label={tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrAriaLabel924a321f',
                )}
                className="size-3.5"
              />
              {selected.size > 0 ? (
                <>
                  <span className="text-foreground text-xs font-medium">
                    {selected.size} selected
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSetToff934ec7',
                    )}
                  </span>
                  {POLICY_CHOICES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => applyBulk(c.value)}
                      className={cn(
                        'hover:bg-muted rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
                        c.value === 'default'
                          ? 'text-muted-foreground'
                          : POLICY_LABEL[c.value].tint,
                      )}
                    >
                      {c.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="text-muted-foreground hover:text-foreground ml-auto text-xs transition-colors"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {filtered.length} {filtered.length === 1 ? 'tool' : 'tools'}{' '}
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextTapA9c38f324',
                  )}
                </span>
              )}
            </div>

            <div className="max-h-[52vh] overflow-y-auto">
              {filtered.map((t) => {
                const explicit = perTool[t.path];
                const ruled = !explicit ? governingRule(t.path) : undefined;
                const isOpen = expanded === t.path;
                const isSel = selected.has(t.path);
                return (
                  <div key={t.path} className="border-border/60 border-t first:border-t-0">
                    <div
                      className={cn(
                        'group flex items-center gap-2.5 px-3 py-1.5 transition-colors',
                        isSel ? 'bg-primary/[0.05]' : 'hover:bg-muted/30',
                      )}
                    >
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={() => toggleSel(t.path)}
                        aria-label={`Select ${t.path}`}
                        className={cn(
                          'size-3.5 shrink-0 transition-opacity',
                          isSel
                            ? ''
                            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : t.path)}
                        className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      >
                        <span className="text-foreground shrink-0 font-mono text-xs">{t.path}</span>
                        {t.description && (
                          <span className="text-muted-foreground/70 truncate text-xs">
                            {t.description}
                          </span>
                        )}
                      </button>
                      {ruled && (
                        <span
                          className={cn(
                            'shrink-0 text-xs opacity-80',
                            POLICY_LABEL[ruled.action].tint,
                          )}
                          title={`From pattern rule: ${ruled.match}`}
                        >
                          {POLICY_LABEL[ruled.action].label}{' '}
                          {tI18nHardcoded.raw(
                            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextRulebbcba279',
                          )}
                        </span>
                      )}
                      <ChevronRight
                        className={cn(
                          'size-3 shrink-0 transition',
                          isOpen
                            ? 'text-muted-foreground/70 rotate-90'
                            : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100',
                        )}
                      />
                      <PermissionPicker
                        value={explicit ?? 'default'}
                        onChange={(c) => setChoice(t.path, c)}
                      />
                    </div>
                    {isOpen && (
                      <div className="bg-muted/20 space-y-3 px-4 pt-1 pb-3">
                        <div className="flex items-center gap-2">
                          <Badge variant={RISK_VARIANT[t.risk]} size="sm">
                            {t.risk}
                          </Badge>
                          {t.description && (
                            <span className="text-muted-foreground text-xs">{t.description}</span>
                          )}
                        </div>
                        <CodeSnippet
                          code={tsSignature(connector.slug, t)}
                          language="typescript"
                        />
                        <CodeSnippet
                          code={JSON.stringify(
                            t.inputSchema ?? { type: 'object', properties: {} },
                            null,
                            2,
                          )}
                          language="json"
                          className="max-h-56 overflow-auto"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNoTools69d22076',
                  )}
                  {search}”.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Advanced pattern rules */}
        {tools.length > 0 && (
          <div className="border-border/60 rounded-2xl border">
            <button
              type="button"
              onClick={() => setShowRules((s) => !s)}
              className="text-foreground hover:bg-muted/40 flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left text-sm font-medium"
            >
              <ChevronRight
                className={cn(
                  'text-muted-foreground h-4 w-4 transition-transform',
                  showRules && 'rotate-90',
                )}
              />
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextPatternRules6a07e5a7',
              )}
              {rules.length > 0 && (
                <Badge variant="secondary" size="sm">
                  {rules.length}
                </Badge>
              )}
              <span className="text-muted-foreground ml-auto text-xs font-normal">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextCoverMany170203ce',
                )}
              </span>
            </button>
            {showRules && (
              <div className="border-border/60 space-y-2 border-t px-3 py-3">
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextMatchBy60561318',
                  )}
                  <code className="bg-muted rounded px-1 font-mono">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSend0110e0d9',
                    )}
                  </code>
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextOrRegexf5a26a27',
                  )}
                  <code className="bg-muted rounded px-1 font-mono">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextDelete37c77402',
                    )}
                  </code>
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextPerTool4d0d7e9f',
                  )}
                </p>
                {rules.map((r) => (
                  <div key={r.id} className="flex items-center gap-2">
                    <Input
                      value={r.match}
                      onChange={(e) =>
                        setRules((rs) =>
                          rs.map((x) => (x.id === r.id ? { ...x, match: e.target.value } : x)),
                        )
                      }
                      placeholder={tI18nHardcoded.raw(
                        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrPlaceholderSend3b0a4ee1',
                      )}
                      className="h-8 flex-1 font-mono text-xs"
                    />
                    <Select
                      value={r.action}
                      onValueChange={(v) =>
                        setRules((rs) =>
                          rs.map((x) =>
                            x.id === r.id ? { ...x, action: v as ConnectorPolicyAction } : x,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-8 w-[100px] shrink-0 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          ['always_run', 'require_approval', 'block'] as ConnectorPolicyAction[]
                        ).map((a) => (
                          <SelectItem key={a} value={a} className="text-xs">
                            {POLICY_LABEL[a].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="hover:text-destructive h-8 w-8 shrink-0"
                      onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}
                      aria-label={tI18nHardcoded.raw(
                        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrAriaLabeld2296c34',
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() =>
                    setRules((rs) => [
                      ...rs,
                      { id: ruleId(), match: '', action: 'require_approval' },
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAddRule873a093f',
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onReset={reset}
        label={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSave783950c7',
        )}
      />
    </SectionCard>
  );
}

// ─── Global rules ────────────────────────────────────────────────────────────

function GlobalRulesPanel({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-7">
      <div className="mb-6 flex items-start gap-3.5">
        <EntityAvatar icon={ShieldCheck} size="lg" />
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextGlobalRules436bcada',
            )}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextPermissionsThat70379f46',
            )}
          </p>
        </div>
      </div>
      <PoliciesPanel projectId={projectId} />
    </div>
  );
}

// ─── Add app (inline panel: catalogue + custom) ──────────────────────────────

interface ConnectorSetup {
  credential: 'shared' | 'per_user';
  access: 'project' | 'private' | 'members';
  memberIds: string[];
}

const DEFAULT_CONNECTOR_SETUP: ConnectorSetup = {
  credential: 'shared',
  access: 'project',
  memberIds: [],
};

function setupToSharing(s: ConnectorSetup): ConnectorSharing {
  if (s.access === 'project') return { mode: 'project' };
  if (s.access === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds };
}

/**
 * Profile + access asked when adding. "Who can use it" only applies to a shared
 * profile — for per-user there's no shared credential to gate.
 */
function ConnectorSetupFields({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: ConnectorSetup;
  onChange: (s: ConnectorSetup) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const isShared = value.credential === 'shared';
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Profile</Label>
          <p className="text-muted-foreground text-xs">
            How this connection is set up for the project.
          </p>
        </div>
        <RadioGroup
          value={value.credential}
          onValueChange={(v) => {
            const credential = v as ConnectorSetup['credential'];
            onChange(
              credential === 'shared'
                ? { ...value, credential }
                : { ...value, credential, access: 'project', memberIds: [] },
            );
          }}
          className="space-y-2"
        >
          <ShareOption
            value="shared"
            label="One shared profile across the whole project (recommended)"
            desc="Connect it once. Everyone — and every trigger/cron — uses the same account. Best for almost all cases."
          />
          <ShareOption
            value="per_user"
            label="Each member brings their own profile"
            desc="Every member connects their own account, and only ever uses their own. Pick this only when each person must act as themselves."
          />
        </RadioGroup>
      </div>
      {isShared && (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <Label>
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextWhoCana896d6c5',
              )}
            </Label>
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextMembersAllowede220ec02',
              )}
            </p>
          </div>
          <SharingPicker
            projectId={projectId}
            showHeading={false}
            value={{ mode: value.access, memberIds: value.memberIds }}
            onChange={(s) => onChange({ ...value, access: s.mode, memberIds: s.memberIds })}
            copy={{
              project: {
                label: 'Everyone in the project',
                desc: 'Any member can use the shared profile',
              },
              private: { label: 'Only me', desc: 'Just you' },
              members: { label: 'Specific members', desc: 'A chosen list of members' },
            }}
          />
        </div>
      )}
    </div>
  );
}

function AddAppPanel({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (slug?: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-7">
      <div className="mb-5">
        <h2 className="text-foreground text-lg font-semibold">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAddA02e6aec7',
          )}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextOneClicke48f34c9',
          )}
        </p>
      </div>
      <Tabs defaultValue="apps">
        <TabsList>
          <TabsTrigger value="apps">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextEasyConnect19ca1c01',
            )}
          </TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>
        <TabsContent value="apps" className="mt-4">
          <AppCatalogue projectId={projectId} onAdded={onAdded} />
        </TabsContent>
        <TabsContent value="custom" className="mt-4">
          <CustomConnectorForm projectId={projectId} onAdded={onAdded} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Easy-connect app catalogue — searchable card grid with "Load more". */
function AppCatalogue({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (slug?: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [q, setQ] = useState('');
  const appsQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', projectId, q],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(projectId, q || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });
  const [configApp, setConfigApp] = useState<{ slug: string; name: string } | null>(null);
  const apps = (appsQuery.data?.pages ?? []).flatMap((p) => p.apps);
  const notConfigured =
    appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');

  return (
    <div>
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrPlaceholderSearch9d26aaaa',
          )}
          className="h-10 pl-9"
        />
      </div>
      <div className="max-h-[62vh] overflow-y-auto py-4">
        {notConfigured ? (
          <InfoBanner
            tone="neutral"
            title={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleEasy58e9c7b1',
            )}
          >
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextEasyConnectc07266e0',
            )}
          </InfoBanner>
        ) : appsQuery.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] w-full rounded-2xl" />
            ))}
          </div>
        ) : apps.length === 0 ? (
          <EmptyState
            icon={Search}
            title={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleNof8067eda',
            )}
            description={q ? `Nothing matches "${q}".` : 'Try a search.'}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {apps.map((app) => (
                <button
                  key={app.slug}
                  type="button"
                  onClick={() => setConfigApp({ slug: app.slug, name: app.name })}
                  className="group border-border/60 bg-card hover:border-primary/40 hover:bg-primary/[0.03] focus-visible:ring-primary/50 flex flex-col rounded-2xl border p-4 text-left transition-all hover:shadow-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <div className="flex items-center gap-3">
                    {app.imgSrc ? (
                      <img
                        src={app.imgSrc}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-lg object-contain"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <EntityAvatar icon={Zap} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-semibold">
                        {app.name}
                      </div>
                      {app.categories?.[0] && (
                        <div className="text-muted-foreground truncate text-xs">
                          {app.categories[0]}
                        </div>
                      )}
                    </div>
                    <Plus className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors" />
                  </div>
                  <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
                    {app.description ?? ' '}
                  </p>
                </button>
              ))}
            </div>
            {appsQuery.hasNextPage && (
              <div className="flex justify-center pt-5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => appsQuery.fetchNextPage()}
                  disabled={appsQuery.isFetchingNextPage}
                  className="h-9 px-8"
                >
                  {appsQuery.isFetchingNextPage ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {tI18nHardcoded.raw(
                        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextLoading7131cc18',
                      )}
                    </>
                  ) : (
                    'Load more'
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <ConfigureAppDialog
        projectId={projectId}
        app={configApp}
        open={!!configApp}
        onOpenChange={(o) => !o && setConfigApp(null)}
        onAdded={(slug) => {
          setConfigApp(null);
          onAdded(slug);
        }}
      />
    </div>
  );
}

/** The pick-an-app → choose profile/access step. Small focused modal. */
function ConfigureAppDialog({
  projectId,
  app,
  open,
  onOpenChange,
  onAdded,
}: {
  projectId: string;
  app: { slug: string; name: string } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: (slug: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // Default to ONE SHARED profile for the whole project. It's the right choice
  // for the overwhelming majority of cases (the agent + crons just use it, no
  // per-member setup), and it makes triggers work without each member having to
  // connect their own account. "Each member brings their own" stays a one-click
  // opt-in for the genuine BYO case.
  const [setup, setSetup] = useState<ConnectorSetup>(DEFAULT_CONNECTOR_SETUP);
  useEffect(() => {
    if (open && app?.slug) setSetup(DEFAULT_CONNECTOR_SETUP);
  }, [open, app?.slug]);
  const save = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        slug: app!.slug,
        provider: 'pipedream',
        app: app!.slug,
        account: 'default',
        credential: setup.credential,
        sharing: setupToSharing(setup),
      }),
    onSuccess: () => {
      toast.success(`Added ${app!.name} — click Connect to authorize`);
      onAdded(app!.slug);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to add'),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
          <DialogTitle>Add {app?.name}</DialogTitle>
          <DialogDescription>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextChooseThe068cf710',
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[58vh] overflow-y-auto px-6 py-5">
          <ConnectorSetupFields projectId={projectId} value={setup} onChange={setSetup} />
        </div>
        <DialogFooter className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending || (setup.access === 'members' && setup.memberIds.length === 0)
            }
            className="gap-1.5"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The connection definition — provider + provider-specific fields + auth. Shared
 * by the "Add connector" custom form and the per-connector "Connection" editor.
 * The slug is the connector's identity, so it's locked once created.
 */
function ConnectorConfigFields({
  draft,
  onChange,
  slugEditable,
}: {
  draft: ConnectorDraftInput;
  onChange: (d: ConnectorDraftInput) => void;
  slugEditable?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const set = (patch: Partial<ConnectorDraftInput>) => onChange({ ...draft, ...patch });
  const setAuth = (patch: Partial<NonNullable<ConnectorDraftInput['auth']>>) =>
    onChange({ ...draft, auth: { ...draft.auth, ...patch } });
  const p = draft.provider;
  const needsAuth = p !== 'pipedream';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug">
          <Input
            value={draft.slug}
            onChange={(e) =>
              set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })
            }
            placeholder="my-api"
            className="font-mono"
            disabled={!slugEditable}
            required
          />
        </Field>
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select
            value={p}
            onValueChange={(v) => set({ provider: v as ConnectorDraftInput['provider'] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openapi">OpenAPI</SelectItem>
              <SelectItem value="graphql">GraphQL</SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {p === 'openapi' && (
        <Field
          label={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSpec4235864d',
          )}
        >
          <Input
            value={draft.spec ?? ''}
            onChange={(e) => set({ spec: e.target.value })}
            placeholder="https://…/openapi.json"
            required
          />
        </Field>
      )}
      {p === 'graphql' && (
        <>
          <Field label="Endpoint">
            <Input
              value={draft.endpoint ?? ''}
              onChange={(e) => set({ endpoint: e.target.value })}
              placeholder="https://api/graphql"
              required
            />
          </Field>
          <Field
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSDL2325b707',
            )}
          >
            <Input
              value={draft.spec ?? ''}
              onChange={(e) => set({ spec: e.target.value })}
              placeholder=".kortix/executor/schema.graphql"
            />
          </Field>
        </>
      )}
      {p === 'mcp' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="URL">
            <Input
              value={draft.url ?? ''}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp…/mcp"
              required
            />
          </Field>
          <div className="space-y-1.5">
            <Label>Transport</Label>
            <Select
              value={draft.transport ?? 'http'}
              onValueChange={(v) => set({ transport: v as 'http' | 'sse' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {p === 'http' && (
        <>
          <Field
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelBase744ecef9',
            )}
          >
            <Input
              value={draft.baseUrl ?? ''}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://api.internal"
              required
            />
          </Field>
          <Field
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelRoutes38b14436',
            )}
          >
            <Input
              value={draft.spec ?? ''}
              onChange={(e) => set({ spec: e.target.value })}
              placeholder=".kortix/executor/routes.toml"
            />
          </Field>
        </>
      )}
      {needsAuth && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Auth</Label>
            <Select
              value={draft.auth?.type ?? 'none'}
              onValueChange={(v) => setAuth({ type: v as 'none' | 'bearer' | 'basic' | 'custom' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer</SelectItem>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="custom">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextCustomHeader1e0e82ed',
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.auth?.type === 'custom' && (
            <Field
              label={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelHeader9b2e0143',
              )}
            >
              <Input
                value={draft.auth?.name ?? ''}
                onChange={(e) => setAuth({ name: e.target.value })}
                placeholder="X-API-Key"
                required
              />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

/** Required connection fields per provider — gates the save button (server re-validates). */
function connectionValid(d: ConnectorDraftInput): boolean {
  if (d.auth?.type === 'custom' && !d.auth.name?.trim()) return false;
  if (d.provider === 'mcp') return !!d.url?.trim();
  if (d.provider === 'openapi') return !!d.spec?.trim();
  if (d.provider === 'graphql') return !!d.endpoint?.trim();
  if (d.provider === 'http') return !!d.baseUrl?.trim();
  return true;
}

function CustomConnectorForm({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (slug?: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [draft, setDraft] = useState<ConnectorDraftInput>({
    slug: '',
    provider: 'openapi',
    auth: { type: 'none' },
  });
  const [setup, setSetup] = useState<ConnectorSetup>(DEFAULT_CONNECTOR_SETUP);
  const save = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        ...draft,
        credential: setup.credential,
        sharing: setupToSharing(setup),
      }),
    onSuccess: () => {
      toast.success(`Added ${draft.slug}`);
      onAdded(draft.slug);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to add connector'),
  });
  const authActive = !!draft.auth?.type && draft.auth.type !== 'none';

  return (
    <SectionCard
      title={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleCustom9bbc53a1',
      )}
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionConnect813a46e7',
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <ConnectorConfigFields draft={draft} onChange={setDraft} slugEditable />
        {authActive && (
          <InfoBanner tone="info">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextYouLle5def626',
            )}
          </InfoBanner>
        )}
        <div className="border-border/60 border-t pt-4">
          <ConnectorSetupFields projectId={projectId} value={setup} onChange={setSetup} />
        </div>
        <div className="border-border/60 flex justify-end border-t pt-4">
          <Button
            type="submit"
            disabled={
              !draft.slug ||
              save.isPending ||
              !connectionValid(draft) ||
              (setup.access === 'members' && setup.memberIds.length === 0)
            }
            className="gap-1.5"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAddConnectore01e22fc',
            )}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// ─── Set credential (custom connectors) ──────────────────────────────────────

function SetCredentialDialog({
  projectId,
  connector,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  connector: AdminConnector | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => setConnectorCredential(projectId, connector!.slug, value),
    onSuccess: () => {
      toast.success('Credential saved');
      setValue('');
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save'),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
          <DialogTitle>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSetCredential5e9704a8',
            )}
            {connector?.slug}
          </DialogTitle>
          <DialogDescription>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextStoredEncryptedc3eb374b',
            )}
            <code className="font-mono">{connector?.authSecret}</code>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAndResolved8293aa3e',
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value) save.mutate();
          }}
        >
          <div className="space-y-1.5 px-6 py-5">
            <Label>Value</Label>
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="••••••••"
              className="font-mono"
              autoFocus
            />
          </div>
          <DialogFooter className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value || save.isPending} className="gap-1.5">
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function MasterDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="border-border/60 bg-muted/20 w-72 shrink-0 space-y-2 border-r p-3">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-7">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    </div>
  );
}
