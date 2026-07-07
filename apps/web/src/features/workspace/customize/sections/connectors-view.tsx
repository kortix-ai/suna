'use client';

import { useCustomizeStore } from '@/stores/customize-store';
import { createFrontendClient } from '@pipedream/sdk/browser';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  type LucideIcon,
  Mail,
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
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CodeBlockCode } from '@/components/ui/code-block';
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
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  type EmailInstallation,
  type EmailSenderPolicy,
  type SlackInstallation,
  useConnectEmail,
  useConnectSlack,
  useDisconnectEmail,
  useDisconnectSlack,
  useEmailInstall,
  useEmailMode,
  useSlackInstall,
  useSlackManifest,
  useSlackMode,
  useUpdateEmailPolicy,
} from '@/hooks/channels/use-channels-installations';
import { cn } from '@/lib/utils';
import {
  type AdminConnector,
  type ConnectorAction,
  type ConnectorConfig,
  type ConnectorDraftInput,
  type ConnectorPolicyAction,
  type ConnectorPolicyRule,
  createConnector,
  deleteConnector,
  getConnectStatus,
  getConnectorConfig,
  getConnectorPolicies,
  getProject,
  listConnectors,
  listPipedreamApps,
  pipedreamConnect,
  pipedreamFinalize,
  setConnectorCredential,
  setConnectorName,
  setConnectorPolicies,
  setConnectorSensitive,
  syncConnectors,
} from '@kortix/sdk/projects-client';

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

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);
const SLACK_ICON_SRC = 'https://www.google.com/s2/favicons?domain=slack.com&sz=128';

/** Forward-facing provider label — "App" for the 1-click (Pipedream) connectors. */
function providerLabel(p: AdminConnector['provider']): string {
  if (p === 'pipedream') return 'App';
  if (p === 'channel') return 'Channel';
  if (p === 'computer') return 'Computer';
  return p.toUpperCase();
}

const PIPEDREAM_IFRAME_SELECTOR = 'iframe[id^="pipedream-connect-iframe-"]';

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
      successToast('Connected');
      onConnected();
    },
    onError: (err: Error) => errorToast(err.message),
  });
}

type Selection = { kind: 'connector'; slug: string } | { kind: 'global' } | { kind: 'add' };

export function ConnectorsView({ projectId }: { projectId: string }) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
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
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 10_000,
  });
  const connectors = useMemo(() => query.data?.connectors ?? [], [query.data]);
  const emailChannelEnabled = projectQuery.data?.experimental?.agentmail_email === true;
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
      if (res.errors.length) warningToast(`Synced ${res.synced}, ${res.errors.length} with issues`);
      else successToast(`Synced ${res.synced} connector(s)`);
    },
    onError: (err: Error) => errorToast(err.message || 'Sync failed'),
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
      {connectors.length > 0 && (
        <ConnectorRail
          projectId={projectId}
          connectors={connectors}
          selection={selection}
          onSelect={select}
          onSync={() => sync.mutate()}
          syncing={sync.isPending}
        />
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selection.kind === 'add' ? (
          <AddAppPanel
            projectId={projectId}
            emailChannelEnabled={emailChannelEnabled}
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

function statusDot(c: AdminConnector): string {
  if (c.status === 'error') return 'bg-destructive';
  if (c.authSecret && !c.secretSet) return 'bg-kortix-orange';
  return 'bg-kortix-green';
}

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
        <span className="bg-kortix-orange size-1.5 rounded-full" />
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
          'relative',
          appIconTileClass(size),
        )}
      >
        <Image
          src={imgSrc}
          alt=""
          referrerPolicy="no-referrer"
          fill
          sizes={size === 'lg' ? '40px' : '28px'}
          className="object-contain p-1"
          unoptimized
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
  const isChannel = connector.provider === 'channel';
  // Computer (Agent Computer Tunnel) connectors, like channels, are managed from
  // a dedicated tab (Computers): no generic credential / connect / remove UI.
  const isComputer = connector.provider === 'computer';
  const isManaged = isComputer;
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
      successToast('Renamed');
      setEditingName(false);
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to rename'),
  });

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, connector.slug),
    onSuccess: () => {
      successToast(`Removed ${displayName}`);
      onRemoved();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to remove'),
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
              className="shrink-0"
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
              className="shrink-0"
              onClick={() => setCredOpen(true)}
            >
              <KeyRound className="h-4 w-4" />
              Replace credential
            </Button>
          ))}
      </div>

      <div className="mt-7 space-y-5">
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
                className="shrink-0"
                onClick={() => setSection('computers')}
              >
                <Monitor className="h-4 w-4" />
                Open Computers
              </Button>
            }
          >
            Connect a machine, and grant or revoke per-capability access, in the Computers tab. Here
            you control who can use it and review its tools.
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
        {/* The sensitive toggle lives under Permissions (it IS a permission
            default), so Profile only exists when there's a connection to
            manage — for Pipedream/managed connectors it would be empty. */}
        <Tabs defaultValue={!isPipedream && !isManaged ? 'profile' : 'permissions'} className="gap-3">
          <TabsList>
            {!isPipedream && !isManaged && <TabsTrigger value="profile">Profile</TabsTrigger>}
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
          </TabsList>
          {!isPipedream && !isManaged && (
            <TabsContent value="profile" className="space-y-5">
              {isChannel ? (
                <ChannelConnectionSection
                  projectId={projectId}
                  connector={connector}
                  onChanged={onChanged}
                  onRemoved={onRemoved}
                />
              ) : (
                <ConnectionSection
                  projectId={projectId}
                  connector={connector}
                  onChanged={onChanged}
                />
              )}
            </TabsContent>
          )}
          <TabsContent value="permissions" className="space-y-5">
            <PermissionsSection
              projectId={projectId}
              connector={connector}
              onChanged={onChanged}
            />
          </TabsContent>
        </Tabs>

        {!isManaged && !isChannel && (
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
      <SetCredentialModal
        projectId={projectId}
        connector={credOpen ? connector : null}
        open={credOpen}
        onOpenChange={setCredOpen}
        onSaved={onChanged}
      />
    </div>
  );
}

// ─── Channel connection profile (Email / Slack install state) ───────────────

type ChannelPlatform = 'slack' | 'email';

function connectorPlatform(connector: AdminConnector): ChannelPlatform | null {
  if (connector.platform === 'slack' || connector.platform === 'email') return connector.platform;
  if (connector.slug === 'kortix_slack') return 'slack';
  if (connector.slug === 'kortix_email') return 'email';
  if (connector.slug.startsWith('email_')) return 'email';
  return null;
}

function ChannelConnectionSection({
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
  const platform = connectorPlatform(connector);
  if (platform === 'email') {
    return (
      <EmailChannelProfile
        projectId={projectId}
        connector={connector}
        onChanged={onChanged}
        onRemoved={onRemoved}
      />
    );
  }
  if (platform === 'slack') {
    return (
      <SlackChannelProfile projectId={projectId} onChanged={onChanged} onRemoved={onRemoved} />
    );
  }
  return (
    <SectionCard title="Connection">
      <InfoBanner tone="warning">This channel profile is missing its platform setting.</InfoBanner>
    </SectionCard>
  );
}

function EmailChannelProfile({
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
  const install = useEmailInstall(projectId, connector.slug);

  return (
    <SectionCard
      title="Email connection"
      description="AgentMail inbox assigned to this connector profile."
    >
      {install.isLoading ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : install.data ? (
        <ConnectedEmailProfile
          projectId={projectId}
          connectorSlug={connector.slug}
          installation={install.data}
          onRemoved={onRemoved}
        />
      ) : (
        <EmailConnectForm
          projectId={projectId}
          connectorSlug={connector.slug}
          onConnected={onChanged}
        />
      )}
    </SectionCard>
  );
}

function ConnectedEmailProfile({
  projectId,
  connectorSlug,
  installation,
  onRemoved,
}: {
  projectId: string;
  connectorSlug: string;
  installation: EmailInstallation;
  onRemoved: () => void;
}) {
  const disconnect = useDisconnectEmail();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <InfoBanner tone="success" icon={Check} title="Email connected">
        Address <code className="font-mono">{installation.email}</code>
        {' · '}Inbox <code className="font-mono">{installation.inboxId}</code>
        {installation.webhookId ? (
          <>
            {' · '}Webhook <code className="font-mono">{installation.webhookId}</code>
          </>
        ) : null}
      </InfoBanner>
      <EmailSenderPolicyEditor
        projectId={projectId}
        connectorSlug={connectorSlug}
        policy={installation.senderPolicy}
      />
      <div className="flex items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="text-muted-foreground mr-auto text-xs">
              Removes the Email channel profile from this project.
            </span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(
                  { projectId, connectorSlug },
                  {
                    onSuccess: () => {
                      setConfirming(false);
                      onRemoved();
                    },
                  },
                )
              }
            >
              {disconnect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

function splitPolicyList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function normalizeEmailSenderPolicy(
  policy: EmailSenderPolicy | null | undefined,
): EmailSenderPolicy {
  return {
    mode: policy?.mode === 'restricted' ? 'restricted' : 'allow_all',
    allowedEmails: policy?.allowedEmails ?? [],
    allowedDomains: policy?.allowedDomains ?? [],
    allowedRegex: policy?.allowedRegex ?? null,
  };
}

function EmailSenderPolicyEditor({
  projectId,
  connectorSlug,
  policy,
}: {
  projectId: string;
  connectorSlug: string;
  policy: EmailSenderPolicy | null | undefined;
}) {
  const update = useUpdateEmailPolicy();
  const initial = normalizeEmailSenderPolicy(policy);
  const [restricted, setRestricted] = useState(initial.mode === 'restricted');
  const [emails, setEmails] = useState(initial.allowedEmails.join('\n'));
  const [domains, setDomains] = useState(initial.allowedDomains.join('\n'));
  const [regex, setRegex] = useState(initial.allowedRegex ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = normalizeEmailSenderPolicy(policy);
    setRestricted(next.mode === 'restricted');
    setEmails(next.allowedEmails.join('\n'));
    setDomains(next.allowedDomains.join('\n'));
    setRegex(next.allowedRegex ?? '');
    setError(null);
  }, [policy]);

  const nextPolicy = (): EmailSenderPolicy => ({
    mode: restricted ? 'restricted' : 'allow_all',
    allowedEmails: splitPolicyList(emails),
    allowedDomains: splitPolicyList(domains).map((domain) => domain.replace(/^@+/, '')),
    allowedRegex: regex.trim() || null,
  });

  const save = () => {
    setError(null);
    const sender_policy = nextPolicy();
    if (sender_policy.allowedRegex) {
      try {
        new RegExp(sender_policy.allowedRegex);
      } catch {
        setError('Regex is invalid');
        return;
      }
    }
    update.mutate(
      { projectId, connectorSlug, sender_policy },
      { onError: (e) => setError((e as Error).message) },
    );
  };

  const dirty =
    restricted !== (initial.mode === 'restricted') ||
    emails !== initial.allowedEmails.join('\n') ||
    domains !== initial.allowedDomains.join('\n') ||
    regex !== (initial.allowedRegex ?? '');

  return (
    <div className="border-border/60 bg-card rounded-2xl border p-4">
      <div className="flex items-start gap-3">
        <Checkbox
          id="email-sender-restricted"
          checked={restricted}
          onCheckedChange={(checked) => setRestricted(Boolean(checked))}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <Label htmlFor="email-sender-restricted">Restrict who can start email sessions</Label>
            <p className="text-muted-foreground mt-1 text-xs">
              Leave off to accept every inbound sender. Turn on to allow exact emails, domains, or a
              regex.
            </p>
          </div>
          {restricted ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <Input
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="person@example.com"
                />
              </Field>
              <Field>
                <Input
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder="example.com"
                />
              </Field>
              <div className="sm:col-span-2">
                <Field>
                  <Input
                    value={regex}
                    onChange={(e) => setRegex(e.target.value)}
                    placeholder=".*@customer-[0-9]+\\.com$"
                    spellCheck={false}
                  />
                </Field>
              </div>
            </div>
          ) : null}
          {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
          <SaveBar
            dirty={dirty}
            saving={update.isPending}
            onSave={save}
            onReset={() => {
              setRestricted(initial.mode === 'restricted');
              setEmails(initial.allowedEmails.join('\n'));
              setDomains(initial.allowedDomains.join('\n'));
              setRegex(initial.allowedRegex ?? '');
            }}
            label="Save policy"
          />
        </div>
      </div>
    </div>
  );
}

export function EmailConnectForm({
  projectId,
  connectorSlug,
  onConnected,
}: {
  projectId: string;
  connectorSlug: string;
  onConnected: () => void;
}) {
  const mode = useEmailMode(projectId);
  const connect = useConnectEmail();
  const [displayName, setDisplayName] = useState('Kortix Agent');
  const [username, setUsername] = useState(() =>
    connectorSlug
      .replace(/^email_/, '')
      .replace(/_[a-z0-9]{4}$/i, '')
      .replace(/_/g, '-'),
  );
  const [attachExisting, setAttachExisting] = useState(false);
  const [existingInboxId, setExistingInboxId] = useState('');
  const [existingEmail, setExistingEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [customKeyOpen, setCustomKeyOpen] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [emails, setEmails] = useState('');
  const [domains, setDomains] = useState('');
  const [regex, setRegex] = useState('');
  const [error, setError] = useState<string | null>(null);
  const managedAvailable = mode.data?.managed_available === true;
  const useCustomKey = customKeyOpen && apiKey.trim();
  const canCreate = managedAvailable || Boolean(useCustomKey);

  const submit = () => {
    setError(null);
    if (!canCreate) {
      setCustomKeyOpen(true);
      setError(
        'Managed Email is not configured on this deployment. Use a custom AgentMail key to continue.',
      );
      return;
    }
    if (attachExisting && (!existingInboxId.trim() || !existingEmail.trim())) {
      setError('Existing AgentMail inbox requires both inbox ID and email address.');
      return;
    }
    const sender_policy: EmailSenderPolicy = {
      mode: restricted ? 'restricted' : 'allow_all',
      allowedEmails: splitPolicyList(emails),
      allowedDomains: splitPolicyList(domains).map((domain) => domain.replace(/^@+/, '')),
      allowedRegex: regex.trim() || null,
    };
    if (sender_policy.allowedRegex) {
      try {
        new RegExp(sender_policy.allowedRegex);
      } catch {
        setError('Regex is invalid');
        return;
      }
    }
    connect.mutate(
      {
        projectId,
        connector_slug: connectorSlug,
        api_key: useCustomKey ? apiKey.trim() : undefined,
        display_name: displayName.trim() || undefined,
        username: attachExisting ? undefined : username.trim() || undefined,
        inbox_id: attachExisting ? existingInboxId.trim() : undefined,
        email: attachExisting ? existingEmail.trim() : undefined,
        sender_policy,
      },
      {
        onSuccess: onConnected,
        onError: (e) => setError((e as Error).message),
      },
    );
  };

  return (
    <div className="space-y-4">
      <InfoBanner
        tone={managedAvailable ? 'info' : 'warning'}
        icon={Mail}
        title={managedAvailable ? 'Create managed Email inbox' : 'Managed Email is not configured'}
      >
        {managedAvailable
          ? 'Kortix will create and manage the AgentMail inbox for this profile.'
          : 'This deployment needs a project-specific AgentMail key before it can create an inbox.'}
      </InfoBanner>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <Input
            id="email-channel-display-name"
            name="email-channel-display-name"
            aria-label="Email display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Kortix Agent"
          />
        </Field>
        {attachExisting ? (
          <Field>
            <FieldLabel htmlFor="email-channel-existing-email">Existing inbox email</FieldLabel>
            <Input
              id="email-channel-existing-email"
              name="email-channel-existing-email"
              aria-label="Existing AgentMail email"
              value={existingEmail}
              onChange={(e) => setExistingEmail(e.target.value.trim().toLowerCase())}
              placeholder="support@agentmail.to"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ) : (
          <Field>
            <Input
              id="email-channel-username"
              name="email-channel-username"
              aria-label="Email address prefix"
              value={username}
              onChange={(e) =>
                setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
              }
              placeholder="support"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              AgentMail will create this prefix when available, for example {username || 'support'}
              @agentmail.to.
            </p>
          </Field>
        )}
      </div>
      <div className="border-border/60 border-t pt-4">
        <div className="flex items-start gap-3">
          <Checkbox
            id="email-channel-existing-inbox"
            checked={attachExisting}
            onCheckedChange={(checked) => setAttachExisting(Boolean(checked))}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <Label htmlFor="email-channel-existing-inbox">Attach existing AgentMail inbox</Label>
              <p className="text-muted-foreground mt-1 text-xs">
                Use this when the mailbox already exists or the AgentMail account has reached its
                inbox limit. Kortix will still create the webhook for this profile.
              </p>
            </div>
            {attachExisting ? (
              <Field>
                <FieldLabel htmlFor="email-channel-existing-inbox-id">Existing inbox ID</FieldLabel>
                <Input
                  id="email-channel-existing-inbox-id"
                  name="email-channel-existing-inbox-id"
                  aria-label="Existing AgentMail inbox ID"
                  value={existingInboxId}
                  onChange={(e) => setExistingInboxId(e.target.value.trim())}
                  placeholder="support@agentmail.to"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            ) : null}
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-0"
          onClick={() => setCustomKeyOpen((open) => !open)}
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', customKeyOpen && 'rotate-180')}
          />
          Use custom AgentMail key
        </Button>
        {customKeyOpen ? (
          <Field>
            <Input
              id="email-channel-agentmail-api-key"
              name="email-channel-agentmail-api-key"
              aria-label="AgentMail API key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="am_..."
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              Optional when managed Email is configured. Stored as an encrypted project secret.
            </p>
          </Field>
        ) : null}
      </div>
      <div className="border-border/60 bg-card rounded-2xl border p-4">
        <div className="flex items-start gap-3">
          <Checkbox
            id="email-channel-restrict-senders"
            checked={restricted}
            onCheckedChange={(checked) => setRestricted(Boolean(checked))}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <Label htmlFor="email-channel-restrict-senders">
                Restrict who can start sessions
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">
                Optional. Allow exact emails, domains, or a regex before inbound mail can trigger
                the agent.
              </p>
            </div>
            {restricted ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <Input
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    placeholder="person@example.com"
                    spellCheck={false}
                  />
                </Field>
                <Field>
                  <Input
                    value={domains}
                    onChange={(e) => setDomains(e.target.value)}
                    placeholder="example.com"
                    spellCheck={false}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field>
                    <Input
                      value={regex}
                      onChange={(e) => setRegex(e.target.value)}
                      placeholder=".*@customer-[0-9]+\\.com$"
                      spellCheck={false}
                    />
                  </Field>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={connect.isPending || mode.isLoading}>
          {connect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Create inbox
        </Button>
      </div>
    </div>
  );
}

function SlackChannelProfile({
  projectId,
  onChanged,
  onRemoved,
}: {
  projectId: string;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const install = useSlackInstall(projectId);
  return (
    <SectionCard
      title="Slack connection"
      description="Slack workspace assigned to this connector profile."
    >
      {install.isLoading ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : install.data ? (
        <ConnectedSlackProfile
          projectId={projectId}
          installation={install.data}
          onRemoved={onRemoved}
        />
      ) : (
        <SlackConnectForm projectId={projectId} onConnected={onChanged} />
      )}
    </SectionCard>
  );
}

function ConnectedSlackProfile({
  projectId,
  installation,
  onRemoved,
}: {
  projectId: string;
  installation: SlackInstallation;
  onRemoved: () => void;
}) {
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-4">
      <InfoBanner tone="success" icon={Check} title="Slack connected">
        Workspace{' '}
        <code className="font-mono">{installation.workspaceName || installation.workspaceId}</code>
      </InfoBanner>
      <div className="flex items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="text-muted-foreground mr-auto text-xs">
              Removes the Slack channel profile from this project.
            </span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(projectId, {
                  onSuccess: () => {
                    setConfirming(false);
                    onRemoved();
                  },
                })
              }
            >
              {disconnect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

export function SlackConnectForm({
  projectId,
  onConnected,
}: {
  projectId: string;
  onConnected: () => void;
}) {
  const mode = useSlackMode(projectId);
  const manifest = useSlackManifest(projectId);
  const connect = useConnectSlack();
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [copiedManifest, setCopiedManifest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installUrl = mode.data?.oauth_available ? mode.data.install_url : null;
  const showCustom = customOpen || (!mode.isLoading && !installUrl);

  const submit = () => {
    setError(null);
    connect.mutate(
      { projectId, bot_token: botToken.trim(), signing_secret: signingSecret.trim() },
      {
        onSuccess: onConnected,
        onError: (e) => setError((e as Error).message),
      },
    );
  };

  const copyManifest = async () => {
    if (!manifest.data) return;
    try {
      await navigator.clipboard.writeText(manifest.data);
      setCopiedManifest(true);
      successToast('Slack manifest copied');
      setTimeout(() => setCopiedManifest(false), 1500);
    } catch {
      errorToast('Copy failed - select and copy manually');
    }
  };

  return (
    <div className="space-y-4">
      {mode.isLoading ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : installUrl ? (
        <InfoBanner
          tone="info"
          icon={<SlackLogo />}
          title="Add Kortix to your Slack workspace"
          action={
            <Button size="sm" className="shrink-0 gap-1.5" asChild>
              <a href={installUrl}>
                Add to Slack
                <ChevronRight className="h-4 w-4" />
              </a>
            </Button>
          }
        >
          One-click install - authorize Kortix in your workspace, no setup required.
        </InfoBanner>
      ) : (
        <InfoBanner
          tone="warning"
          icon={<SlackLogo />}
          title="Managed Slack install is not configured"
        >
          Use a custom Slack app for this deployment.
        </InfoBanner>
      )}
      <div className="space-y-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-0"
          onClick={() => setCustomOpen((open) => !open)}
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', showCustom && 'rotate-180')}
          />
          Use custom Slack app
        </Button>
        {showCustom ? (
          <div className="border-border/60 bg-card space-y-5 rounded-2xl border p-4">
            <div className="space-y-1">
              <h3 className="text-foreground text-base font-semibold">Bring your own Slack app</h3>
              <p className="text-muted-foreground text-sm">
                For self-hosted setups or custom-scoped installs.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="space-y-1">
                  <div className="text-foreground text-sm font-medium">
                    Step 1 of 2 - paste the manifest into Slack and install the app.
                  </div>
                  <div className="text-muted-foreground text-xs font-medium">App manifest</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={copyManifest}
                    disabled={!manifest.data}
                  >
                    {copiedManifest ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedManifest ? 'Copied' : 'Copy'}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" asChild>
                    <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">
                      Open Slack
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </div>

              {manifest.isLoading ? (
                <Skeleton className="h-52 w-full rounded-2xl" />
              ) : manifest.isError ? (
                <InfoBanner tone="destructive">
                  {(manifest.error as Error)?.message || 'Failed to load Slack manifest'}
                </InfoBanner>
              ) : manifest.data ? (
                <div className="max-h-[26rem] overflow-auto rounded-2xl">
                  <CodeSnippet code={manifest.data} language="json" />
                </div>
              ) : null}

              <ol className="space-y-2">
                {[
                  'Click Open Slack, choose "From a manifest", paste the JSON, confirm.',
                  'On the next screen, click Install to Workspace and approve.',
                  'Copy the Bot User OAuth Token (xoxb-...) and Signing Secret.',
                ].map((step, index) => (
                  <li key={step} className="text-muted-foreground flex gap-2 text-xs">
                    <span className="border-border/60 bg-muted/40 text-foreground flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                      {index + 1}
                    </span>
                    <span className="pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-foreground text-sm font-medium">
                  Step 2 of 2 - paste tokens from Slack.
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Copy the Bot User OAuth Token and Signing Secret from the installed Slack app.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <Input
                    id="slack-channel-bot-token"
                    name="slack-channel-bot-token"
                    aria-label="Slack bot token"
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="xoxb-..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field>
                  <Input
                    id="slack-channel-signing-secret"
                    name="slack-channel-signing-secret"
                    aria-label="Slack signing secret"
                    type="password"
                    value={signingSecret}
                    onChange={(e) => setSigningSecret(e.target.value)}
                    placeholder="Slack signing secret"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
              {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={connect.isPending || !botToken.trim() || !signingSecret.trim()}
                >
                  {connect.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  Connect custom Slack app
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function configToDraft(cfg: ConnectorConfig): ConnectorDraftInput {
  return {
    slug: cfg.slug,
    provider: cfg.provider,
    platform: cfg.platform ?? undefined,
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

function connectionSig(d: ConnectorDraftInput): string {
  return JSON.stringify({
    provider: d.provider,
    platform: d.platform ?? '',
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
      }),
    onSuccess: () => {
      successToast('Connection saved');
      queryClient.invalidateQueries({ queryKey: ['connector-config', projectId, connector.slug] });
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to save connection'),
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

type PolicyChoice = 'default' | ConnectorPolicyAction;

const POLICY_CHOICES: { value: PolicyChoice; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'always_run', label: 'Allow' },
  { value: 'require_approval', label: 'Ask' },
  { value: 'block', label: 'Block' },
];

const POLICY_LABEL: Record<ConnectorPolicyAction, { label: string; tint: string }> = {
  always_run: { label: 'Allow', tint: 'text-kortix-green' },
  require_approval: { label: 'Ask', tint: 'text-kortix-yellow' },
  block: { label: 'Block', tint: 'text-destructive' },
};

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
  onChanged,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const tools = connector.actions;
  const toolPaths = useMemo(() => new Set(tools.map((t) => t.path)), [tools]);

  const sensitiveMut = useMutation({
    mutationFn: (next: boolean) => setConnectorSensitive(projectId, connector.slug, next),
    onSuccess: (_r, next) => {
      successToast(next ? 'Marked sensitive — reads now ask' : 'No longer sensitive');
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to update sensitivity'),
  });

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
      successToast('Permissions saved');
      queryClient.invalidateQueries({
        queryKey: ['connector-policies', projectId, connector.slug],
      });
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to save permissions'),
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
        <div className="space-y-2">
          <Label>Default</Label>
          <RadioGroup
            value={connector.sensitive ? 'ask_first' : 'follow_rules'}
            onValueChange={(v) => sensitiveMut.mutate(v === 'ask_first')}
            className="space-y-2"
          >
            <RadioGroupItem
              value="follow_rules"
              id={`connector-default-follow-${connector.slug}`}
              label="Follow global rules & risk"
              description="Reads run automatically; writes and destructive actions still ask, per the rules below."
              size="lg"
              variant="outline"
              disabled={sensitiveMut.isPending}
            />
            <RadioGroupItem
              value="ask_first"
              id={`connector-default-ask-${connector.slug}`}
              label="Ask first"
              description={
                <>
                  Every action — including{' '}
                  <span className="text-foreground font-medium">reads</span> — asks before it runs
                  (approve once, or “allow for session”). For email, files, or secrets, where
                  reading is itself risky. A per-tool rule below can still override a specific
                  action.
                </>
              }
              size="lg"
              variant="outline"
              disabled={sensitiveMut.isPending}
            />
          </RadioGroup>
        </div>

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
                        <CodeSnippet code={tsSignature(connector.slug, t)} language="typescript" />
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


function AddAppPanel({
  projectId,
  emailChannelEnabled,
  onAdded,
}: {
  projectId: string;
  emailChannelEnabled: boolean;
  onAdded: (slug?: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const connectStatus = useQuery({
    queryKey: ['connect-status'],
    queryFn: getConnectStatus,
    staleTime: 5 * 60_000,
  });
  const easyConnectDisabled = connectStatus.data?.configured === false;
  const easyConnectLabel = tI18nHardcoded.raw(
    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextEasyConnect19ca1c01',
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-foreground text-xl font-medium">Add a connector</h2>
      </header>
      <Tabs defaultValue={easyConnectDisabled ? 'channels' : 'apps'}>
        <TabsList type="underline">
          {easyConnectDisabled ? (
            <Hint
              label={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextEasyConnectc07266e0',
              )}
            >
              <TabsTrigger value="apps" disabled>
                {easyConnectLabel}
              </TabsTrigger>
            </Hint>
          ) : (
            <TabsTrigger value="apps">{easyConnectLabel}</TabsTrigger>
          )}
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>
        {!easyConnectDisabled && (
          <TabsContent value="apps" className="mt-4">
            <AppCatalogue projectId={projectId} onAdded={onAdded} />
          </TabsContent>
        )}
        <TabsContent value="channels" className="mt-4">
          <ChannelCatalogue
            projectId={projectId}
            emailChannelEnabled={emailChannelEnabled}
            onAdded={onAdded}
          />
        </TabsContent>
        <TabsContent value="custom" className="mt-4">
          <CustomConnectorForm
            projectId={projectId}
            emailChannelEnabled={emailChannelEnabled}
            onAdded={onAdded}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChannelCatalogue({
  projectId,
  emailChannelEnabled,
  onAdded,
}: {
  projectId: string;
  emailChannelEnabled: boolean;
  onAdded: (slug?: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {emailChannelEnabled && <AddEmailProfileCard projectId={projectId} onAdded={onAdded} />}
      <AddSlackProfileCard projectId={projectId} onAdded={onAdded} />
    </div>
  );
}

/**
 * The real Slack logo — the single Slack mark used everywhere across the
 * connectors + channels surface (catalogue cards, channel cards, connect flow),
 * so Slack always reads as Slack and never as a generic glyph. Sized by
 * `className`; defaults to `size-4`.
 */
export function SlackLogo({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-4 shrink-0', className)}>
      <Image
        src={SLACK_ICON_SRC}
        alt=""
        referrerPolicy="no-referrer"
        fill
        sizes="32px"
        className="object-contain"
        unoptimized
      />
    </span>
  );
}

function SlackIconTile() {
  return (
    <span className="border-border/60 bg-card relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-sm border">
      <SlackLogo className="size-3.5" />
    </span>
  );
}

const CHANNEL_CATALOGUE_CARD_CLASS =
  'group bg-popover hover:bg-muted/80 focus-visible:ring-primary/50 flex flex-col rounded-md border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none';

function slugifyConnector(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || 'inbox';
}

function AddEmailProfileCard({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (slug?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Email inbox');
  const [username, setUsername] = useState('');
  const add = useMutation({
    mutationFn: () => {
      const base = slugifyConnector(username || name);
      const slug = `email_${base}_${Date.now().toString(36).slice(-4)}`;
      return createConnector(projectId, {
        slug,
        name: name.trim() || 'Email inbox',
        provider: 'channel',
        platform: 'email',
        credential: 'shared',
      }).then(() => slug);
    },
    onSuccess: (slug) => {
      successToast('Added Email inbox');
      setOpen(false);
      onAdded(slug);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add Email inbox'),
  });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={CHANNEL_CATALOGUE_CARD_CLASS}>
        <div className="flex items-center gap-3">
          <EntityAvatar icon={Mail} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">Email inbox</div>
            <div className="text-muted-foreground truncate text-xs">Channel profile</div>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
          Add a separate AgentMail inbox profile for support, sales, founders, or any mailbox the
          agent should run.
        </p>
      </button>
      <Dialog open={open} onOpenChange={(next) => !add.isPending && setOpen(next)}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
            <DialogTitle>Add Email inbox</DialogTitle>
            <DialogDescription>
              Create a separate connector profile. You choose the AgentMail address when connecting
              it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <Field>
              <Input
                id="email-profile-name"
                name="email-profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Support inbox"
              />
            </Field>
            <Field>
              <Input
                id="email-profile-prefix"
                name="email-profile-prefix"
                value={username}
                onChange={(e) =>
                  setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
                }
                placeholder="support"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-xs">
                Used as the first choice for the AgentMail address, for example support@agentmail.
              </p>
            </Field>
          </div>
          <DialogFooter className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={add.isPending}>
              Cancel
            </Button>
            <Button onClick={() => add.mutate()} disabled={add.isPending} className="gap-1.5">
              {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add inbox
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddSlackProfileCard({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (slug?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const handleConnected = () => {
    successToast('Slack connected');
    setOpen(false);
    onAdded('kortix_slack');
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={CHANNEL_CATALOGUE_CARD_CLASS}>
        <div className="flex items-center gap-3">
          <SlackIconTile />
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">Slack</div>
            <div className="text-muted-foreground truncate text-xs">Built-in channel</div>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
          Add Kortix to Slack so mentions and threaded replies route into Kortix agent sessions.
        </p>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
            <DialogTitle>Add Kortix to Slack</DialogTitle>
            <DialogDescription>
              Connect the built-in Slack channel. The connector profile appears automatically after
              installation.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[75vh] overflow-y-auto px-6 py-5">
            <SlackConnectForm projectId={projectId} onConnected={handleConnected} />
          </div>
        </DialogContent>
      </Dialog>
    </>
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
  const apps = (appsQuery.data?.pages ?? []).flatMap((p) => p.apps);
  const visibleApps = apps.filter((app) => !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug));
  const notConfigured =
    appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');
  const addApp = useMutation({
    mutationFn: (app: { slug: string; name: string }) =>
      createConnector(projectId, {
        slug: app.slug,
        provider: 'pipedream',
        app: app.slug,
        account: 'default',
      }).then(() => app),
    onSuccess: (app) => {
      successToast(`Added ${app.name} — click Connect to authorize`);
      onAdded(app.slug);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add'),
  });

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
          variant="popover"
          className="pl-9"
        />
      </div>
      <div className="overflow-y-auto py-4">
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
              <Skeleton key={i} className="h-[104px] w-full rounded-md" />
            ))}
          </div>
        ) : visibleApps.length === 0 ? (
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
              {visibleApps.map((app) => (
                <button
                  key={app.slug}
                  type="button"
                  disabled={addApp.isPending}
                  onClick={() => addApp.mutate({ slug: app.slug, name: app.name })}
                  className="group bg-popover hover:bg-muted/80 focus-visible:ring-primary/50 flex flex-col rounded-md border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    {app.imgSrc ? (
                      <Image
                        src={app.imgSrc}
                        alt=""
                        width={36}
                        height={36}
                        className="size-8 shrink-0 rounded-md object-contain"
                        referrerPolicy="no-referrer"
                        unoptimized
                      />
                    ) : (
                      <EntityAvatar icon={Zap} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">{app.name}</div>
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
                      <Loading className="size-4 animate-spin" />
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
    </div>
  );
}

function ConnectorConfigFields({
  draft,
  onChange,
  slugEditable,
  emailChannelEnabled = true,
}: {
  draft: ConnectorDraftInput;
  onChange: (d: ConnectorDraftInput) => void;
  slugEditable?: boolean;
  emailChannelEnabled?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const set = (patch: Partial<ConnectorDraftInput>) => onChange({ ...draft, ...patch });
  const setAuth = (patch: Partial<NonNullable<ConnectorDraftInput['auth']>>) =>
    onChange({ ...draft, auth: { ...draft.auth, ...patch } });
  const p = draft.provider;
  const needsAuth = p !== 'pipedream' && p !== 'channel' && p !== 'computer';

  return (
    <FieldGroup className="gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="connector-slug">Slug</FieldLabel>
          <Input
            id="connector-slug"
            value={draft.slug}
            onChange={(e) =>
              set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })
            }
            placeholder="my-api"
            className="font-mono text-xs"
            variant="popover"
            disabled={!slugEditable}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="connector-provider">Provider</FieldLabel>
          <Select
            value={p}
            onValueChange={(v) => {
              const provider = v as ConnectorDraftInput['provider'];
              set({
                provider,
                platform:
                  provider === 'channel'
                    ? draft.platform === 'email' && !emailChannelEnabled
                      ? 'slack'
                      : (draft.platform ?? (emailChannelEnabled ? 'email' : 'slack'))
                    : undefined,
                auth: provider === 'channel' ? { type: 'none' } : draft.auth,
              });
            }}
          >
            <SelectTrigger id="connector-provider" className="w-full" variant="popover">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openapi">OpenAPI</SelectItem>
              <SelectItem value="graphql">GraphQL</SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="channel">Channel</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {p === 'channel' && (
        <div className="space-y-1.5">
          <Label>Channel</Label>
          <Select
            value={
              draft.platform === 'email' && !emailChannelEnabled
                ? 'slack'
                : (draft.platform ?? (emailChannelEnabled ? 'email' : 'slack'))
            }
            onValueChange={(v) => set({ platform: v as ChannelPlatform, auth: { type: 'none' } })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {emailChannelEnabled && <SelectItem value="email">Email</SelectItem>}
              <SelectItem value="slack">Slack</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {p === 'openapi' && (
        <Field>
          <FieldLabel htmlFor="connector-spec">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSpec4235864d',
            )}
          </FieldLabel>
          <Input
            id="connector-spec"
            value={draft.spec ?? ''}
            onChange={(e) => set({ spec: e.target.value })}
            placeholder="https://…/openapi.json"
            variant="popover"
            required
          />
        </Field>
      )}
      {p === 'graphql' && (
        <>
          <Field>
            <FieldLabel htmlFor="connector-endpoint">Endpoint</FieldLabel>
            <Input
              id="connector-endpoint"
              value={draft.endpoint ?? ''}
              onChange={(e) => set({ endpoint: e.target.value })}
              placeholder="https://api/graphql"
              variant="popover"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="connector-sdl">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSDL2325b707',
              )}
            </FieldLabel>
            <Input
              id="connector-sdl"
              value={draft.spec ?? ''}
              onChange={(e) => set({ spec: e.target.value })}
              placeholder=".kortix/executor/schema.graphql"
              variant="popover"
            />
          </Field>
        </>
      )}
      {p === 'mcp' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="connector-url">URL</FieldLabel>
            <Input
              id="connector-url"
              value={draft.url ?? ''}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp…/mcp"
              variant="popover"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="connector-transport">Transport</FieldLabel>
            <Select
              value={draft.transport ?? 'http'}
              onValueChange={(v) => set({ transport: v as 'http' | 'sse' })}
            >
              <SelectTrigger id="connector-transport" className="w-full" variant="popover">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      {p === 'http' && (
        <>
          <Field>
            <FieldLabel htmlFor="connector-base-url">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelBase744ecef9',
              )}
            </FieldLabel>
            <Input
              id="connector-base-url"
              value={draft.baseUrl ?? ''}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://api.internal"
              variant="popover"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="connector-routes">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelRoutes38b14436',
              )}
            </FieldLabel>
            <Input
              id="connector-routes"
              value={draft.spec ?? ''}
              onChange={(e) => set({ spec: e.target.value })}
              placeholder=".kortix/executor/routes.toml"
              variant="popover"
            />
          </Field>
        </>
      )}
      {needsAuth && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="connector-auth">Auth</FieldLabel>
            <Select
              value={draft.auth?.type ?? 'none'}
              onValueChange={(v) => setAuth({ type: v as 'none' | 'bearer' | 'basic' | 'custom' })}
            >
              <SelectTrigger id="connector-auth" className="w-full" variant="popover">
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
          </Field>
          {draft.auth?.type === 'custom' && (
            <Field>
              <FieldLabel htmlFor="connector-auth-header">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelHeader9b2e0143',
                )}
              </FieldLabel>
              <Input
                id="connector-auth-header"
                value={draft.auth?.name ?? ''}
                onChange={(e) => setAuth({ name: e.target.value })}
                placeholder="X-API-Key"
                variant="popover"
                required
              />
            </Field>
          )}
        </div>
      )}
    </FieldGroup>
  );
}

function connectionValid(d: ConnectorDraftInput, emailChannelEnabled = true): boolean {
  if (d.auth?.type === 'custom' && !d.auth.name?.trim()) return false;
  if (d.provider === 'mcp') return !!d.url?.trim();
  if (d.provider === 'openapi') return !!d.spec?.trim();
  if (d.provider === 'graphql') return !!d.endpoint?.trim();
  if (d.provider === 'http') return !!d.baseUrl?.trim();
  if (d.provider === 'channel') {
    return d.platform === 'slack' || (emailChannelEnabled && d.platform === 'email');
  }
  return true;
}

export function CustomConnectorForm({
  projectId,
  emailChannelEnabled,
  onAdded,
}: {
  projectId: string;
  emailChannelEnabled: boolean;
  onAdded: (slug?: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [draft, setDraft] = useState<ConnectorDraftInput>({
    slug: '',
    provider: 'openapi',
    auth: { type: 'none' },
  });
  useEffect(() => {
    if (!emailChannelEnabled && draft.provider === 'channel' && draft.platform === 'email') {
      setDraft((current) => ({ ...current, platform: 'slack' }));
    }
  }, [draft.platform, draft.provider, emailChannelEnabled]);

  const save = useMutation({
    mutationFn: () => createConnector(projectId, draft),
    onSuccess: () => {
      successToast(`Added ${draft.slug}`);
      onAdded(draft.slug);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add connector'),
  });
  const authActive = !!draft.auth?.type && draft.auth.type !== 'none';

  return (
    <section className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-5">
          <ConnectorConfigFields
            draft={draft}
            onChange={setDraft}
            slugEditable
            emailChannelEnabled={emailChannelEnabled}
          />
          {authActive && (
            <InfoBanner tone="info">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextYouLle5def626',
              )}
            </InfoBanner>
          )}
          <div className="border-border/60 flex justify-end border-t pt-5">
            <Button
              type="submit"
              size="sm"
              disabled={!draft.slug || save.isPending || !connectionValid(draft, emailChannelEnabled)}
              className="gap-1.5"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAddConnectore01e22fc',
              )}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function SetCredentialModal({
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
      successToast('Credential saved');
      setValue('');
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save'),
  });
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSetCredential5e9704a8',
            )}
            {connector?.slug}
          </ModalTitle>
          <ModalDescription>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextStoredEncryptedc3eb374b',
            )}
            <code className="font-mono">{connector?.authSecret}</code>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextAndResolved8293aa3e',
            )}
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value) save.mutate();
          }}
        >
          <ModalBody>
            <div className="space-y-1.5">
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
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!value || save.isPending} className="gap-1.5">
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

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
