'use client';

/**
 * Connectors — a master/detail surface (no management dialogs). The left rail
 * lists every connected app + a pinned "Global rules" entry + "Add app"; the
 * right pane manages the SELECTED app entirely inline: its Profile (the account
 * it signs in with + who can use it), its Permissions (per-tool Allow/Ask/Block
 * + glob/regex rules with inline schema preview), and removal. One place per
 * app — the model is App → Profile → Tools → Permissions.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFrontendClient } from '@pipedream/sdk/browser';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup } from '@/components/ui/radio-group';
import { SectionCard } from '@/components/ui/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PoliciesPanel } from '@/components/projects/policies-panel';
import { SharingPicker, ShareOption } from '@/components/projects/sharing-picker';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
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

const PROVIDER_ICON: Record<AdminConnector['provider'], LucideIcon> = {
  pipedream: Zap,
  mcp: Boxes,
  openapi: Globe,
  graphql: Globe,
  http: Globe,
};

const RISK_VARIANT: Record<ConnectorAction['risk'], 'outline' | 'secondary' | 'destructive'> = {
  read: 'outline',
  write: 'secondary',
  destructive: 'destructive',
};


/** Forward-facing provider label — "App" for the 1-click (Pipedream) connectors. */
function providerLabel(p: AdminConnector['provider']): string {
  return p === 'pipedream' ? 'App' : p.toUpperCase();
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
            onError: (err: unknown) => reject(new Error((err as Error)?.message || 'Connection cancelled')),
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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CustomizeSectionHeader icon={Plug} title="Connectors" />
      <ConnectorsMasterDetail projectId={projectId} />
    </div>
  );
}

function ConnectorsMasterDetail({ projectId }: { projectId: string }) {
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
      if (res.errors.length) toast.warning(`Synced ${res.synced}, ${res.errors.length} with issues`);
      else toast.success(`Synced ${res.synced} connector(s)`);
    },
    onError: (err: Error) => toast.error(err.message || 'Sync failed'),
  });

  if (query.isLoading) return <MasterDetailSkeleton />;
  if (isForbidden) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <InfoBanner tone="warning" icon={ShieldAlert} title="Admin access required">
          Only project managers can manage connectors.
        </InfoBanner>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <InfoBanner tone="destructive" title="Failed to load connectors" action={<Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button>}>
          {(query.error as Error)?.message ?? 'Unknown error'}
        </InfoBanner>
      </div>
    );
  }

  const active = selection.kind === 'connector' ? connectors.find((c) => c.slug === selection.slug) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1">
      <ConnectorRail
        connectors={connectors}
        selection={selection}
        onSelect={select}
        onSync={() => sync.mutate()}
        syncing={sync.isPending}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selection.kind === 'add' ? (
          <AddAppPanel projectId={projectId} onAdded={(slug) => { invalidate(); if (slug) select({ kind: 'connector', slug }); }} />
        ) : selection.kind === 'global' ? (
          <GlobalRulesPanel projectId={projectId} />
        ) : active ? (
          <ConnectorDetail
            key={active.slug}
            projectId={projectId}
            connector={active}
            onChanged={invalidate}
            onRemoved={() => { invalidate(); select({ kind: 'add' }); }}
          />
        ) : (
          <div className="grid h-full place-items-center p-10">
            <EmptyState icon={Plug} title="Pick a connector" description="Choose one on the left, or add an app." />
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
  if (connector.status === 'error') return <Badge variant="destructive" size="sm">Error</Badge>;
  if (!connector.authSecret) return <Badge variant="outline" size="sm">No auth needed</Badge>;
  if (!connector.secretSet) return <Badge variant="warning" size="sm">Needs setup</Badge>;
  return <Badge variant="success" size="sm">Connected</Badge>;
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
  if (!dirty) return null;
  return (
    <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/60 pt-4">
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-amber-500" />
        Unsaved changes
      </span>
      {onReset && (
        <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>Reset</Button>
      )}
      <Button size="sm" onClick={onSave} disabled={saving || disabled} className="gap-1.5">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}{label}
      </Button>
    </div>
  );
}

function ConnectorRail({
  connectors,
  selection,
  onSelect,
  onSync,
  syncing,
}: {
  connectors: AdminConnector[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? connectors.filter((c) => c.slug.toLowerCase().includes(q.trim().toLowerCase()))
    : connectors;
  const ready = filtered.filter((c) => !(c.authSecret && !c.secretSet));
  const needsSetup = filtered.filter((c) => c.authSecret && !c.secretSet);
  const isSel = (slug: string) => selection.kind === 'connector' && selection.slug === slug;

  return (
    <nav aria-label="Connectors" className="flex w-72 shrink-0 flex-col border-r border-border/60 bg-muted/20">
      <div className="space-y-2 border-b border-border/60 p-3">
        <Button size="sm" className="w-full justify-start gap-2" variant={selection.kind === 'add' ? 'secondary' : 'default'} onClick={() => onSelect({ kind: 'add' })}>
          <Plus className="h-4 w-4" />Add app
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search connectors…" className="h-8 pl-8 text-sm" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <RailItem
          icon={ShieldCheck}
          title="Global rules"
          subtitle="Apply across all apps"
          active={selection.kind === 'global'}
          onClick={() => onSelect({ kind: 'global' })}
        />

        {connectors.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">No connectors yet. Add an app to start.</p>
        ) : (
          <>
            {ready.length > 0 && <RailGroupLabel>Connected</RailGroupLabel>}
            {ready.map((c) => (
              <RailItem
                key={c.slug}
                appIcon={PROVIDER_ICON[c.provider] ?? Plug}
                title={c.name || c.slug}
                subtitle={`${c.actions.length} ${c.actions.length === 1 ? 'tool' : 'tools'}`}
                dot={statusDot(c)}
                active={isSel(c.slug)}
                onClick={() => onSelect({ kind: 'connector', slug: c.slug })}
              />
            ))}
            {needsSetup.length > 0 && <RailGroupLabel>Needs setup</RailGroupLabel>}
            {needsSetup.map((c) => (
              <RailItem
                key={c.slug}
                appIcon={PROVIDER_ICON[c.provider] ?? Plug}
                title={c.name || c.slug}
                subtitle="Not connected"
                dot={statusDot(c)}
                active={isSel(c.slug)}
                onClick={() => onSelect({ kind: 'connector', slug: c.slug })}
              />
            ))}
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No match for “{q}”.</p>}
          </>
        )}
      </div>

      <div className="border-t border-border/60 p-2">
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground" onClick={onSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Sync from kortix.toml
        </Button>
      </div>
    </nav>
  );
}

function RailGroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/50">{children}</div>;
}

function RailItem({
  icon: Icon,
  appIcon,
  title,
  subtitle,
  dot,
  active,
  onClick,
}: {
  icon?: LucideIcon;
  appIcon?: LucideIcon;
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
      {appIcon ? <EntityAvatar icon={appIcon} size="sm" /> : Icon ? (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="h-3.5 w-3.5" /></span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
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
  const Icon = PROVIDER_ICON[connector.provider] ?? Plug;
  const isPipedream = connector.provider === 'pipedream';
  const connected = connector.secretSet;
  const reconnect = usePipedreamConnect(projectId, connector.slug, onChanged);
  const [credOpen, setCredOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const displayName = connector.name?.trim() || connector.slug;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  useEffect(() => { setEditingName(false); setNameDraft(displayName); }, [connector.slug, displayName]);

  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, connector.slug, nameDraft.trim()),
    onSuccess: () => { toast.success('Renamed'); setEditingName(false); onChanged(); },
    onError: (e: Error) => toast.error(e.message || 'Failed to rename'),
  });

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, connector.slug),
    onSuccess: () => { toast.success(`Removed ${displayName}`); onRemoved(); },
    onError: (e: Error) => toast.error(e.message || 'Failed to remove'),
  });

  const toolCount = connector.actions.length;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-7">
      {/* Header */}
      <div className="flex items-start gap-3.5">
        <EntityAvatar icon={Icon} size="lg" />
        <div className="min-w-0 flex-1">
          {editingName ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => { e.preventDefault(); if (nameDraft.trim() && nameDraft.trim() !== displayName) rename.mutate(); else setEditingName(false); }}
            >
              <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="h-9 max-w-xs text-lg font-semibold" autoFocus />
              <Button type="submit" size="icon" variant="ghost" className="h-9 w-9" disabled={rename.isPending} aria-label="Save name">
                {rename.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingName(false); setNameDraft(displayName); }} disabled={rename.isPending}>Cancel</Button>
            </form>
          ) : (
            <div className="group flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-foreground">{displayName}</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => setEditingName(true)} aria-label="Rename" className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Rename</TooltipContent>
              </Tooltip>
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            <Badge variant="outline" size="sm">{providerLabel(connector.provider)}</Badge>
            <ConnectorStatusBadge connector={connector} />
            <InlineMeta>
              <code className="font-mono">{connector.slug}</code>
              {toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null}
            </InlineMeta>
          </div>
        </div>
        {connector.authSecret && (
          isPipedream ? (
            <Button size="sm" variant={connected ? 'outline' : 'default'} className="shrink-0 gap-1.5" onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
              {reconnect.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {connected ? 'Reconnect' : 'Connect'}
            </Button>
          ) : (
            <Button size="sm" variant={connected ? 'outline' : 'default'} className="shrink-0 gap-1.5" onClick={() => setCredOpen(true)}>
              <KeyRound className="h-4 w-4" />{connected ? 'Replace credential' : 'Set credential'}
            </Button>
          )
        )}
      </div>

      <div className="mt-7 space-y-5">
        {!isPipedream && <ConnectionSection projectId={projectId} connector={connector} onChanged={onChanged} />}
        <ProfileSection projectId={projectId} connector={connector} onChanged={onChanged} />
        <PermissionsSection projectId={projectId} connector={connector} />

        <SectionCard
          tone="destructive"
          title="Remove connector"
          description="Deletes it from kortix.toml. Stored profiles and permission rules are dropped."
          action={
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" />Remove
            </Button>
          }
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove ${displayName}?`}
        description={<>This removes <code className="font-mono">{connector.slug}</code> from kortix.toml and drops its stored profile and permission rules. This can’t be undone.</>}
        confirmLabel="Remove connector"
        confirmVariant="destructive"
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      <SetCredentialDialog projectId={projectId} connector={credOpen ? connector : null} open={credOpen} onOpenChange={setCredOpen} onSaved={onChanged} />
    </div>
  );
}

// ─── Profile section (the account + who can use it) ─────────────────────────

function sharingToAccess(s: ConnectorSharing | null | undefined): { mode: 'project' | 'private' | 'members'; memberIds: string[] } {
  if (!s || s.mode === 'project') return { mode: 'project', memberIds: [] };
  if (s.mode === 'private') return { mode: 'private', memberIds: [] };
  return { mode: 'members', memberIds: s.memberIds ?? [] };
}

function ProfileSection({ projectId, connector, onChanged }: { projectId: string; connector: AdminConnector; onChanged: () => void }) {
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
  const accessChanged = credential === 'shared' && (
    access !== saved.mode || (access === 'members' && memberIds.slice().sort().join() !== saved.memberIds.slice().sort().join())
  );
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
        credential === 'per_user' || access === 'project' ? { mode: 'project' }
        : access === 'private' ? { mode: 'private', ownerId: '' }
        : { mode: 'members', memberIds };
      if (modeChanged || accessChanged) await setConnectorSharing(projectId, connector.slug, intent);
    },
    onSuccess: () => { toast.success('Profile saved'); onChanged(); },
    onError: (e: Error) => toast.error(e.message || 'Failed to save profile'),
  });

  return (
    <SectionCard title="Profile" description="The account this connector signs in with, and who may use it.">
      <RadioGroup value={credential} onValueChange={(v) => setCredential(v as 'shared' | 'per_user')} className="space-y-2">
        <ShareOption value="shared" label="One shared profile" desc="Connect the app once — every session uses that same account." current={credential} />
        <ShareOption value="per_user" label="Each member brings their own profile" desc="Every member links their own account the first time they use it (BYO)." current={credential} />
      </RadioGroup>

      {modeChanged && (
        <InfoBanner tone="warning" title="This changes how members sign in" className="mt-3">
          {credential === 'per_user'
            ? 'The shared profile stops being used — each member will be asked to connect their own.'
            : 'Each member’s personal profile stops being used — connect one shared profile after saving.'}
        </InfoBanner>
      )}

      {credential === 'shared' && (
        <div className="mt-4 space-y-1.5">
          <Label className="text-xs text-muted-foreground">Who can use it</Label>
          <SharingPicker
            projectId={projectId}
            showHeading={false}
            value={{ mode: access, memberIds }}
            onChange={(s) => { setAccess(s.mode); setMemberIds(s.memberIds); }}
            copy={{
              project: { label: 'Everyone in the project', desc: 'Any member can use the shared profile' },
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
        label="Save profile"
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
    auth: { type: cfg.auth.type, in: cfg.auth.in, name: cfg.auth.name ?? undefined, prefix: cfg.auth.prefix ?? undefined },
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
    auth: { type: d.auth?.type ?? 'none', in: d.auth?.in ?? 'header', name: d.auth?.name ?? '', prefix: d.auth?.prefix ?? '' },
  });
}

/**
 * Edit an existing connector's definition (the same fields as "Add connector"),
 * written back to kortix.toml via the create-or-update path. Credential mode and
 * access are owned by Profile, so we resend the current mode to leave it intact.
 */
function ConnectionSection({ projectId, connector, onChanged }: { projectId: string; connector: AdminConnector; onChanged: () => void }) {
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

  const reset = () => { if (configQuery.data) setDraft(configToDraft(configQuery.data)); };

  const save = useMutation({
    mutationFn: () => createConnector(projectId, { ...draft!, slug: connector.slug, credential: connector.credentialMode }),
    onSuccess: () => {
      toast.success('Connection saved');
      queryClient.invalidateQueries({ queryKey: ['connector-config', projectId, connector.slug] });
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to save connection'),
  });

  return (
    <SectionCard title="Connection" description="How Kortix reaches this connector — the same settings used when it was added.">
      {configQuery.isError ? (
        <InfoBanner tone="destructive" title="Couldn’t load connection" action={<Button size="sm" variant="outline" onClick={() => configQuery.refetch()}>Retry</Button>}>
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
            label="Save connection"
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
function PermissionPicker({ value, onChange }: { value: PolicyChoice; onChange: (c: PolicyChoice) => void }) {
  const meta = value === 'default'
    ? { label: 'Default', tint: 'text-muted-foreground' }
    : { label: POLICY_LABEL[value].label, tint: POLICY_LABEL[value].tint };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted',
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
            <span className={cn(c.value !== 'default' && POLICY_LABEL[c.value].tint)}>{c.label}</span>
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

function policiesSig(perTool: Record<string, ConnectorPolicyAction>, rules: { match: string; action: ConnectorPolicyAction }[]): string {
  const pt = Object.entries(perTool).filter(([, a]) => a).sort().map(([k, a]) => `${k}=${a}`).join(',');
  const rl = rules.filter((r) => r.match.trim()).map((r) => `${r.match.trim()}=${r.action}`).join(',');
  return `${pt}|${rl}`;
}

function tsSignature(slug: string, action: ConnectorAction): string {
  const props = (action.inputSchema as { properties?: Record<string, { type?: string }> } | null)?.properties ?? {};
  const required: string[] = (action.inputSchema as { required?: string[] } | null)?.required ?? [];
  const args = Object.entries(props).map(([k, v]) => {
    const t = v?.type === 'integer' ? 'number' : (v?.type ?? 'string');
    return `  ${k}${required.includes(k) ? '' : '?'}: ${t};`;
  });
  const argBlock = args.length ? `{\n${args.join('\n')}\n}` : '{}';
  return `executor.call("${slug}", "${action.path}", ${argBlock}): Promise<unknown>`;
}

function PermissionsSection({ projectId, connector }: { projectId: string; connector: AdminConnector }) {
  const queryClient = useQueryClient();
  const tools = connector.actions;
  const toolPaths = useMemo(() => new Set(tools.map((t) => t.path)), [tools]);

  const policiesQuery = useQuery({
    queryKey: ['connector-policies', projectId, connector.slug],
    queryFn: () => getConnectorPolicies(projectId, connector.slug),
    staleTime: 5_000,
  });

  const [perTool, setPerTool] = useState<Record<string, ConnectorPolicyAction>>({});
  const [rules, setRules] = useState<{ id: string; match: string; action: ConnectorPolicyAction }[]>([]);
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
    return q ? tools.filter((t) => `${t.path} ${t.description ?? ''}`.toLowerCase().includes(q)) : tools;
  }, [tools, search]);

  const dirty = policiesSig(perTool, rules) !== serverSig;

  const save = useMutation({
    mutationFn: () => {
      const policies: ConnectorPolicyRule[] = [
        ...tools.filter((t) => perTool[t.path]).map((t) => ({ match: t.path, action: perTool[t.path]! })),
        ...rules.filter((r) => r.match.trim()).map((r) => ({ match: r.match.trim(), action: r.action })),
      ];
      return setConnectorPolicies(projectId, connector.slug, policies);
    },
    onSuccess: () => { toast.success('Permissions saved'); queryClient.invalidateQueries({ queryKey: ['connector-policies', projectId, connector.slug] }); },
    onError: (e: Error) => toast.error(e.message || 'Failed to save permissions'),
  });

  const setChoice = (path: string, choice: PolicyChoice) =>
    setPerTool((m) => {
      const next = { ...m };
      if (choice === 'default') delete next[path];
      else next[path] = choice;
      return next;
    });
  const governingRule = (path: string) => rules.find((r) => r.match.trim() && clientMatch(r.match.trim(), path));

  // ── Multi-select + bulk apply ──
  const filteredPaths = useMemo(() => filtered.map((t) => t.path), [filtered]);
  const allFilteredSelected = filteredPaths.length > 0 && filteredPaths.every((p) => selected.has(p));
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
      description="What the agent may do with this app — Allow, Ask first, or Block. Default follows global rules & risk."
      action={tools.length > 6 ? (
        <div className="relative w-48">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tools…" className="h-8 pl-8 text-sm" />
        </div>
      ) : undefined}
    >
      <div className="space-y-4">
      {tools.length === 0 ? (
        <InfoBanner tone="neutral" title="No tools yet">Connect the profile, then Sync to pull this app’s tools.</InfoBanner>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/60">
          {/* Select-all + bulk apply */}
          <div className="flex h-9 items-center gap-2 border-b border-border/60 bg-muted/30 px-3">
            <Checkbox
              checked={allFilteredSelected ? true : someFilteredSelected ? 'indeterminate' : false}
              onCheckedChange={toggleAllFiltered}
              aria-label="Select all tools"
              className="size-3.5"
            />
            {selected.size > 0 ? (
              <>
                <span className="text-xs font-medium text-foreground">{selected.size} selected</span>
                <span className="text-xs text-muted-foreground">· set to</span>
                {POLICY_CHOICES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => applyBulk(c.value)}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted',
                      c.value === 'default' ? 'text-muted-foreground' : POLICY_LABEL[c.value].tint,
                    )}
                  >
                    {c.label}
                  </button>
                ))}
                <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground">
                  Clear
                </button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{filtered.length} {filtered.length === 1 ? 'tool' : 'tools'} · tap a permission to change it</span>
            )}
          </div>

          <div className="max-h-[52vh] overflow-y-auto">
            {filtered.map((t) => {
              const explicit = perTool[t.path];
              const ruled = !explicit ? governingRule(t.path) : undefined;
              const isOpen = expanded === t.path;
              const isSel = selected.has(t.path);
              return (
                <div key={t.path} className="border-t border-border/60 first:border-t-0">
                  <div className={cn('group flex items-center gap-2.5 px-3 py-1.5 transition-colors', isSel ? 'bg-primary/[0.05]' : 'hover:bg-muted/30')}>
                    <Checkbox
                      checked={isSel}
                      onCheckedChange={() => toggleSel(t.path)}
                      aria-label={`Select ${t.path}`}
                      className={cn('size-3.5 shrink-0 transition-opacity', isSel ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                    />
                    <button type="button" onClick={() => setExpanded(isOpen ? null : t.path)} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                      <span className="shrink-0 font-mono text-xs text-foreground">{t.path}</span>
                      {t.description && <span className="truncate text-xs text-muted-foreground/70">{t.description}</span>}
                    </button>
                    {ruled && (
                      <span className={cn('shrink-0 text-xs opacity-80', POLICY_LABEL[ruled.action].tint)} title={`From pattern rule: ${ruled.match}`}>
                        {POLICY_LABEL[ruled.action].label} · rule
                      </span>
                    )}
                    <ChevronRight className={cn('size-3 shrink-0 transition', isOpen ? 'rotate-90 text-muted-foreground/70' : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100')} />
                    <PermissionPicker value={explicit ?? 'default'} onChange={(c) => setChoice(t.path, c)} />
                  </div>
                  {isOpen && (
                    <div className="space-y-3 bg-muted/20 px-4 pb-3 pt-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={RISK_VARIANT[t.risk]} size="sm">{t.risk}</Badge>
                        {t.description && <span className="text-xs text-muted-foreground">{t.description}</span>}
                      </div>
                      <pre className="overflow-x-auto rounded-2xl border border-border/60 bg-card p-3 font-mono text-xs text-foreground">{tsSignature(connector.slug, t)}</pre>
                      <pre className="max-h-56 overflow-auto rounded-2xl border border-border/60 bg-card p-3 font-mono text-xs text-foreground">{JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }, null, 2)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No tools match “{search}”.</p>}
          </div>
        </div>
      )}

      {/* Advanced pattern rules */}
      {tools.length > 0 && (
        <div className="rounded-2xl border border-border/60">
          <button type="button" onClick={() => setShowRules((s) => !s)} className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left text-sm font-medium text-foreground hover:bg-muted/40">
            <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', showRules && 'rotate-90')} />
            Pattern rules
            {rules.length > 0 && <Badge variant="secondary" size="sm">{rules.length}</Badge>}
            <span className="ml-auto text-xs font-normal text-muted-foreground">cover many tools at once</span>
          </button>
          {showRules && (
            <div className="space-y-2 border-t border-border/60 px-3 py-3">
              <p className="text-xs text-muted-foreground">
                Match by glob (<code className="rounded bg-muted px-1 font-mono">send_*</code>) or regex (<code className="rounded bg-muted px-1 font-mono">/^delete_.+/</code>). Per-tool choices above win.
              </p>
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <Input value={r.match} onChange={(e) => setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, match: e.target.value } : x))} placeholder="send_*  or  /^delete_.+/" className="h-8 flex-1 font-mono text-xs" />
                  <Select value={r.action} onValueChange={(v) => setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, action: v as ConnectorPolicyAction } : x))}>
                    <SelectTrigger className="h-8 w-[100px] shrink-0 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{(['always_run', 'require_approval', 'block'] as ConnectorPolicyAction[]).map((a) => <SelectItem key={a} value={a} className="text-xs">{POLICY_LABEL[a].label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 hover:text-destructive" onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))} aria-label="Remove rule"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setRules((rs) => [...rs, { id: ruleId(), match: '', action: 'require_approval' }])}><Plus className="h-3.5 w-3.5" />Add rule</Button>
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
        label="Save permissions"
      />
    </SectionCard>
  );
}

// ─── Global rules ────────────────────────────────────────────────────────────

function GlobalRulesPanel({ projectId }: { projectId: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-7">
      <div className="mb-6 flex items-start gap-3.5">
        <EntityAvatar icon={ShieldCheck} size="lg" />
        <div>
          <h2 className="text-lg font-semibold text-foreground">Global rules</h2>
          <p className="mt-1 text-sm text-muted-foreground">Permissions that apply across every connector. These override each app’s own rules.</p>
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

function setupToSharing(s: ConnectorSetup): ConnectorSharing {
  if (s.access === 'project') return { mode: 'project' };
  if (s.access === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds };
}

/**
 * Profile + access asked when adding. "Who can use it" only applies to a shared
 * profile — for per-user there's no shared credential to gate.
 */
function ConnectorSetupFields({ projectId, value, onChange }: { projectId: string; value: ConnectorSetup; onChange: (s: ConnectorSetup) => void }) {
  const isShared = value.credential === 'shared';
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Profile</Label>
          <p className="text-xs text-muted-foreground">The account this connector signs in with.</p>
        </div>
        <RadioGroup
          value={value.credential}
          onValueChange={(v) => {
            const credential = v as ConnectorSetup['credential'];
            onChange(credential === 'shared' ? { ...value, credential } : { ...value, credential, access: 'project', memberIds: [] });
          }}
          className="space-y-2"
        >
          <ShareOption value="shared" label="One shared profile" desc="Connect the app once — every session uses that same account." current={value.credential} />
          <ShareOption value="per_user" label="Each member brings their own profile" desc="Every member links their own account the first time they use it (BYO)." current={value.credential} />
        </RadioGroup>
      </div>
      {isShared && (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <Label>Who can use it</Label>
            <p className="text-xs text-muted-foreground">Members allowed to run tools with the shared profile.</p>
          </div>
          <SharingPicker
            projectId={projectId}
            showHeading={false}
            value={{ mode: value.access, memberIds: value.memberIds }}
            onChange={(s) => onChange({ ...value, access: s.mode, memberIds: s.memberIds })}
            copy={{
              project: { label: 'Everyone in the project', desc: 'Any member can use the shared profile' },
              private: { label: 'Only me', desc: 'Just you' },
              members: { label: 'Specific members', desc: 'A chosen list of members' },
            }}
          />
        </div>
      )}
    </div>
  );
}

function AddAppPanel({ projectId, onAdded }: { projectId: string; onAdded: (slug?: string) => void }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-7">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-foreground">Add a connector</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">One-click connect a popular app, or add a custom API.</p>
      </div>
      <Tabs defaultValue="apps">
        <TabsList>
          <TabsTrigger value="apps">Easy connect</TabsTrigger>
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
function AppCatalogue({ projectId, onAdded }: { projectId: string; onAdded: (slug?: string) => void }) {
  const [q, setQ] = useState('');
  const appsQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', projectId, q],
    queryFn: ({ pageParam }) => listPipedreamApps(projectId, q || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });
  const [configApp, setConfigApp] = useState<{ slug: string; name: string } | null>(null);
  const apps = (appsQuery.data?.pages ?? []).flatMap((p) => p.apps);
  const notConfigured = appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps — Gmail, Slack, Stripe, Notion…" className="h-10 pl-9" />
      </div>
      <div className="max-h-[62vh] overflow-y-auto py-4">
        {notConfigured ? (
          <InfoBanner tone="neutral" title="Easy connect isn’t configured">Easy-connect apps need the Connect provider configured.</InfoBanner>
        ) : appsQuery.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-[104px] w-full rounded-2xl" />)}</div>
        ) : apps.length === 0 ? (
          <EmptyState icon={Search} title="No apps found" description={q ? `Nothing matches "${q}".` : 'Try a search.'} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {apps.map((app) => (
                <button
                  key={app.slug}
                  type="button"
                  onClick={() => setConfigApp({ slug: app.slug, name: app.name })}
                  className="group flex flex-col rounded-2xl border border-border/60 bg-card p-4 text-left transition-all hover:border-primary/40 hover:bg-primary/[0.03] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <div className="flex items-center gap-3">
                    {app.imgSrc ? <img src={app.imgSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" referrerPolicy="no-referrer" /> : <EntityAvatar icon={Zap} size="sm" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">{app.name}</div>
                      {app.categories?.[0] && <div className="truncate text-xs text-muted-foreground">{app.categories[0]}</div>}
                    </div>
                    <Plus className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-muted-foreground">{app.description ?? ' '}</p>
                </button>
              ))}
            </div>
            {appsQuery.hasNextPage && (
              <div className="flex justify-center pt-5">
                <Button variant="outline" size="sm" onClick={() => appsQuery.fetchNextPage()} disabled={appsQuery.isFetchingNextPage} className="h-9 px-8">
                  {appsQuery.isFetchingNextPage ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading…</> : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <ConfigureAppDialog projectId={projectId} app={configApp} open={!!configApp} onOpenChange={(o) => !o && setConfigApp(null)} onAdded={(slug) => { setConfigApp(null); onAdded(slug); }} />
    </div>
  );
}

/** The pick-an-app → choose profile/access step. Small focused modal. */
function ConfigureAppDialog({ projectId, app, open, onOpenChange, onAdded }: { projectId: string; app: { slug: string; name: string } | null; open: boolean; onOpenChange: (o: boolean) => void; onAdded: (slug: string) => void }) {
  const [setup, setSetup] = useState<ConnectorSetup>({ credential: 'per_user', access: 'project', memberIds: [] });
  const save = useMutation({
    mutationFn: () => createConnector(projectId, { slug: app!.slug, provider: 'pipedream', app: app!.slug, account: 'default', credential: setup.credential, sharing: setupToSharing(setup) }),
    onSuccess: () => { toast.success(`Added ${app!.name} — click Connect to authorize`); onAdded(app!.slug); },
    onError: (err: Error) => toast.error(err.message || 'Failed to add'),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Add {app?.name}</DialogTitle>
          <DialogDescription>Choose the profile, then who can use it.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[58vh] overflow-y-auto px-6 py-5"><ConnectorSetupFields projectId={projectId} value={setup} onChange={setSetup} /></div>
        <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (setup.access === 'members' && setup.memberIds.length === 0)} className="gap-1.5">
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
function ConnectorConfigFields({ draft, onChange, slugEditable }: { draft: ConnectorDraftInput; onChange: (d: ConnectorDraftInput) => void; slugEditable?: boolean }) {
  const set = (patch: Partial<ConnectorDraftInput>) => onChange({ ...draft, ...patch });
  const setAuth = (patch: Partial<NonNullable<ConnectorDraftInput['auth']>>) => onChange({ ...draft, auth: { ...draft.auth, ...patch } });
  const p = draft.provider;
  const needsAuth = p !== 'pipedream';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug"><Input value={draft.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })} placeholder="my-api" className="font-mono" disabled={!slugEditable} required /></Field>
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select value={p} onValueChange={(v) => set({ provider: v as ConnectorDraftInput['provider'] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="openapi">OpenAPI</SelectItem>
              <SelectItem value="graphql">GraphQL</SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {p === 'openapi' && <Field label="Spec URL or repo path"><Input value={draft.spec ?? ''} onChange={(e) => set({ spec: e.target.value })} placeholder="https://…/openapi.json" required /></Field>}
      {p === 'graphql' && (<>
        <Field label="Endpoint"><Input value={draft.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://api/graphql" required /></Field>
        <Field label="SDL spec (optional)"><Input value={draft.spec ?? ''} onChange={(e) => set({ spec: e.target.value })} placeholder=".kortix/executor/schema.graphql" /></Field>
      </>)}
      {p === 'mcp' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="URL"><Input value={draft.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp…/mcp" required /></Field>
          <div className="space-y-1.5">
            <Label>Transport</Label>
            <Select value={draft.transport ?? 'http'} onValueChange={(v) => set({ transport: v as 'http' | 'sse' })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="http">http</SelectItem><SelectItem value="sse">sse</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
      )}
      {p === 'http' && (<>
        <Field label="Base URL"><Input value={draft.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.internal" required /></Field>
        <Field label="Routes spec (optional)"><Input value={draft.spec ?? ''} onChange={(e) => set({ spec: e.target.value })} placeholder=".kortix/executor/routes.toml" /></Field>
      </>)}
      {needsAuth && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Auth</Label>
            <Select value={draft.auth?.type ?? 'none'} onValueChange={(v) => setAuth({ type: v as 'none' | 'bearer' | 'basic' | 'custom' })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer</SelectItem>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="custom">Custom header</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.auth?.type === 'custom' && <Field label="Header name"><Input value={draft.auth?.name ?? ''} onChange={(e) => setAuth({ name: e.target.value })} placeholder="X-API-Key" required /></Field>}
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

function CustomConnectorForm({ projectId, onAdded }: { projectId: string; onAdded: (slug?: string) => void }) {
  const [draft, setDraft] = useState<ConnectorDraftInput>({ slug: '', provider: 'openapi', auth: { type: 'none' } });
  const [setup, setSetup] = useState<ConnectorSetup>({ credential: 'shared', access: 'project', memberIds: [] });
  const save = useMutation({
    mutationFn: () => createConnector(projectId, { ...draft, credential: setup.credential, sharing: setupToSharing(setup) }),
    onSuccess: () => { toast.success(`Added ${draft.slug}`); onAdded(draft.slug); },
    onError: (err: Error) => toast.error(err.message || 'Failed to add connector'),
  });
  const authActive = !!draft.auth?.type && draft.auth.type !== 'none';

  return (
    <SectionCard title="Custom connector" description="Connect any OpenAPI, GraphQL, MCP, or HTTP service.">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <ConnectorConfigFields draft={draft} onChange={setDraft} slugEditable />
        {authActive && <InfoBanner tone="info">You’ll set the credential value after adding, from the connector’s page.</InfoBanner>}
        <div className="border-t border-border/60 pt-4"><ConnectorSetupFields projectId={projectId} value={setup} onChange={setSetup} /></div>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <Button type="submit" disabled={!draft.slug || save.isPending || !connectionValid(draft) || (setup.access === 'members' && setup.memberIds.length === 0)} className="gap-1.5">
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Add connector
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

// ─── Set credential (custom connectors) ──────────────────────────────────────

function SetCredentialDialog({ projectId, connector, open, onOpenChange, onSaved }: { projectId: string; connector: AdminConnector | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => setConnectorCredential(projectId, connector!.slug, value),
    onSuccess: () => { toast.success('Credential saved'); setValue(''); onSaved(); onOpenChange(false); },
    onError: (err: Error) => toast.error(err.message || 'Failed to save'),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Set credential for {connector?.slug}</DialogTitle>
          <DialogDescription>Stored encrypted as <code className="font-mono">{connector?.authSecret}</code> and resolved server-side, never injected into the sandbox.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (value) save.mutate(); }}>
          <div className="space-y-1.5 px-6 py-5">
            <Label>Value</Label>
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="••••••••" className="font-mono" autoFocus />
          </div>
          <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" disabled={!value || save.isPending} className="gap-1.5">{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button>
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
      <div className="w-72 shrink-0 space-y-2 border-r border-border/60 bg-muted/20 p-3">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-7">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    </div>
  );
}
