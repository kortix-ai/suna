'use client';

import { useCustomizeStore } from '@/stores/customize-store';
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CopyIcon as Copy,
  DotsThreeIcon,
  ArrowSquareOutIcon as ExternalLink,
  KeyIcon as KeyRound,
  LockIcon as Lock,
  type Icon as LucideIcon,
  EnvelopeIcon as Mail,
  MonitorIcon as Monitor,
  PencilSimpleIcon,
  PlugIcon as Plug,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  MagnifyingGlassIcon as Search,
  ShieldWarningIcon as ShieldAlert,
  ShieldCheckIcon as ShieldCheck,
  TrashIcon as Trash2,
  UsersIcon as Users,
  XIcon as X,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import { createFrontendClient } from '@pipedream/sdk/browser';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { HighlightedCode } from '@/components/markdown/code';
import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
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
import {
  usePipedreamConnectMember,
  withPipedreamOverlayEscape,
} from '@/hooks/connectors/use-pipedream-connect-member';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { isConnectorsEnabled } from '@/lib/config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type AdminConnector,
  type Connection,
  type ConnectorAction,
  type ConnectorAuthDiscovery,
  type ConnectorAuthorizationStrategy,
  type ConnectorConfig,
  type ConnectorDraftInput,
  type ConnectorPolicyAction,
  type ConnectorPolicyRule,
  type ConnectorRequestAuthType,
  createConnector,
  deleteConnector,
  discoverConnectionOAuth2,
  discoverConnectorAuth,
  ensureProjectConnectorConnection,
  getConnectorConfig,
  getConnectorPolicies,
  getConnectStatus,
  getProjectDetail,
  listAllConnections,
  listConnections,
  listConnectors,
  listPipedreamApps,
  listProjectAccess,
  type OAuth2DeviceAuthorizationStartResult,
  pipedreamConnect,
  pipedreamConnectConnection,
  pipedreamFinalize,
  pipedreamFinalizeConnection,
  pollConnectionOAuth2DeviceAuthorization,
  putConnectionOAuth2Application,
  reconcileConnection,
  reconcileMemberConnection,
  revokeConnection,
  setConnectorAuthorizationStrategy,
  setConnectorCredential,
  setConnectorName,
  setConnectorPolicies,
  setConnectorSensitive,
  setDefaultConnection,
  startConnectionOAuth2Authorization,
  startConnectionOAuth2DeviceAuthorization,
  syncConnectors,
  updateConnectionCredential,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  buildOAuth2ApplicationInput,
  buildOAuth2CredentialInput,
  createConnectorWithOptionalOAuth2,
  EMPTY_OAUTH2_APPLICATION_FORM,
  EMPTY_OAUTH2_CREDENTIAL_FORM,
  mergeOAuth2DiscoveryMetadata,
  type OAuth2ApplicationForm,
  oauth2ApplicationFormValid,
  type OAuth2CredentialForm,
  oauth2CredentialFormValid,
} from './connector-oauth2';
import { OAuth2ApplicationFields } from './connector-oauth2-application-fields';
import { OAuth2CredentialFields } from './connector-oauth2-fields';
import {
  connectionOwnerTypeForStrategy,
  buildEasyConnectConnectorDraft,
  buildEmailConnectorConnectionSlug,
  connectorConnectionQueryKeys,
  connectorAuthorizationStrategyForProvider,
  connectorAuthorizationStrategyIsEditable,
  connectorAuthorizationUpdateIsPending,
  connectorSetupStatus,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  type EasyConnectApp,
  proposeConnectorConnectionSlug,
} from './connector-connection-form';
import { AuthorizationStrategyField, ConnectorConnectionModal } from './connector-connection-modal';
import { DiscoverCatalogue } from './discover-catalogue';
import { connectorConnectionRows } from './view/connector-connections';

// All moved OUT of this file. It is 5,219 lines and 50 components; a plain
// function and a hook exported beside them took the whole module off React Fast
// Refresh's hot path (every edit = full page reload) and forced any consumer of
// either symbol to bundle all of it.
//
// `providerLabel` and `usePipedreamConnect` came back byte-identical.
// `ConnectorStatusBadge` and `ConnectorAppIcon` did NOT — the new catalog needs
// a quieter row, so the badge dropped its green "Connected" case (an active
// connector now renders nothing) and moved "Needs setup" from `warning` to
// `info`, and the icon dropped its `p-1` inset. Those three changes land on
// this legacy surface too, at the detail header below. That is a deliberate
// shared definition, not an accident: two connector badges that disagree is
// worse than one that changed.
import {
  ConnectorAppIcon,
  ConnectorStatusBadge,
} from '@/features/workspace/capabilities/connectors/connector-identity';
import { providerLabel } from '@/features/workspace/capabilities/connectors/provider-label';
import { usePipedreamConnect } from '@/hooks/connectors/use-pipedream-connect-app';
import { useCopy } from '@/hooks/use-copy';

const RISK_VARIANT: Record<ConnectorAction['risk'], 'outline' | 'secondary' | 'destructive'> = {
  read: 'outline',
  write: 'secondary',
  destructive: 'destructive',
};

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);
const SLACK_ICON_SRC = 'https://www.google.com/s2/favicons?domain=slack.com&sz=128';

/**
 * Connect another project-owned account under one connector (support@ alongside
 * sales@). Mints a labelled project-owned connection, then runs that connection's
 * OAuth handshake — the same per-connection flow the personal connect uses.
 */
function usePipedreamConnectProject(projectId: string, slug: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async (input: { label: string }) => {
      const connection = await reconcileConnection(projectId, {
        connector_alias: slug,
        owner_type: 'project',
        label: input.label.trim(),
      });
      const { token, app } = await pipedreamConnectConnection(projectId, connection.connection_id);
      if (!token || !app) throw new Error('App connect is not configured');
      const pd = createFrontendClient({
        externalUserId: `${projectId}:${slug}:${connection.connection_id}`,
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
      await pipedreamFinalizeConnection(projectId, connection.connection_id);
      return { connected: true };
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      successToast('Project connection added');
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
  const connectionQueryKeys = useMemo(
    () => connectorConnectionQueryKeys(projectId),
    [projectId],
  );
  const queryKey = connectionQueryKeys[0];
  const invalidate = () => {
    for (const affectedQueryKey of connectionQueryKeys) {
      void queryClient.invalidateQueries({ queryKey: affectedQueryKey });
    }
  };

  const query = useQuery({
    queryKey,
    queryFn: () => listConnectors(projectId),
    staleTime: 10_000,
  });
  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const connectors = useMemo(() => query.data?.connectors ?? [], [query.data]);
  const emailChannelEnabled = projectQuery.data?.project?.experimental?.agentmail_email === true;
  const discoverEnabled =
    projectQuery.data?.project?.experimental?.connectors_api_discover === true;
  const isForbidden = query.isError && /403|forbidden/i.test((query.error as Error)?.message ?? '');
  // READ vs WRITE: the section is visible to project.connector.read, but every
  // mutating control (rename/remove/reconnect/credentials/permissions/channels/
  // config) is gated on project.connector.write. Fails closed until the probe
  // resolves, matching the backend's assertProjectCapability on those routes.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;

  // Selection persists in ?c= (slug | "global" | "add") for deep links.
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawC = search?.get('c') ?? '';
  const oauth2Result = search?.get('oauth2');
  const oauth2Error = search?.get('oauth2_error');
  useEffect(() => {
    if (oauth2Result !== 'connected' && oauth2Result !== 'error') return;
    if (oauth2Result === 'connected') successToast('OAuth 2.0 connection completed');
    else errorToast(oauth2Error || 'OAuth 2.0 connection failed');
    for (const affectedQueryKey of connectionQueryKeys) {
      void queryClient.invalidateQueries({ queryKey: affectedQueryKey });
    }
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete('oauth2');
    params.delete('oauth2_error');
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  }, [connectionQueryKeys, oauth2Error, oauth2Result, pathname, queryClient, router, search]);
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
          connectors={connectors}
          selection={selection}
          onSelect={select}
          onSync={() => sync.mutate()}
          syncing={sync.isPending}
          canWrite={canWrite}
        />
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selection.kind === 'add' ? (
          <AddAppPanel
            projectId={projectId}
            emailChannelEnabled={emailChannelEnabled}
            discoverEnabled={discoverEnabled}
            existingSlugs={connectors.map((connector) => connector.slug)}
            canWrite={canWrite}
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
            canWrite={canWrite}
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
  const status = connectorSetupStatus(c);
  if (status === 'error') return 'bg-destructive';
  if (status === 'needs_setup') return 'bg-kortix-orange';
  if (status === 'user_managed') return 'bg-kortix-blue';
  return 'bg-kortix-green';
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
        {saving && <Loading className="size-4 shrink-0" />}
        {label}
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
  canWrite = false,
}: {
  connectors: AdminConnector[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onSync: () => void;
  syncing: boolean;
  canWrite?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? connectors.filter((c) => c.slug.toLowerCase().includes(q.trim().toLowerCase()))
    : connectors;
  const ready = filtered.filter((c) => connectorSetupStatus(c) !== 'needs_setup');
  const needsSetup = filtered.filter((c) => connectorSetupStatus(c) === 'needs_setup');
  const isSel = (slug: string) => selection.kind === 'connector' && selection.slug === slug;

  return (
    <nav
      aria-label="Connectors"
      className="border-border/60 bg-muted/20 flex w-72 shrink-0 flex-col border-r"
    >
      <div className="border-border/60 space-y-2 border-b p-3">
        {canWrite && (
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
        )}
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
            {ready.length > 0 && <RailGroupLabel>Available</RailGroupLabel>}
            {ready.map((c) => (
              <RailItem
                key={c.slug}
                leading={<ConnectorAppIcon connector={c} size="sm" />}
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
                leading={<ConnectorAppIcon connector={c} size="sm" />}
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

      {canWrite && (
        <div className="border-border/60 border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground w-full justify-start gap-2"
            onClick={onSync}
            disabled={syncing}
          >
            {syncing ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSyncFromb820661f',
            )}
          </Button>
        </div>
      )}
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
      {/* The card's own padding and type size ride on this wrapper now. A
          `[&_code]:` selector is one specificity step above HighlightedCode's
          own `text-sm`, so the smaller type wins without `!important`. The
          parent already scrolls, so the code element just overflows into it. */}
      <div className="p-3 [&_code]:text-xs">
        <HighlightedCode code={code} language={language} />
      </div>
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

/** One row in the connections list — a single connected account. */
function ConnectionRow({
  connection,
  isMine,
  canManage,
  onSetDefault,
  onDisconnect,
  onStartSession,
  pending,
  disabled = false,
}: {
  connection: Connection;
  isMine: boolean;
  canManage: boolean;
  onSetDefault: () => void;
  onDisconnect: () => void;
  onStartSession?: () => void;
  pending: boolean;
  disabled?: boolean;
}) {
  const isProjectAuthorization = connection.owner_type === 'project';
  const active = connection.status === 'active';
  // Only the owner of a connection may change it: your own personal connection,
  // or, for a project authorization, a project manager.
  const mayMutate = isProjectAuthorization ? canManage : isMine;

  const { copy } = useCopy({ successMessage: 'Connection ID copied to clipboard.' });

  return (
    <li className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          isProjectAuthorization ? 'bg-kortix-blue/15' : 'bg-kortix-purple/15',
        )}
      >
        {isProjectAuthorization ? (
          <Users className="text-kortix-blue size-5" />
        ) : (
          <Lock className="text-kortix-purple size-5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{connection.label}</span>
          {connection.is_default && (
            <Badge variant="outline" size="xs">
              Default
            </Badge>
          )}
        </div>
        <InlineMeta>
          {isProjectAuthorization ? 'Shared with the project' : 'Private — only you'}
          {active ? null : connection.status === 'revoked' ? 'Disconnected' : 'Error'}
          {/* Every connection carries its own id — this is what a backend passes
              in connector_bindings to run as THIS account. Truncated to keep the
              row readable; the row menu copies the full value. */}
          <Hint label="Connection ID — use it in the backend (connector_bindings) to run as this connection.">
            <code className="cursor-help font-mono">{connection.connection_id.slice(0, 8)}…</code>
          </Hint>
        </InlineMeta>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={`Actions for ${connection.label}`}
            disabled={pending || disabled}
          >
            {pending ? <Loading className="size-4 shrink-0" /> : <DotsThreeIcon className="size-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={() => copy(connection.connection_id)}>
            Copy connection ID
          </DropdownMenuItem>
          {mayMutate && isMine && active && onStartSession && (
            <DropdownMenuItem onClick={onStartSession}>Use in a new session</DropdownMenuItem>
          )}
          {mayMutate && !connection.is_default && active && (
            <DropdownMenuItem onClick={onSetDefault}>
              Use by default{isProjectAuthorization ? ' for the project' : ''}
            </DropdownMenuItem>
          )}
          {mayMutate && <DropdownMenuItem onClick={onDisconnect}>Disconnect</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * Every connection that matches the connector's exclusive owner strategy.
 * A project connector lists project-managed accounts. A user connector
 * lists only the current member's accounts.
 */

export function ConnectionsList({
  projectId,
  connector,
  displayName,
  canManageConnections,
  onChanged,
  onStartSession,
  disabled = false,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canManageConnections: boolean;
  onChanged: () => void;
  onStartSession?: () => void;
  disabled?: boolean;
}) {
  const [addScope, setAddScope] = useState<'project' | 'member' | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState<Connection | null>(null);

  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
  });
  const connectionOwnerType = connectionOwnerTypeForStrategy(connector.authorizationStrategy);
  useEffect(() => {
    setAddScope(null);
    setLabelDraft('');
  }, [connector.authorizationStrategy]);
  const refresh = () => {
    void connectionsQuery.refetch();
    onChanged();
  };

  const rows = connectorConnectionRows(connectionsQuery.data?.connections, connector.slug).filter(
    (connection) => connection.owner_type === connectionOwnerType,
  );

  const addProject = usePipedreamConnectProject(projectId, connector.slug, () => {
    setAddScope(null);
    setLabelDraft('');
    refresh();
  });
  const addMine = usePipedreamConnectMember(projectId, connector.slug, () => {
    setAddScope(null);
    setLabelDraft('');
    refresh();
  });
  const setDefault = useMutation({
    mutationFn: (connectionId: string) => setDefaultConnection(projectId, connectionId),
    onSuccess: () => {
      successToast('Default connection updated');
      refresh();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to set the default'),
  });
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => revokeConnection(projectId, connectionId),
    onSuccess: () => {
      successToast('Disconnected');
      setConfirmDisconnect(null);
      refresh();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to disconnect'),
  });

  const adding = addProject.isPending || addMine.isPending;
  const submitAdd = () => {
    if (disabled || !labelDraft.trim()) return;
    if (connectionOwnerType === 'project') addProject.mutate({ label: labelDraft });
    else addMine.mutate({ label: labelDraft });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Label>Connections</Label>
        <div className="flex items-center gap-2">
          {connectionOwnerType === 'project' && canManageConnections && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAddScope('project')}
              disabled={disabled}
            >
              <Plus className="size-4" />
              Add project connection
            </Button>
          )}
          {connectionOwnerType === 'member' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddScope('member')}
              disabled={disabled}
            >
              <Lock className="size-3.5 shrink-0" />
              Add my own
            </Button>
          )}
        </div>
      </div>

      {connectionsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-md" />
          <Skeleton className="h-14 rounded-md" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Plug}
          title={`No ${displayName} connections yet`}
          description={
            connectionOwnerType === 'project'
              ? 'Connect a project-managed account for allowed sessions.'
              : 'Connect your own account for your private sessions.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((connection) => (
            <ConnectionRow
              key={connection.connection_id}
              connection={connection}
              isMine={connection.owner_type === 'member'}
              canManage={canManageConnections}
              pending={
                (setDefault.isPending && setDefault.variables === connection.connection_id) ||
                (disconnect.isPending && disconnect.variables === connection.connection_id)
              }
              disabled={disabled}
              onSetDefault={() => setDefault.mutate(connection.connection_id)}
              onDisconnect={() => setConfirmDisconnect(connection)}
              onStartSession={onStartSession}
            />
          ))}
        </ul>
      )}

      <Modal
        open={addScope !== null}
        onOpenChange={(open) => {
          if (!open && !adding) {
            setAddScope(null);
            setLabelDraft('');
          }
        }}
      >
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>
              {addScope === 'project'
                ? `Add a project ${displayName} connection`
                : `Add your own ${displayName}`}
            </ModalTitle>
            <ModalDescription>
              {addScope === 'project'
                ? 'Everyone on this project can use it. Name it so people can tell your accounts apart.'
                : 'Only you can use it, in your own private sessions. Name it to tell your accounts apart.'}
            </ModalDescription>
          </ModalHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            <ModalBody>
              <Field>
                <FieldLabel htmlFor="connection-label">Name</FieldLabel>
                <Input
                  id="connection-label"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  placeholder={addScope === 'project' ? 'Support inbox' : 'Work'}
                  maxLength={255}
                  autoFocus
                  disabled={adding || disabled}
                />
                <FieldDescription>You'll authorize the account in the next step.</FieldDescription>
              </Field>
            </ModalBody>
            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                onClick={() => {
                  setAddScope(null);
                  setLabelDraft('');
                }}
                disabled={adding}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={adding || disabled || !labelDraft.trim()}>
                {adding ? <Loading className="size-4 shrink-0" /> : null}
                Continue
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={confirmDisconnect !== null}
        onOpenChange={(open) => !open && setConfirmDisconnect(null)}
        title={`Disconnect "${confirmDisconnect?.label ?? ''}"?`}
        description={
          confirmDisconnect?.owner_type === 'project'
            ? 'Everyone on this project loses access to this account. Sessions bound to it will stop working.'
            : 'Your own connection is removed. Sessions bound to it will stop working.'
        }
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        isPending={disconnect.isPending}
        onConfirm={() => confirmDisconnect && disconnect.mutate(confirmDisconnect.connection_id)}
      />
    </section>
  );
}

function RosterStatusBadge({ status }: { status: 'active' | 'revoked' | 'error' }) {
  if (status === 'active') {
    return (
      <Badge variant="outline" size="sm" className="text-emerald-600">
        Connected
      </Badge>
    );
  }
  return (
    <Badge variant="outline" size="sm" className="text-muted-foreground">
      {status === 'revoked' ? 'Disconnected' : 'Error'}
    </Badge>
  );
}

/**
 * Owner/admin read-only roster: which project members have connected their OWN
 * account for this connector, and its status. Manage-gated at the API; never
 * shows credentials (only existence + status + owner). Read-only.
 */
export function ConnectionRoster({
  projectId,
  connectorSlug,
  displayName,
}: {
  projectId: string;
  connectorSlug: string;
  displayName: string;
}) {
  const connectionsQuery = useQuery({
    queryKey: ['connections-all', projectId],
    queryFn: () => listAllConnections(projectId),
    staleTime: 30_000,
  });
  const accessQuery = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId),
    ...contract('inventory'),
  });
  const emailByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of accessQuery.data?.members ?? []) {
      if (member.email) map.set(member.user_id, member.email);
    }
    return map;
  }, [accessQuery.data]);
  const rows = (connectionsQuery.data?.connections ?? []).filter(
    (connection) =>
      connection.connector_alias === connectorSlug && connection.owner_type === 'member',
  );
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="text-muted-foreground border-b px-4 py-2.5 text-xs font-medium">
        Project members' own {displayName} connections
      </div>
      {connectionsQuery.isLoading ? (
        <div className="text-muted-foreground px-4 py-3 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground px-4 py-3 text-sm">
          No project member has connected their own {displayName} yet.
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((connection) => (
            <li
              key={connection.connection_id}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <span className="min-w-0 truncate text-sm">
                {emailByUser.get(connection.owner_id ?? '') ??
                  connection.owner_id ??
                  'Unknown member'}
              </span>
              <RosterStatusBadge status={connection.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ConnectorDetail({
  projectId,
  connector,
  onChanged,
  onRemoved,
  canWrite = false,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
  onRemoved: () => void;
  canWrite?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  // Computer (Agent Computer Tunnel) connectors, like channels, are managed from
  // a dedicated tab (Computers): no generic credential / connect / remove UI.
  const isComputer = connector.provider === 'computer';
  const isManaged = isComputer;
  const authorizationStrategyEditable = connectorAuthorizationStrategyIsEditable(
    connector.provider,
  );
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  const setSection = useCustomizeStore((s) => s.setSection);
  const connected = usesProjectAuthorization && connector.secretSet;
  // The connection's connection_id — the reference a backend (Kortix as a Backend)
  // passes in `connector_bindings` to run a session AS this connection. It isn't
  // surfaced anywhere else, so we expose + copy it here. Project-default connection
  // only (the account this connector is connected as for the whole project).
  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    enabled: !isChannel && !isComputer,
  });
  const connection = connectionsQuery.data?.connections.find(
    (p) => p.connector_alias === connector.slug && p.owner_type === 'project' && p.is_default,
  );
  // The CURRENT USER's own private (member-owned) connection for this connector,
  // if any — separate from the project's shared connection. The API scopes this
  // list to the caller, so a member sees only their own member connection here.
  const myPrivateConnection = connectionsQuery.data?.connections.find(
    (p) => p.connector_alias === connector.slug && p.owner_type === 'member',
  );
  const reconnect = usePipedreamConnect(projectId, connector.slug, onChanged);
  // Administering project connections (adding another, changing the project default)
  // is manager-gated; a member always manages their OWN connections.
  const canManageConnections =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE).allowed === true;
  // Start a new session that uses this member's OWN connection for this connector.
  // `inherit_unbound` keeps the project default for every OTHER connector the agent
  // uses, so binding just this one doesn't null the rest. The session is private by
  // default, which is required for a member-owned binding to resolve.
  const newSession = useNewProjectSession(projectId);
  const startPrivateSession = () => {
    // Require THIS user's own connection by alias — the server resolves their
    // member connection and, if it was revoked, the connect-to-start gate re-prompts.
    newSession({ create: { require_connectors: [connector.slug] } });
  };
  const [credOpen, setCredOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const displayName = connector.name?.trim() || connector.slug;

  // Which tabs this connector actually has. Pipedream connectors hold many
  // connections (project + per-member), so they get Connections; everything else
  // has at most one shared credential, which lives under Connection.
  const showConnections = isPipedream && !isChannel && !isComputer;
  const showConnectionTab = canWrite && !isPipedream && !isManaged;
  const showPermissions = canWrite;
  const showRoster =
    showConnections && canManageConnections && connector.authorizationStrategy === 'user';
  const defaultDetailTab = showConnections
    ? 'connections'
    : showConnectionTab
      ? 'connection'
      : showPermissions
        ? 'permissions'
        : '';
  const detailTabCount =
    (showConnections ? 1 : 0) +
    (showConnectionTab ? 1 : 0) +
    (showPermissions ? 1 : 0) +
    (showRoster ? 1 : 0);
  const [detailTab, setDetailTab] = useState(defaultDetailTab);
  // Re-pin when the user switches to a connector whose tab set differs.
  useEffect(() => setDetailTab(defaultDetailTab), [defaultDetailTab, connector.slug]);

  // Same query key + filter as ConnectionsList, so the badge can never disagree
  // with the rows it counts (react-query dedupes the fetch).
  const detailConnectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    enabled: showConnections,
  });
  const connectionCount = connectorConnectionRows(
    detailConnectionsQuery.data?.connections,
    connector.slug,
  ).filter(
    (connection) =>
      connection.owner_type === connectionOwnerTypeForStrategy(connector.authorizationStrategy),
  ).length;

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  const [authorizationStrategyAwaitingRefresh, setAuthorizationStrategyAwaitingRefresh] =
    useState<ConnectorAuthorizationStrategy | null>(null);
  useEffect(() => {
    setEditingName(false);
    setNameDraft(displayName);
  }, [connector.slug, displayName]);
  useEffect(() => {
    if (authorizationStrategyAwaitingRefresh === connector.authorizationStrategy) {
      setAuthorizationStrategyAwaitingRefresh(null);
    }
  }, [authorizationStrategyAwaitingRefresh, connector.authorizationStrategy]);

  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, connector.slug, nameDraft.trim()),
    onSuccess: () => {
      successToast('Renamed');
      setEditingName(false);
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to rename'),
  });

  const updateAuthorizationStrategy = useMutation({
    mutationFn: (next: ConnectorAuthorizationStrategy) =>
      setConnectorAuthorizationStrategy(projectId, connector.slug, next),
    onSuccess: (result, next) => {
      const syncError = result.sync?.errors.find((error) => error.slug === connector.slug);
      if (syncError) {
        warningToast(
          `Authorization owner changed, but synchronization failed: ${syncError.error}. Use Sync to retry.`,
        );
        onChanged();
        return;
      }
      successToast(`Authorization owner set to ${next === 'project' ? 'Project' : 'User'}`);
      onChanged();
    },
    onError: (error: Error) => {
      setAuthorizationStrategyAwaitingRefresh(null);
      errorToast(error.message || 'Failed to update authorization owner');
    },
  });
  const strategyUpdating = connectorAuthorizationUpdateIsPending(
    connector.authorizationStrategy,
    authorizationStrategyAwaitingRefresh,
    updateAuthorizationStrategy.isPending,
  );

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
        <ConnectorAppIcon connector={connector} size="lg" />
        <div className="min-w-0 flex-1">
          {editingName && canWrite ? (
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
                disabled={strategyUpdating}
              />
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="h-9 w-9"
                disabled={rename.isPending || strategyUpdating}
                aria-label={tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrAriaLabela08f6c74',
                )}
              >
                {rename.isPending ? (
                  <Loading className="size-4 shrink-0" />
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
                disabled={rename.isPending || strategyUpdating}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="group flex items-center gap-2">
              <h2 className="text-foreground truncate text-lg font-semibold">{displayName}</h2>
              {canWrite && (
                <Hint label="Rename">
                  <button
                    type="button"
                    onClick={() => !strategyUpdating && setEditingName(true)}
                    disabled={strategyUpdating}
                    aria-label="Rename"
                    className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <PencilSimpleIcon className="h-3.5 w-3.5" />
                  </button>
                </Hint>
              )}
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
        {canWrite &&
          connector.authSecret &&
          connected &&
          !isChannel &&
          usesProjectAuthorization &&
          (isPipedream ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => reconnect.mutate()}
              disabled={reconnect.isPending || strategyUpdating}
            >
              {reconnect.isPending ? (
                <Loading className="size-4 shrink-0" />
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
              disabled={strategyUpdating}
            >
              <KeyRound className="h-4 w-4" />
              Replace credential
            </Button>
          ))}
      </div>

      <div className="mt-7 space-y-5">
        <section className="space-y-2">
          <Label>Authorization</Label>
          <div className="bg-popover rounded-md border px-4 py-3">
            <AuthorizationStrategyField
              idPrefix={`connector-${connector.slug}`}
              value={connector.authorizationStrategy}
              onChange={(next) => {
                setCredOpen(false);
                setAuthorizationStrategyAwaitingRefresh(next);
                updateAuthorizationStrategy.mutate(next);
              }}
              disabled={!canWrite || !authorizationStrategyEditable}
              // Settled once the connector exists. Switching owner after the
              // fact silently changes WHOSE account every future session runs
              // as, and orphans the connections and permission rules already
              // attached under the old owner — a change that looks like a
              // toggle and behaves like a migration.
              //
              // UI-only: `updateAuthorizationStrategy` below and its route are
              // left intact, so re-enabling is deleting this one prop.
              lockedReason="Set when the connector was created. Remove and re-add the connector to change it — switching now would orphan the connections and permission rules already stored under the current owner."
              pending={strategyUpdating}
            />
          </div>
        </section>
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
        {/* Project-owned connectors accept only project-managed connections. */}
        {connector.authSecret && !connected && !isChannel && usesProjectAuthorization && (
          <InfoBanner
            tone="info"
            icon={Users}
            title={`Connect ${displayName} for the project`}
            action={
              canWrite ? (
                <Button
                  size="lg"
                  className="h-11 shrink-0 gap-2 px-5 font-semibold"
                  onClick={() => (isPipedream ? reconnect.mutate() : setCredOpen(true))}
                  disabled={strategyUpdating || (isPipedream && reconnect.isPending)}
                >
                  {isPipedream && reconnect.isPending && <Loading className="size-4 shrink-0" />}
                  {isPipedream ? 'Connect for the project' : 'Set shared credential'}
                </Button>
              ) : undefined
            }
          >
            {isPipedream
              ? `One project-managed ${displayName} account is available to allowed sessions and triggers.`
              : `One shared credential that everyone on this project uses — the agent and your triggers run on it.`}
          </InfoBanner>
        )}
        {connector.authSecret &&
          !isPipedream &&
          !isChannel &&
          !isComputer &&
          !usesProjectAuthorization && (
            <InfoBanner
              tone="info"
              icon={Lock}
              title={`Connect ${displayName} for your sessions`}
              action={
                <Button
                  size="lg"
                  className="h-11 shrink-0 gap-2 px-5 font-semibold"
                  onClick={() => setCredOpen(true)}
                  disabled={strategyUpdating}
                >
                  <KeyRound className="size-4 shrink-0" />
                  Set or replace my credential
                </Button>
              }
            >
              Your credential is private to your account. Only your private sessions can use this
              connection.
            </InfoBanner>
          )}
        {/* One tab per question this page answers: what can I use (Connections),
            what may the agent do with it (Permissions), which project members
            connected their own (Project members). Before this, everything stacked
            into one long scroll above a lone "Permissions" tab, because the only
            other trigger — Connection — is hidden for Pipedream connectors. */}
        {detailTabCount > 0 && (
          <Tabs value={detailTab} onValueChange={setDetailTab} className="gap-3">
            {/* A single trigger is not a choice — it reads as a broken tab bar.
              Computer connectors are managed in Computers, so Permissions is
              all they have left here. */}
            <TabsList
              type="underline"
              className={cn(
                'flex w-full items-center justify-start',
                detailTabCount < 2 && 'hidden',
              )}
            >
              {showConnections && (
                <TabsTrigger value="connections" className="w-fit flex-none gap-2">
                  Connections
                  {connectionCount > 0 ? (
                    <Badge variant="secondary" size="sm">
                      {connectionCount}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              )}
              {showConnectionTab && (
                <TabsTrigger value="connection" className="w-fit flex-none">
                  Connection
                </TabsTrigger>
              )}
              {showPermissions && (
                <TabsTrigger value="permissions" className="w-fit flex-none">
                  Permissions
                </TabsTrigger>
              )}
              {showRoster && (
                <TabsTrigger value="roster" className="w-fit flex-none">
                  Project members
                </TabsTrigger>
              )}
            </TabsList>
            {/* Only connections that match this connector's owner strategy. */}
            {showConnections && (
              <TabsContent value="connections" className="space-y-5">
                <ConnectionsList
                  projectId={projectId}
                  connector={connector}
                  displayName={displayName}
                  canManageConnections={canManageConnections}
                  onChanged={onChanged}
                  onStartSession={startPrivateSession}
                  disabled={strategyUpdating}
                />
              </TabsContent>
            )}
            {/* The sensitive toggle lives under Permissions (it IS a permission
              default), so this tab only exists when there's a single shared
              credential to manage — for Pipedream connectors the Connections
              tab owns that, and this one would be empty. */}
            {showConnectionTab && (
              <TabsContent value="connection" className="space-y-5">
                {isChannel ? (
                  <ChannelConnectionSection
                    projectId={projectId}
                    connector={connector}
                    onChanged={onChanged}
                    onRemoved={onRemoved}
                    canWrite={canWrite && !strategyUpdating}
                  />
                ) : (
                  <ConnectionSection
                    projectId={projectId}
                    connector={connector}
                    onChanged={onChanged}
                    canWrite={canWrite && !strategyUpdating}
                    onSetCredential={
                      isPipedream || !usesProjectAuthorization ? undefined : () => setCredOpen(true)
                    }
                  />
                )}
              </TabsContent>
            )}
            {showPermissions && (
              <TabsContent value="permissions" className="space-y-5">
                <PermissionsSection
                  projectId={projectId}
                  connector={connector}
                  onChanged={onChanged}
                  canWrite={canWrite && !strategyUpdating}
                />
              </TabsContent>
            )}
            {showRoster && (
              <TabsContent value="roster" className="space-y-5">
                <ConnectionRoster
                  projectId={projectId}
                  connectorSlug={connector.slug}
                  displayName={displayName}
                />
              </TabsContent>
            )}
          </Tabs>
        )}

        {canWrite && !isManaged && !isChannel && (
          <div className="bg-popover rounded-md border px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleRemove74be1411',
                  )}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionDeletes0a130396',
                  )}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => setConfirmDelete(true)}
                disabled={strategyUpdating}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            </div>
          </div>
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
        connectionId={
          usesProjectAuthorization
            ? (connection?.connection_id ?? null)
            : (myPrivateConnection?.connection_id ?? null)
        }
        authorizationStrategy={connector.authorizationStrategy}
        open={credOpen}
        onOpenChange={setCredOpen}
        onSaved={onChanged}
      />
    </div>
  );
}

// ─── Channel connection (Email / Slack install state, Voice) ────────

type ChannelPlatform = 'slack' | 'email';

/** Which connection UI a channel connector shows. Wider than ChannelPlatform,
 *  which is the set a user can CREATE — voice is materialized automatically
 *  from the experimental flag and never appears in the add-connector picker. */
type ChannelConnectionPlatform = ChannelPlatform | 'voice';

function connectorPlatform(connector: AdminConnector): ChannelConnectionPlatform | null {
  if (connector.platform === 'slack' || connector.platform === 'email') {
    return connector.platform;
  }
  // `platform` is typed to the platforms that have an install flow; voice has
  // none, so it is matched on the reserved slug instead of widening that type.
  if (connector.slug === 'kortix_voice') return 'voice';
  if (connector.slug === 'kortix_slack') return 'slack';
  if (connector.slug === 'kortix_email') return 'email';
  if (connector.slug.startsWith('email_')) return 'email';
  return null;
}

export function ChannelConnectionSection({
  projectId,
  connector,
  onChanged,
  onRemoved,
  canWrite = false,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
  onRemoved: () => void;
  canWrite?: boolean;
}) {
  const platform = connectorPlatform(connector);
  if (platform === 'email') {
    return (
      <EmailChannelConnection
        projectId={projectId}
        connector={connector}
        onChanged={onChanged}
        onRemoved={onRemoved}
        canWrite={canWrite}
      />
    );
  }
  if (platform === 'slack') {
    return (
      <SlackChannelConnection
        projectId={projectId}
        onChanged={onChanged}
        onRemoved={onRemoved}
        canWrite={canWrite}
      />
    );
  }
  if (platform === 'voice') {
    // Voice genuinely has nothing to connect: no OAuth, no API key, no
    // workspace to link. Calls run on Kortix's own LiveKit project, and each
    // one is scoped to the session that spawned it. Falling through to the
    // warning below told people their connection was broken when it was complete.
    return (
      <section className="space-y-4">
        <Label>Connection</Label>
        <div className="bg-popover rounded-md border px-4 py-3">
          <p className="text-muted-foreground text-sm">
            Nothing to connect — voice calls run on Kortix&apos;s own infrastructure. Your agent can
            start a call, follow what is said, and speak into it. Use the Permissions tab to choose
            what it may do without asking.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <Label>Connection</Label>
      <div className="bg-popover rounded-md border px-4 py-3">
        <InfoBanner tone="warning">
          This channel connection is missing its platform setting.
        </InfoBanner>
      </div>
    </section>
  );
}

function EmailChannelConnection({
  projectId,
  connector,
  onChanged,
  onRemoved,
  canWrite = false,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
  onRemoved: () => void;
  canWrite?: boolean;
}) {
  const install = useEmailInstall(projectId, connector.slug);

  return (
    <section className="space-y-4">
      <Label>Email connection</Label>
      <p className="text-muted-foreground -mt-2 text-xs">
        AgentMail inbox assigned to this connection.
      </p>
      <div className="bg-popover rounded-md border px-4 py-3">
        {install.isLoading ? (
          <Skeleton className="h-24 w-full rounded-2xl" />
        ) : install.data ? (
          <ConnectedEmailConnection
            projectId={projectId}
            connectorSlug={connector.slug}
            installation={install.data}
            onRemoved={onRemoved}
            canWrite={canWrite}
          />
        ) : canWrite ? (
          <EmailConnectForm
            projectId={projectId}
            connectorSlug={connector.slug}
            onConnected={onChanged}
          />
        ) : (
          <InfoBanner tone="neutral" icon={Mail} title="Email not connected">
            This channel connection has no AgentMail inbox yet.
          </InfoBanner>
        )}
      </div>
    </section>
  );
}

function ConnectedEmailConnection({
  projectId,
  connectorSlug,
  installation,
  onRemoved,
  canWrite = false,
}: {
  projectId: string;
  connectorSlug: string;
  installation: EmailInstallation;
  onRemoved: () => void;
  canWrite?: boolean;
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
        canWrite={canWrite}
      />
      {canWrite && (
        <div className="flex items-center justify-end gap-2">
          {confirming ? (
            <>
              <span className="text-muted-foreground mr-auto text-xs">
                Removes the Email connection from this project.
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
                {disconnect.isPending ? <Loading className="mr-2 size-3.5 shrink-0" /> : null}
                Disconnect
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </div>
      )}
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
  canWrite = false,
}: {
  projectId: string;
  connectorSlug: string;
  policy: EmailSenderPolicy | null | undefined;
  canWrite?: boolean;
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
          disabled={!canWrite}
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
                  disabled={!canWrite}
                />
              </Field>
              <Field>
                <Input
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder="example.com"
                  disabled={!canWrite}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field>
                  <Input
                    value={regex}
                    onChange={(e) => setRegex(e.target.value)}
                    placeholder=".*@customer-[0-9]+\\.com$"
                    spellCheck={false}
                    disabled={!canWrite}
                  />
                </Field>
              </div>
            </div>
          ) : null}
          {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
          {canWrite && (
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
          )}
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
          ? 'Kortix will create and manage the AgentMail inbox for this connection.'
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
                inbox limit. Kortix will still create the webhook for this connection.
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
          {connect.isPending ? <Loading className="mr-2 size-3.5 shrink-0" /> : null}
          Create inbox
        </Button>
      </div>
    </div>
  );
}

function SlackChannelConnection({
  projectId,
  onChanged,
  onRemoved,
  canWrite = false,
}: {
  projectId: string;
  onChanged: () => void;
  onRemoved: () => void;
  canWrite?: boolean;
}) {
  const install = useSlackInstall(projectId);
  return (
    <section className="space-y-4">
      <Label>Slack connection</Label>
      <p className="text-muted-foreground -mt-2 text-xs">
        Slack workspace assigned to this connection.
      </p>
      <div className="bg-popover rounded-md border px-4 py-3">
        {install.isLoading ? (
          <Skeleton className="h-24 w-full rounded-2xl" />
        ) : install.data ? (
          <ConnectedSlackConnection
            projectId={projectId}
            installation={install.data}
            onRemoved={onRemoved}
            canWrite={canWrite}
          />
        ) : canWrite ? (
          <SlackConnectForm projectId={projectId} onConnected={onChanged} />
        ) : (
          <InfoBanner tone="neutral" icon={<SlackLogo />} title="Slack not connected">
            This channel connection has no Slack workspace yet.
          </InfoBanner>
        )}
      </div>
    </section>
  );
}

function ConnectedSlackConnection({
  projectId,
  installation,
  onRemoved,
  canWrite = false,
}: {
  projectId: string;
  installation: SlackInstallation;
  onRemoved: () => void;
  canWrite?: boolean;
}) {
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-4">
      <InfoBanner tone="success" icon={Check} title="Slack connected">
        Workspace{' '}
        <code className="font-mono">{installation.workspaceName || installation.workspaceId}</code>
      </InfoBanner>
      {canWrite && (
        <div className="flex items-center justify-end gap-2">
          {confirming ? (
            <>
              <span className="text-muted-foreground mr-auto text-xs">
                Removes the Slack connection from this project.
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
                {disconnect.isPending ? <Loading className="mr-2 size-3.5 shrink-0" /> : null}
                Disconnect
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SlackConnectForm({
  projectId,
  onConnected,
  customOnly = false,
}: {
  projectId: string;
  onConnected: () => void;
  customOnly?: boolean;
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
  const showCustom = customOnly || customOpen || (!mode.isLoading && !installUrl);

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
      {!customOnly &&
        (mode.isLoading ? (
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
        ))}
      <div className={cn(!customOnly && 'space-y-3')}>
        {!customOnly && (
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
        )}
        {showCustom ? (
          <div
            className={cn(
              'space-y-5',
              !customOnly && 'border-border/60 bg-card rounded-2xl border p-4',
            )}
          >
            {!customOnly && (
              <div className="space-y-1">
                <h3 className="text-foreground text-base font-semibold">
                  Bring your own Slack app
                </h3>
                <p className="text-muted-foreground text-sm">
                  For self-hosted setups or custom-scoped installs.
                </p>
              </div>
            )}

            <div className="space-y-3">
              <div
                className={cn(
                  'flex flex-col gap-3',
                  !customOnly && 'sm:flex-row sm:items-end sm:justify-between',
                )}
              >
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
                <Skeleton className={cn('h-52 w-full', !customOnly && 'rounded-2xl')} />
              ) : manifest.isError ? (
                <InfoBanner tone="destructive">
                  {(manifest.error as Error)?.message || 'Failed to load Slack manifest'}
                </InfoBanner>
              ) : manifest.data ? (
                <div
                  className={cn('max-h-[26rem] overflow-auto', !customOnly && 'rounded-2xl')}
                >
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
              <div className={cn('grid gap-3', !customOnly && 'sm:grid-cols-2')}>
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
                  {connect.isPending ? <Loading className="mr-2 size-3.5 shrink-0" /> : null}
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
    headers: cfg.headers ?? {},
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
    // Order matters: reordering headers IS an edit worth saving.
    headers: Object.entries(d.headers ?? {}),
  });
}

export function ConnectionSection({
  projectId,
  connector,
  onChanged,
  canWrite = false,
  onSetCredential,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
  canWrite?: boolean;
  /** Opens the credential dialog. The credential belongs with the auth config
   *  it satisfies, not only in a banner at the top of the page. */
  onSetCredential?: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: qk.project.connectorConfig(projectId, connector.slug),
    queryFn: () => getConnectorConfig(projectId, connector.slug),
    ...contract('config'),
    enabled: canWrite,
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
      queryClient.invalidateQueries({
        queryKey: qk.project.connectorConfig(projectId, connector.slug),
      });
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to save connection'),
  });

  return (
    <section className="space-y-4">
      <Label>Connection</Label>
      <p className="text-muted-foreground -mt-2 text-xs">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionHowa31daf50',
        )}
      </p>
      <div className="bg-popover rounded-md border px-4 py-3">
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
            <ConnectorConfigFields draft={draft} onChange={setDraft} readOnly={!canWrite} />
            {/* The credential lives next to the auth settings that consume it. */}
            {connector.authorizationStrategy === 'project' &&
              connector.authSecret &&
              onSetCredential && (
                <div className="border-border/60 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Credential</p>
                    <p className="text-muted-foreground text-xs">
                      {connector.secretSet
                        ? 'Stored and in use. Setting a new value replaces it.'
                        : 'Not set yet — the agent and your triggers cannot call this connector.'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={connector.secretSet ? 'secondary' : 'outline'}>
                      {connector.secretSet ? 'Set' : 'Not set'}
                    </Badge>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={onSetCredential}
                      >
                        <KeyRound className="size-3.5" />
                        {connector.secretSet ? 'Replace' : 'Set credential'}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            {canWrite && (
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
            )}
          </div>
        )}
      </div>
    </section>
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
  readOnly = false,
}: {
  value: PolicyChoice;
  onChange: (c: PolicyChoice) => void;
  readOnly?: boolean;
}) {
  const meta =
    value === 'default'
      ? { label: 'Default', tint: 'text-muted-foreground' }
      : { label: POLICY_LABEL[value].label, tint: POLICY_LABEL[value].tint };
  if (readOnly) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
          meta.tint,
        )}
      >
        {meta.label}
      </span>
    );
  }
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
  return `connector.call("${slug}", "${action.path}", ${argBlock}): Promise<unknown>`;
}

export function PermissionsSection({
  projectId,
  connector,
  onChanged,
  canWrite = false,
}: {
  projectId: string;
  connector: AdminConnector;
  onChanged: () => void;
  canWrite?: boolean;
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
    enabled: canWrite,
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

  // Tools a PROJECT-scope rule already decides. Project rules are evaluated
  // before connector rules and cannot be overridden here (connector/policy.ts),
  // so without this the panel would show a connector rule the runtime ignores.
  // The server resolves this through the same function the call gate uses.
  const projectDecided = useMemo(() => {
    const decided = new Map<string, ConnectorPolicyAction>();
    for (const entry of policiesQuery.data?.effective ?? []) {
      if (entry.source === 'project') decided.set(entry.path, entry.action);
    }
    return decided;
  }, [policiesQuery.data]);

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
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Permissions</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrDescriptionWhat4e375237',
            )}
          </p>
        </div>
        {tools.length > 6 ? (
          <div className="relative w-48 shrink-0">
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
        ) : null}
      </div>
      {/* Say it once, up front. A project-scope rule beats everything on this
          page and cannot be lifted here — silently rendering the losing value
          is the bug this replaces. */}
      {projectDecided.size > 0 && (
        <InfoBanner
          tone="warning"
          icon={Lock}
          title={`${projectDecided.size} ${projectDecided.size === 1 ? 'action is' : 'actions are'} set by a project-wide rule`}
        >
          Project rules apply across every connector and are evaluated first, so for those actions
          whatever you set here is ignored. They are marked below.
        </InfoBanner>
      )}
      <div className="bg-popover rounded-md border px-4 py-3">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Default</Label>
            <RadioGroup
              value={connector.sensitive ? 'ask_first' : 'follow_rules'}
              onValueChange={(v) => canWrite && sensitiveMut.mutate(v === 'ask_first')}
              className="space-y-2"
            >
              <RadioGroupItem
                value="follow_rules"
                id={`connector-default-follow-${connector.slug}`}
                label="Follow global rules & risk"
                description="Reads run automatically; writes and destructive actions still ask, per the rules below."
                size="lg"
                variant="outline"
                disabled={sensitiveMut.isPending || !canWrite}
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
                disabled={sensitiveMut.isPending || !canWrite}
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
                {canWrite && (
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
                )}
                {canWrite && selected.size > 0 ? (
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
                  const projectAction = projectDecided.get(t.path);
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
                        {canWrite && (
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
                        )}
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : t.path)}
                          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                        >
                          <span className="text-foreground shrink-0 font-mono text-xs">
                            {t.path}
                          </span>
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
                        {projectAction && (
                          <Hint
                            label={`A project-wide rule sets this to "${POLICY_LABEL[projectAction].label}". Project rules are evaluated first and win — anything you set here is ignored for this tool.`}
                          >
                            <Badge variant="outline" size="sm" className="shrink-0 gap-1">
                              <Lock className="size-3 shrink-0" />
                              <span className={POLICY_LABEL[projectAction].tint}>
                                {POLICY_LABEL[projectAction].label}
                              </span>
                              by project
                            </Badge>
                          </Hint>
                        )}
                        <ChevronRight
                          className={cn(
                            'size-3 shrink-0 transition',
                            isOpen
                              ? 'text-muted-foreground/70 rotate-90'
                              : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100',
                          )}
                        />
                        {/* Still editable — a project rule can be lifted later, and
                            staging a connector rule for that is legitimate. Dimmed
                            so it never reads as the thing currently in force. */}
                        <div className={cn(projectAction && 'opacity-40')}>
                          <PermissionPicker
                            value={explicit ?? 'default'}
                            onChange={(c) => setChoice(t.path, c)}
                            readOnly={!canWrite}
                          />
                        </div>
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
                        disabled={!canWrite}
                      />
                      <Select
                        value={r.action}
                        disabled={!canWrite}
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
                      {canWrite && (
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
                      )}
                    </div>
                  ))}
                  {canWrite && (
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
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {canWrite && (
          <SaveBar
            dirty={dirty}
            saving={save.isPending}
            onSave={() => save.mutate()}
            onReset={reset}
            label={tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSave783950c7',
            )}
          />
        )}
      </div>
    </section>
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

export function AddAppPanel({
  projectId,
  emailChannelEnabled,
  discoverEnabled,
  existingSlugs,
  onAdded,
  canWrite = false,
}: {
  projectId: string;
  emailChannelEnabled: boolean;
  discoverEnabled: boolean;
  existingSlugs: readonly string[];
  onAdded: (slug?: string) => void;
  canWrite?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // Self-host without Pipedream configured (KORTIX_PUBLIC_CONNECTORS_ENABLED
  // false) — hide Easy Connect while leaving Discover/direct sources available.
  const connectorsEnabled = isConnectorsEnabled();
  const connectStatus = useQuery({
    queryKey: ['connect-status'],
    queryFn: getConnectStatus,
    staleTime: 5 * 60_000,
    enabled: connectorsEnabled,
  });
  if (!canWrite) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <EmptyState
          icon={Plug}
          title="No connectors yet"
          description="You have read-only access to this project's connectors. Ask a project manager to add one."
        />
      </div>
    );
  }
  const easyConnectHidden = !connectorsEnabled;
  const easyConnectDisabled = easyConnectHidden || connectStatus.data?.configured === false;
  const easyConnectLabel = tI18nHardcoded.raw(
    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextEasyConnect19ca1c01',
  );
  const defaultTab = !easyConnectDisabled ? 'apps' : discoverEnabled ? 'discover' : 'channels';
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-foreground text-xl font-medium">Add a connector</h2>
      </header>
      <Tabs defaultValue={defaultTab}>
        <TabsList type="underline">
          {easyConnectHidden ? null : easyConnectDisabled ? (
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
          {discoverEnabled && <TabsTrigger value="discover">Discover</TabsTrigger>}
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>
        {!easyConnectDisabled && (
          <TabsContent value="apps" className="mt-4">
            <AppCatalogue projectId={projectId} existingSlugs={existingSlugs} onAdded={onAdded} />
          </TabsContent>
        )}
        {discoverEnabled && (
          <TabsContent value="discover" className="mt-4">
            <DiscoverCatalogue
              projectId={projectId}
              existingSlugs={existingSlugs}
              onAdded={onAdded}
            />
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
      {emailChannelEnabled && <AddEmailConnectionCard projectId={projectId} onAdded={onAdded} />}
      <AddSlackConnectionCard projectId={projectId} onAdded={onAdded} />
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

function AddEmailConnectionCard({
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
    mutationFn: async () => {
      const slug = buildEmailConnectorConnectionSlug(username || name, globalThis.crypto.randomUUID());
      const result = await createConnector(
        projectId,
        createOnlyConnectorDraft({
          slug,
          name: name.trim() || 'Email inbox',
          provider: 'channel',
          platform: 'email',
          credential: 'shared',
        }),
      );
      return { slug, syncError: connectorSyncErrorForSlug(result, slug) };
    },
    onSuccess: ({ slug, syncError }) => {
      setOpen(false);
      if (syncError) {
        warningToast(
          `Added the Email inbox to the manifest, but synchronization failed: ${syncError}. Use Sync to retry.`,
        );
        onAdded();
        return;
      }
      successToast('Added Email inbox');
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
            <div className="text-muted-foreground truncate text-xs">Channel connection</div>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
          Add a separate AgentMail inbox connection for support, sales, founders, or any mailbox the
          agent should run.
        </p>
      </button>
      <Modal open={open} onOpenChange={(next) => !add.isPending && setOpen(next)}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>Add Email inbox</ModalTitle>
            <ModalDescription>
              Create a separate connection. You choose the AgentMail address when connecting
              it.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="email-connection-name">Display name</FieldLabel>
              <Input
                id="email-connection-name"
                name="email-connection-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Support inbox"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-connection-prefix">Address prefix</FieldLabel>
              <Input
                id="email-connection-prefix"
                name="email-connection-prefix"
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
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button variant="outline-ghost" onClick={() => setOpen(false)} disabled={add.isPending}>
              Cancel
            </Button>
            <Button onClick={() => add.mutate()} disabled={add.isPending} className="gap-1.5">
              {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Add inbox
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}

function AddSlackConnectionCard({
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
      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Add Kortix to Slack</ModalTitle>
            <ModalDescription>
              Connect the built-in Slack channel. The connection appears automatically after
              installation.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            <SlackConnectForm projectId={projectId} onConnected={handleConnected} />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}

/** Easy-connect app catalogue — searchable card grid with "Load more". */
function AppCatalogue({
  projectId,
  existingSlugs,
  onAdded,
}: {
  projectId: string;
  existingSlugs: readonly string[];
  onAdded: (slug?: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [q, setQ] = useState('');
  const [selectedApp, setSelectedApp] = useState<EasyConnectApp | null>(null);
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
    mutationFn: async (connector: {
      name: string;
      slug: string;
      authorizationStrategy: ConnectorAuthorizationStrategy;
    }) => {
      if (!selectedApp) throw new Error('Select an app');
      const draft = buildEasyConnectConnectorDraft(selectedApp, connector);
      const result = await createConnector(projectId, draft);
      return {
        name: draft.name ?? selectedApp.name,
        slug: draft.slug,
        syncError: connectorSyncErrorForSlug(result, draft.slug),
      };
    },
    onSuccess: (connector) => {
      setSelectedApp(null);
      if (connector.syncError) {
        warningToast(
          `Added ${connector.name} to the manifest, but synchronization failed: ${connector.syncError}. Use Sync to retry.`,
        );
        onAdded();
        return;
      }
      successToast(`Added ${connector.name} — click Connect to authorize`);
      onAdded(connector.slug);
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
                  onClick={() => setSelectedApp(app)}
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
                      <Loading className="size-4 shrink-0" />
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
      <ConnectorConnectionModal
        open={selectedApp !== null}
        idPrefix="easy-connect-connector"
        title={`Add ${selectedApp?.name ?? 'app'}`}
        description="Create a connector for this app. The name and slug identify it in sessions and project configuration."
        initialName={selectedApp?.name ?? ''}
        initialSlug={
          selectedApp ? proposeConnectorConnectionSlug(selectedApp.name, existingSlugs) : ''
        }
        existingSlugs={existingSlugs}
        pending={addApp.isPending}
        onOpenChange={(open) => !open && setSelectedApp(null)}
        onSubmit={(connector) => addApp.mutate(connector)}
      />
    </div>
  );
}

/**
 * Slugify the source document's own name — OpenAPI `info.title`, Postman
 * `info.name` — so adding a spec proposes the slug the API calls itself
 * ("Kortix WhatsApp Gateway" → `kortix-whatsapp-gateway`). Derived from the
 * document rather than its URL: a hostname is a guess, a title is a statement.
 */
function slugFromTitle(title: string | null | undefined): string {
  return (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * Postman-style static header table. Any header, any value, sent on every call
 * this connector makes. Kept as ordered rows (not an object) while editing so a
 * half-typed or duplicate name doesn't silently drop a row out from under the
 * user — the object is only rebuilt on the way out.
 */
function HeadersEditor({
  value,
  onChange,
  readOnly,
  authHeaderName,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  readOnly?: boolean;
  authHeaderName?: string | null;
}) {
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value));
  // Re-seed only when the saved value genuinely differs from what we're showing,
  // so a refetch can't wipe a row the user is mid-way through typing.
  const seeded = useRef(JSON.stringify(Object.entries(value)));
  useEffect(() => {
    const incoming = JSON.stringify(Object.entries(value));
    if (incoming !== seeded.current && incoming !== JSON.stringify(rows)) {
      seeded.current = incoming;
      setRows(Object.entries(value));
    }
  }, [value, rows]);

  const commit = (next: Array<[string, string]>) => {
    setRows(next);
    const out: Record<string, string> = {};
    for (const [k, v] of next) {
      const name = k.trim();
      if (name) out[name] = v;
    }
    seeded.current = JSON.stringify(Object.entries(out));
    onChange(out);
  };

  const nameError = (name: string, index: number): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(trimmed)) return 'Not a valid header name';
    if (trimmed.length > 128) return 'Too long (max 128)';
    if (authHeaderName && trimmed.toLowerCase() === authHeaderName.toLowerCase()) {
      return 'Reserved for the credential — the auth header always wins';
    }
    const dupe = rows.some(
      ([other], i) => i !== index && other.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    return dupe ? 'Duplicate header name' : null;
  };

  return (
    <Field>
      <FieldLabel>Headers</FieldLabel>
      <div className="space-y-2">
        {rows.map(([name, val], i) => {
          const err = nameError(name, i);
          return (
            // Rows are positional and freely reorderable, so the index IS the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  value={name}
                  onChange={(e) =>
                    commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))
                  }
                  placeholder="X-Tenant-Id"
                  className="font-mono text-xs"
                  variant="popover"
                  disabled={readOnly}
                  aria-invalid={!!err}
                />
                <Input
                  value={val}
                  onChange={(e) =>
                    commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))
                  }
                  placeholder="acme"
                  className="font-mono text-xs"
                  variant="popover"
                  disabled={readOnly}
                />
                {!readOnly && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0"
                    aria-label="Remove header"
                    onClick={() => commit(rows.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
              {err && <p className="text-destructive text-xs">{err}</p>}
            </div>
          );
        })}
        {!readOnly && rows.length < 32 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setRows([...rows, ['', '']])}
          >
            <Plus className="size-3.5" /> Add header
          </Button>
        )}
      </div>
      <FieldDescription>
        Sent on every call this connector makes. Stored in the manifest in plain text — put
        credentials in Auth, not here.
      </FieldDescription>
    </Field>
  );
}

function ConnectorConfigFields({
  draft,
  onChange,
  slugEditable,
  emailChannelEnabled = true,
  readOnly = false,
  detectedAuth = null,
  detectedTitle = null,
  oauth2Selected = false,
  onOAuth2SelectedChange,
}: {
  draft: ConnectorDraftInput;
  onChange: (d: ConnectorDraftInput) => void;
  slugEditable?: boolean;
  emailChannelEnabled?: boolean;
  readOnly?: boolean;
  /** What auto-detect found on the source, surfaced inline on the Auth field. */
  detectedAuth?: { type: string; parameterName: string | null } | null;
  /** The source document's own name, used to propose a slug. */
  detectedTitle?: string | null;
  /** Exposes native OAuth2 during initial connector creation. */
  oauth2Selected?: boolean;
  onOAuth2SelectedChange?: (selected: boolean) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // Once the slug is typed in by hand, never overwrite it from the source again.
  const slugTouched = useRef(false);
  const suggestedSlug = slugFromTitle(detectedTitle);
  useEffect(() => {
    // Only ever fills a blank slug, and only before the user types one. Editing
    // an existing connector (slugEditable false) is never touched.
    if (!slugEditable || readOnly || slugTouched.current) return;
    if (!suggestedSlug || draft.slug) return;
    onChange({ ...draft, slug: suggestedSlug });
  }, [suggestedSlug, slugEditable, readOnly, draft, onChange]);
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
            onChange={(e) => {
              slugTouched.current = true;
              set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') });
            }}
            placeholder="my-api"
            className="font-mono text-xs"
            variant="popover"
            disabled={!slugEditable || readOnly}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="connector-provider">Provider</FieldLabel>
          <Select
            value={p}
            disabled={readOnly}
            onValueChange={(v) => {
              const provider = v as ConnectorDraftInput['provider'];
              set({
                provider,
                authorization_strategy: connectorAuthorizationStrategyForProvider(
                  provider,
                  draft.authorization_strategy ?? 'project',
                ),
                platform:
                  provider === 'channel'
                    ? draft.platform === 'email' && !emailChannelEnabled
                      ? 'slack'
                      : (draft.platform ?? (emailChannelEnabled ? 'email' : 'slack'))
                    : undefined,
                auth:
                  provider === 'channel'
                    ? { type: 'none' }
                    : p === 'channel'
                      ? undefined
                      : draft.auth,
              });
            }}
          >
            <SelectTrigger id="connector-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openapi">OpenAPI</SelectItem>
              <SelectItem value="postman">Postman</SelectItem>
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
            disabled={readOnly}
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
      {(p === 'openapi' || p === 'postman') && (
        <Field>
          <FieldLabel htmlFor="connector-spec">
            {p === 'postman'
              ? 'Collection, repository, or workspace'
              : tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrLabelSpec4235864d',
                )}
          </FieldLabel>
          <Input
            id="connector-spec"
            value={draft.spec ?? ''}
            onChange={(e) => set({ spec: e.target.value })}
            placeholder={
              p === 'postman' ? 'https://github.com/… or collection.json' : 'https://…/openapi.json'
            }
            variant="popover"
            disabled={readOnly}
            required
          />
          {p === 'postman' ? (
            <FieldDescription>
              Supports Collection v2 JSON, Postman-managed Git repositories, and configured public
              workspaces.
            </FieldDescription>
          ) : null}
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
              disabled={readOnly}
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
              placeholder=".kortix/connectors/schema.graphql"
              variant="popover"
              disabled={readOnly}
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
              disabled={readOnly}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="connector-transport">Transport</FieldLabel>
            <Select
              value={draft.transport ?? 'http'}
              disabled={readOnly}
              onValueChange={(v) => set({ transport: v as 'http' | 'sse' })}
            >
              <SelectTrigger id="connector-transport" className="w-full">
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
              disabled={readOnly}
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
              placeholder=".kortix/connectors/routes.toml"
              variant="popover"
              disabled={readOnly}
            />
          </Field>
        </>
      )}
      {needsAuth && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="connector-auth">Auth</FieldLabel>
            <Select
              value={oauth2Selected ? 'oauth2_client_credentials' : (draft.auth?.type ?? 'auto')}
              disabled={readOnly}
              onValueChange={(v) => {
                if (v === 'oauth2_client_credentials') {
                  onOAuth2SelectedChange?.(true);
                  set({ auth: { type: 'bearer' } });
                  return;
                }
                onOAuth2SelectedChange?.(false);
                if (v === 'auto') set({ auth: undefined });
                else setAuth({ type: v as ConnectorRequestAuthType });
              }}
            >
              <SelectTrigger id="connector-auth" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect</SelectItem>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer</SelectItem>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="api_key">API key</SelectItem>
                {onOAuth2SelectedChange && (
                  <SelectItem value="oauth2_client_credentials">OAuth 2.0</SelectItem>
                )}
                <SelectItem value="oauth1">OAuth 1.0</SelectItem>
                <SelectItem value="hmac">HMAC-SHA256</SelectItem>
                <SelectItem value="aws_sigv4">AWS Signature Version 4</SelectItem>
                <SelectItem value="mtls">Mutual TLS</SelectItem>
                <SelectItem value="custom">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextCustomHeader1e0e82ed',
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              {oauth2Selected ? (
                'Kortix obtains, refreshes, and injects a bearer token for this connector.'
              ) : draft.auth === undefined && detectedAuth ? (
                <>
                  Detected <span className="font-medium">{detectedAuth.type}</span>
                  {detectedAuth.parameterName ? (
                    <>
                      {' '}
                      via{' '}
                      <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                        {detectedAuth.parameterName}
                      </code>
                    </>
                  ) : null}
                  . Add the credential after saving — you can override this anytime.
                </>
              ) : (
                'Auto-detect reads authentication metadata from the source. Choose None to opt out.'
              )}
            </FieldDescription>
          </Field>
          {/* Show the detected header alongside the select so the actual header
              name is visible without saving first — read-only, because the
              source is the authority until the user picks an explicit override. */}
          {draft.auth === undefined && detectedAuth?.parameterName && (
            <Field>
              <FieldLabel htmlFor="connector-auth-detected">Header name</FieldLabel>
              <Input
                id="connector-auth-detected"
                value={detectedAuth.parameterName}
                readOnly
                variant="popover"
                className="font-mono text-xs"
              />
              <FieldDescription>
                From the source. Choose Custom header to change it.
              </FieldDescription>
            </Field>
          )}
          {(draft.auth?.type === 'custom' || draft.auth?.type === 'api_key') && (
            <>
              <Field>
                <FieldLabel htmlFor="connector-auth-name">Parameter name</FieldLabel>
                <Input
                  id="connector-auth-name"
                  value={draft.auth?.name ?? ''}
                  onChange={(e) => setAuth({ name: e.target.value })}
                  placeholder="X-API-Key"
                  variant="popover"
                  disabled={readOnly}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connector-auth-placement">Placement</FieldLabel>
                <Select
                  value={draft.auth?.in ?? 'header'}
                  disabled={readOnly}
                  onValueChange={(placement) =>
                    setAuth({ in: placement as 'header' | 'query' | 'cookie' })
                  }
                >
                  <SelectTrigger id="connector-auth-placement">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="header">Header</SelectItem>
                    <SelectItem value="query">Query</SelectItem>
                    <SelectItem value="cookie">Cookie</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
        </div>
      )}
      {needsAuth && (
        <HeadersEditor
          value={draft.headers ?? {}}
          onChange={(headers) => set({ headers })}
          readOnly={readOnly}
          authHeaderName={
            draft.auth?.type === 'custom' ? draft.auth?.name : detectedAuth?.parameterName
          }
        />
      )}
    </FieldGroup>
  );
}

function connectionValid(d: ConnectorDraftInput, emailChannelEnabled = true): boolean {
  if ((d.auth?.type === 'custom' || d.auth?.type === 'api_key') && !d.auth.name?.trim()) {
    return false;
  }
  if (d.provider === 'mcp') return !!d.url?.trim();
  if (d.provider === 'openapi') return !!d.spec?.trim();
  if (d.provider === 'postman') return !!d.spec?.trim();
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
    authorization_strategy: 'project',
  });
  const [oauth2Selected, setOauth2Selected] = useState(false);
  const [oauth2, setOauth2] = useState<OAuth2CredentialForm>(EMPTY_OAUTH2_CREDENTIAL_FORM);
  const [discoveryDraft, setDiscoveryDraft] = useState(draft);
  const effectiveAuthorizationStrategy = connectorAuthorizationStrategyForProvider(
    draft.provider,
    draft.authorization_strategy ?? 'project',
  );
  const sharedOAuth2Selected = oauth2Selected && effectiveAuthorizationStrategy === 'project';
  useEffect(() => {
    const timer = window.setTimeout(() => setDiscoveryDraft(draft), 400);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    if (!emailChannelEnabled && draft.provider === 'channel' && draft.platform === 'email') {
      setDraft((current) => ({ ...current, platform: 'slack' }));
    }
  }, [draft.platform, draft.provider, emailChannelEnabled]);
  useEffect(() => {
    if (
      (draft.provider === 'channel' || effectiveAuthorizationStrategy === 'user') &&
      oauth2Selected
    ) {
      setOauth2Selected(false);
    }
  }, [draft.provider, effectiveAuthorizationStrategy, oauth2Selected]);

  const save = useMutation({
    mutationFn: () =>
      createConnectorWithOptionalOAuth2(projectId, draft, sharedOAuth2Selected ? oauth2 : null, {
        createConnector,
        deleteConnector,
        setConnectorCredential,
      }),
    onSuccess: (result) => {
      if (result.syncError) {
        warningToast(
          `Added ${draft.slug} to the manifest, but synchronization failed: ${result.syncError}. Use Sync to retry.`,
        );
        onAdded();
        return;
      }
      successToast(
        result.credentialStored ? `Added and connected ${draft.slug}` : `Added ${draft.slug}`,
      );
      onAdded(draft.slug);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add connector'),
  });
  const discovery = useQuery<ConnectorAuthDiscovery>({
    queryKey: ['connector-auth-discovery', projectId, discoveryDraft],
    queryFn: () => discoverConnectorAuth(projectId, discoveryDraft),
    enabled:
      discoveryDraft.auth === undefined &&
      connectionValid(discoveryDraft, emailChannelEnabled) &&
      discoveryDraft.provider !== 'channel' &&
      discoveryDraft.provider !== 'pipedream' &&
      discoveryDraft.provider !== 'computer',
    retry: false,
  });
  const authActive = !!draft.auth?.type && draft.auth.type !== 'none';

  return (
    <section className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (sharedOAuth2Selected && !oauth2CredentialFormValid(oauth2)) return;
          save.mutate();
        }}
      >
        <div className="space-y-5">
          <ConnectorConfigFields
            draft={draft}
            onChange={setDraft}
            slugEditable
            emailChannelEnabled={emailChannelEnabled}
            detectedAuth={
              discovery.data?.recommended
                ? {
                    type: discovery.data.recommended.type,
                    parameterName: discovery.data.candidates[0]?.parameterName ?? null,
                  }
                : null
            }
            detectedTitle={discovery.data?.title ?? null}
            oauth2Selected={sharedOAuth2Selected}
            onOAuth2SelectedChange={
              effectiveAuthorizationStrategy === 'project' ? setOauth2Selected : undefined
            }
          />
          <AuthorizationStrategyField
            idPrefix="custom-connector"
            value={connectorAuthorizationStrategyForProvider(
              draft.provider,
              draft.authorization_strategy ?? 'project',
            )}
            onChange={(authorizationStrategy) =>
              setDraft({ ...draft, authorization_strategy: authorizationStrategy })
            }
            disabled={!connectorAuthorizationStrategyIsEditable(draft.provider)}
          />
          {sharedOAuth2Selected && (
            <div className="space-y-4">
              <InfoBanner tone="info" title="OAuth 2.0 client credentials">
                Kortix requests a token before saving. It encrypts the configuration and refreshes
                the access token before expiry.
              </InfoBanner>
              <OAuth2CredentialFields
                value={oauth2}
                onChange={setOauth2}
                idPrefix="new-connector-oauth2"
              />
            </div>
          )}
          {effectiveAuthorizationStrategy === 'user' && authActive && (
            <InfoBanner tone="info">
              Add the connector first. Each user then stores their own private credential
              from the connector page.
            </InfoBanner>
          )}
          {draft.auth === undefined && discovery.isFetching && (
            <InfoBanner tone="info">Checking the source for authentication settings…</InfoBanner>
          )}
          {draft.auth === undefined && discovery.data?.status === 'none' && (
            <InfoBanner tone="neutral">The source does not advertise authentication.</InfoBanner>
          )}
          {draft.auth === undefined && discovery.data?.status === 'unsupported' && (
            <InfoBanner tone="warning">
              The source advertises authentication Kortix cannot inject yet. Choose a manual
              override or None.
            </InfoBanner>
          )}
          {draft.auth === undefined && discovery.error && (
            <InfoBanner tone="warning">
              Could not inspect authentication: {(discovery.error as Error).message}
            </InfoBanner>
          )}
          {authActive && !sharedOAuth2Selected && effectiveAuthorizationStrategy === 'project' && (
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
              disabled={
                !draft.slug ||
                save.isPending ||
                !connectionValid(draft, emailChannelEnabled) ||
                (sharedOAuth2Selected && !oauth2CredentialFormValid(oauth2))
              }
              className="gap-1.5"
            >
              {save.isPending && <Loading className="size-4 shrink-0" />}
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

export function SetCredentialModal({
  projectId,
  connector,
  connectionId,
  authorizationStrategy,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  connector: AdminConnector | null;
  connectionId: string | null;
  authorizationStrategy: ConnectorAuthorizationStrategy;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [credentialType, setCredentialType] = useState<'static' | 'oauth2'>('static');
  const [value, setValue] = useState('');
  const [oauth2, setOauth2] = useState<OAuth2CredentialForm>(EMPTY_OAUTH2_CREDENTIAL_FORM);
  const [application, setApplication] = useState<OAuth2ApplicationForm>(
    EMPTY_OAUTH2_APPLICATION_FORM,
  );
  const configQuery = useQuery({
    queryKey: qk.project.connectorConfig(projectId, connector?.slug ?? ''),
    queryFn: () => getConnectorConfig(projectId, connector!.slug),
    enabled: open && Boolean(connector) && authorizationStrategy === 'project',
    ...contract('config'),
  });
  const requestAuth =
    authorizationStrategy === 'user' ? connector?.requestAuthType : configQuery.data?.auth.type;
  const objectCredential = ['oauth1', 'hmac', 'aws_sigv4', 'mtls'].includes(requestAuth ?? '');
  const credentialExample =
    requestAuth === 'oauth1'
      ? '{"consumer_key":"","consumer_secret":"","token":"","token_secret":""}'
      : requestAuth === 'hmac'
        ? '{"secret":"","key_id":""}'
        : requestAuth === 'aws_sigv4'
          ? '{"access_key_id":"","secret_access_key":"","region":"","service":"","session_token":""}'
          : requestAuth === 'mtls'
            ? '{"certificate":"-----BEGIN CERTIFICATE-----\\n...","private_key":"-----BEGIN PRIVATE KEY-----\\n...","ca":""}'
            : '••••••••';
  const staticValid = (() => {
    if (!value) return false;
    if (!objectCredential) return true;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const hasStrings = (...keys: string[]) =>
        keys.every((key) => typeof parsed[key] === 'string' && Boolean(parsed[key]));
      if (requestAuth === 'oauth1') {
        return hasStrings('consumer_key', 'consumer_secret', 'token', 'token_secret');
      }
      if (requestAuth === 'hmac') return hasStrings('secret');
      if (requestAuth === 'aws_sigv4') {
        return hasStrings('access_key_id', 'secret_access_key', 'region', 'service');
      }
      if (requestAuth === 'mtls') return hasStrings('certificate', 'private_key');
      return false;
    } catch {
      return false;
    }
  })();
  const [device, setDevice] = useState<OAuth2DeviceAuthorizationStartResult | null>(null);
  const [deviceConnectionId, setDeviceConnectionId] = useState<string | null>(null);
  const oauth2Valid =
    application.grant === 'client_credentials'
      ? oauth2CredentialFormValid(oauth2)
      : oauth2ApplicationFormValid(application);
  useEffect(() => {
    if (!device || !deviceConnectionId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const status = await pollConnectionOAuth2DeviceAuthorization(
          projectId,
          deviceConnectionId,
          device.session_id,
        );
        if (stopped || status.status === 'pending') return;
        stopped = true;
        if (status.status === 'active') {
          successToast('OAuth 2.0 device connection completed');
          onSaved();
          onOpenChange(false);
        } else {
          errorToast(status.error_code || 'OAuth 2.0 device connection failed');
        }
      } catch (error) {
        if (!stopped) errorToast(error instanceof Error ? error.message : 'Device polling failed');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), device.interval_seconds * 1000);
    const expiryTimer = window.setTimeout(
      () => {
        stopped = true;
        errorToast('The device authorization code expired');
      },
      Math.max(0, new Date(device.expires_at).getTime() - Date.now()),
    );
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(expiryTimer);
    };
  }, [device, deviceConnectionId, onOpenChange, onSaved, projectId]);
  const resolveConnectionId = async (): Promise<string> => {
    if (connectionId) return connectionId;
    if (authorizationStrategy === 'user') {
      const connection = await reconcileMemberConnection(projectId, {
        connector_alias: connector!.slug,
        label: connector!.name.trim() || connector!.slug,
      });
      return connection.connection_id;
    }
    return (await ensureProjectConnectorConnection(projectId, connector!.slug)).connection_id;
  };
  const save = useMutation({
    mutationFn: async () => {
      if (credentialType === 'static') {
        if (authorizationStrategy === 'user') {
          return updateConnectionCredential(projectId, await resolveConnectionId(), {
            value,
          });
        }
        return setConnectorCredential(projectId, connector!.slug, value);
      }
      if (application.grant === 'client_credentials') {
        const oauth2Input = buildOAuth2CredentialInput(oauth2);
        if (authorizationStrategy === 'user') {
          return updateConnectionCredential(
            projectId,
            await resolveConnectionId(),
            oauth2Input,
          );
        }
        return setConnectorCredential(projectId, connector!.slug, oauth2Input);
      }
      const activeConnectionId = await resolveConnectionId();
      const resolvedApplication = application.discoveryUrl
        ? mergeOAuth2DiscoveryMetadata(
            application,
            (
              await discoverConnectionOAuth2(projectId, activeConnectionId, {
                discovery_url: application.discoveryUrl,
              })
            ).metadata,
          )
        : application;
      await putConnectionOAuth2Application(
        projectId,
        activeConnectionId,
        buildOAuth2ApplicationInput(resolvedApplication),
      );
      const scopes = resolvedApplication.scopes.split(/\s+/).filter(Boolean);
      if (application.grant === 'authorization_code') {
        const redirect = new URL(window.location.href);
        redirect.searchParams.delete('oauth2');
        redirect.searchParams.delete('oauth2_error');
        const result = await startConnectionOAuth2Authorization(projectId, activeConnectionId, {
          scopes: scopes.length ? scopes : undefined,
          success_redirect_uri: redirect.toString(),
          error_redirect_uri: redirect.toString(),
        });
        window.location.assign(result.authorization_url);
        return result;
      }
      const result = await startConnectionOAuth2DeviceAuthorization(
        projectId,
        activeConnectionId,
        {
          scopes: scopes.length ? scopes : undefined,
        },
      );
      setDeviceConnectionId(activeConnectionId);
      setDevice(result);
      return result;
    },
    onSuccess: () => {
      if (credentialType === 'oauth2' && application.grant !== 'client_credentials') return;
      successToast(credentialType === 'oauth2' ? 'OAuth 2.0 connection saved' : 'Credential saved');
      setValue('');
      setOauth2(EMPTY_OAUTH2_CREDENTIAL_FORM);
      setApplication(EMPTY_OAUTH2_APPLICATION_FORM);
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
      <ModalContent className="lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextSetCredential5e9704a8',
            )}
            {connector?.slug}
          </ModalTitle>
          <ModalDescription>
            Kortix encrypts credentials and applies the selected authentication strategy to upstream
            requests.
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              (credentialType === 'static' && staticValid) ||
              (credentialType === 'oauth2' && oauth2Valid)
            ) {
              save.mutate();
            }
          }}
        >
          <ModalBody>
            <Tabs
              value={credentialType}
              onValueChange={(next) => setCredentialType(next as 'static' | 'oauth2')}
              className="gap-4"
            >
              <TabsList>
                <TabsTrigger value="static">Static credential</TabsTrigger>
                <TabsTrigger value="oauth2">OAuth 2.0</TabsTrigger>
              </TabsList>
              <TabsContent value="static">
                <Field>
                  <FieldLabel htmlFor="connector-static-credential">
                    {objectCredential ? 'Credential JSON' : 'Value'}
                  </FieldLabel>
                  {objectCredential ? (
                    <Textarea
                      id="connector-static-credential"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={credentialExample}
                      className="min-h-28 font-mono text-xs"
                      autoFocus
                    />
                  ) : (
                    <Input
                      id="connector-static-credential"
                      type="password"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={credentialExample}
                      className="font-mono"
                      autoFocus
                    />
                  )}
                  {objectCredential && (
                    <FieldDescription>
                      The selected {requestAuth} strategy requires one encrypted JSON object.
                    </FieldDescription>
                  )}
                </Field>
              </TabsContent>
              <TabsContent value="oauth2" className="space-y-4">
                <InfoBanner tone="info">
                  Kortix stores the application configuration, rotates refresh tokens, and revokes
                  the connection when you disconnect it.
                </InfoBanner>
                <Field>
                  <FieldLabel htmlFor="connector-oauth2-grant">Grant</FieldLabel>
                  <Select
                    value={application.grant}
                    onValueChange={(grant) => {
                      setDevice(null);
                      setApplication({
                        ...application,
                        grant: grant as OAuth2ApplicationForm['grant'],
                      });
                    }}
                  >
                    <SelectTrigger id="connector-oauth2-grant">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="client_credentials">Client Credentials</SelectItem>
                      <SelectItem value="authorization_code">
                        Authorization Code with PKCE
                      </SelectItem>
                      <SelectItem value="device_authorization">Device Authorization</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {application.grant === 'client_credentials' ? (
                  <OAuth2CredentialFields
                    value={oauth2}
                    onChange={setOauth2}
                    idPrefix="connector-oauth2"
                  />
                ) : (
                  <OAuth2ApplicationFields
                    value={application}
                    onChange={setApplication}
                    idPrefix="connector-oauth2-application"
                  />
                )}
                {device && (
                  <InfoBanner
                    tone="neutral"
                    title={`Enter code ${device.user_code}`}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          window.open(
                            device.verification_uri_complete ?? device.verification_uri,
                            '_blank',
                            'noopener,noreferrer',
                          )
                        }
                      >
                        <ExternalLink className="size-4" />
                        Open verification page
                      </Button>
                    }
                  >
                    Kortix checks the connection every {device.interval_seconds} seconds until{' '}
                    {new Date(device.expires_at).toLocaleTimeString()}.
                  </InfoBanner>
                )}
              </TabsContent>
            </Tabs>
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
            <Button
              type="submit"
              size="sm"
              disabled={
                save.isPending || (credentialType === 'static' ? !staticValid : !oauth2Valid)
              }
              className="gap-1.5"
            >
              {save.isPending && <Loading className="size-4 shrink-0" />}
              {credentialType === 'oauth2' && application.grant === 'authorization_code'
                ? 'Continue to provider'
                : credentialType === 'oauth2' && application.grant === 'device_authorization'
                  ? 'Get device code'
                  : 'Save'}
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
