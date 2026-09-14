'use client';

import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
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
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { usePipedreamConnectMember } from '@/hooks/connectors/use-pipedream-connect-member';
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';
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
  discoverConnectionOAuth2Resource,
  discoverConnectorAuth,
  ensureProjectConnectorConnection,
  getConnectorConfig,
  getConnectorPolicies,
  getConnectStatus,
  listAllConnections,
  listConnections,
  listConnectors,
  listPipedreamApps,
  listProjectAccess,
  type OAuth2DeviceAuthorizationStartResult,
  pollConnectionOAuth2DeviceAuthorization,
  putConnectionOAuth2Application,
  reconcileMemberConnection,
  registerConnectionOAuth2Client,
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
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import {
  buildEasyConnectConnectorDraft,
  buildEmailConnectorConnectionSlug,
  connectionOwnerTypeForStrategy,
  connectorAuthorizationStrategyForProvider,
  connectorAuthorizationStrategyIsEditable,
  connectorAuthorizationUpdateIsPending,
  connectorConnectionQueryKeys,
  connectorSetupStatus,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  type EasyConnectApp,
  proposeConnectorConnectionSlug,
} from './connector-connection-form';
import { AuthorizationStrategyField, ConnectorConnectionModal } from './connector-connection-modal';
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
import {
  autoConnectPlan,
  buildClientRegistrationInput,
  mergeResourceDiscoveryIntoForm,
} from './connector-oauth2-auto';
import { OAuth2CredentialFields } from './connector-oauth2-fields';
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
import {
  composioConnectionIsAuthorized,
  isManagedConnectorProvider,
  providerLabel,
} from '@/features/workspace/capabilities/connectors/provider-label';
import { usePipedreamConnect } from '@/hooks/connectors/use-pipedream-connect-app';
import { useCopy } from '@/hooks/use-copy';

const RISK_VARIANT: Record<ConnectorAction['risk'], 'outline' | 'secondary' | 'destructive'> = {
  read: 'outline',
  write: 'secondary',
  destructive: 'destructive',
};

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);
const SLACK_ICON_SRC = 'https://www.google.com/s2/favicons?domain=slack.com&sz=128';

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
  const connectionQueryKeys = useMemo(() => connectorConnectionQueryKeys(projectId), [projectId]);
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
  const connectors = useMemo(() => query.data?.connectors ?? [], [query.data]);
  // One gating primitive. `useFeatureFlag` fetches the same
  // `qk.project.detail(projectId)` entry the hand-rolled query here used to,
  // with the same `=== true` fail-closed read.
  const emailChannelEnabled = useFeatureFlag(projectId, 'agentmail_email').enabled;
  const discoverEnabled = useFeatureFlag(projectId, 'connectors_api_discover').enabled;
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
    if (oauth2Result === 'connected')
      successToast(tI18nHardcoded.raw('i18nComplete.text5738301b7beb'));
    else errorToast(oauth2Error || tI18nHardcoded.raw('i18nComplete.texta6fac795d6d6'));
    for (const affectedQueryKey of connectionQueryKeys) {
      void queryClient.invalidateQueries({ queryKey: affectedQueryKey });
    }
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete('oauth2');
    params.delete('oauth2_error');
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  }, [
    connectionQueryKeys,
    oauth2Error,
    oauth2Result,
    pathname,
    queryClient,
    router,
    search,
    tI18nHardcoded,
  ]);
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
        warningToast(
          tI18nHardcoded('i18nComplete.text01e458a231aa', {
            value0: res.synced,
            value1: res.errors.length,
          }),
        );
      else successToast(tI18nHardcoded('i18nComplete.textf6a7db3563d0', { value0: res.synced }));
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.textabf3e80b5b4c')),
  });

  if (query.isLoading) return <MasterDetailSkeleton />;
  if (isForbidden) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-8">
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
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <InfoBanner
          tone="destructive"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxAttrTitleFailed959d47d5',
          )}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              {tI18nHardcoded.raw('i18nComplete.text942087cc2d41')}
            </Button>
          }
        >
          {(query.error as Error)?.message ?? tI18nHardcoded.raw('i18nComplete.text27c2ccd962c2')}
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
          {tI18nHardcoded.raw('i18nComplete.textdaee7606b339')}
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
      aria-label={tI18nHardcoded.raw('i18nComplete.textc3d2e79ebdd0')}
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
            {ready.length > 0 && (
              <RailGroupLabel>{tI18nHardcoded.raw('i18nComplete.texte674447337e8')}</RailGroupLabel>
            )}
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
  return <div className="text-muted-foreground px-3 pt-3 pb-1 text-xs font-medium">{children}</div>;
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
        'border-border/60 bg-card flex w-full overflow-x-auto rounded-md border',
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isProjectAuthorization = connection.owner_type === 'project';
  const active = connection.status === 'active';
  // Only the owner of a connection may change it: your own personal connection,
  // or, for a project authorization, a project manager.
  const mayMutate = isProjectAuthorization ? canManage : isMine;

  const { copy } = useCopy({ successMessage: tI18nComplete.raw('text56ee71f3ece0') });

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
              {tI18nComplete.raw('text21b111cbfe6e')}
            </Badge>
          )}
        </div>
        <InlineMeta>
          {isProjectAuthorization
            ? tI18nComplete.raw('text1c22fac2a9fd')
            : tI18nComplete.raw('text1e1353702c42')}
          {active ? null : connection.status === 'revoked' ? 'Disconnected' : 'Error'}
          {/* Every connection carries its own id — this is what a backend passes
              in connector_bindings to run as THIS account. Truncated to keep the
              row readable; the row menu copies the full value. */}
          <Hint label={tI18nComplete.raw('text48d73db2396c')}>
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
            aria-label={tI18nComplete('text33da220b1a34', { value0: connection.label })}
            disabled={pending || disabled}
          >
            {pending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <DotsThreeIcon className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={() => copy(connection.connection_id)}>
            {tI18nComplete.raw('text99775327d988')}
          </DropdownMenuItem>
          {mayMutate && isMine && active && onStartSession && (
            <DropdownMenuItem onClick={onStartSession}>
              {tI18nComplete.raw('textfae237eed0c5')}
            </DropdownMenuItem>
          )}
          {mayMutate && !connection.is_default && active && (
            <DropdownMenuItem onClick={onSetDefault}>
              {tI18nComplete.raw('texta92f66fd3d83')}
              {isProjectAuthorization ? tI18nComplete.raw('text801a345cd406') : ''}
            </DropdownMenuItem>
          )}
          {mayMutate && (
            <DropdownMenuItem onClick={onDisconnect}>
              {tI18nComplete.raw('textacfc5be785a9')}
            </DropdownMenuItem>
          )}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text109ff88aec78'));
      refresh();
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('texta2cf78785484')),
  });
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => revokeConnection(projectId, connectionId),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text04dfac3671b4'));
      setConfirmDisconnect(null);
      refresh();
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('textb7668a581f59')),
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
        <Label>{tI18nComplete.raw('textdc273117482b')}</Label>
        <div className="flex items-center gap-2">
          {connectionOwnerType === 'project' && canManageConnections && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAddScope('project')}
              disabled={disabled}
            >
              <Plus className="size-4" />
              {tI18nComplete.raw('text9ba9dd084952')}
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
              {tI18nComplete.raw('textcbf6389cf9df')}
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
          title={tI18nComplete('textee168539f43a', { value0: displayName })}
          description={
            connectionOwnerType === 'project'
              ? tI18nComplete.raw('texte6e0b4594c95')
              : tI18nComplete.raw('text6533f1aa30ab')
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
                ? tI18nComplete('textca04bb211a4b', { value0: displayName })
                : tI18nComplete('text9819d9aeec29', { value0: displayName })}
            </ModalTitle>
            <ModalDescription>
              {addScope === 'project'
                ? tI18nComplete.raw('textcfc47949d9f8')
                : tI18nComplete.raw('textf43ce58ed44c')}
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
                <FieldLabel htmlFor="connection-label">
                  {tI18nComplete.raw('textdcd1d5223f73')}
                </FieldLabel>
                <Input
                  id="connection-label"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  placeholder={
                    addScope === 'project' ? tI18nComplete.raw('text945ce03ec79f') : 'Work'
                  }
                  maxLength={255}
                  autoFocus
                  disabled={adding || disabled}
                />
                <FieldDescription>{tI18nComplete.raw('text99953938d987')}</FieldDescription>
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
                {tI18nComplete.raw('text19766ed6ccb2')}
              </Button>
              <Button type="submit" disabled={adding || disabled || !labelDraft.trim()}>
                {adding ? <Loading className="size-4 shrink-0" /> : null}
                {tI18nComplete.raw('text31fbef162594')}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={confirmDisconnect !== null}
        onOpenChange={(open) => !open && setConfirmDisconnect(null)}
        title={tI18nComplete('text13716a578591', { value0: confirmDisconnect?.label ?? '' })}
        description={
          confirmDisconnect?.owner_type === 'project'
            ? tI18nComplete.raw('texte2cbafcec553')
            : tI18nComplete.raw('text64db32d83da9')
        }
        confirmLabel={tI18nComplete.raw('textacfc5be785a9')}
        confirmVariant="destructive"
        isPending={disconnect.isPending}
        onConfirm={() => confirmDisconnect && disconnect.mutate(confirmDisconnect.connection_id)}
      />
    </section>
  );
}

function RosterStatusBadge({ status }: { status: 'active' | 'revoked' | 'error' }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (status === 'active') {
    return (
      <Badge variant="outline" size="sm" className="text-kortix-green">
        {tI18nComplete.raw('text22965568d22a')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        {tI18nComplete.raw('texta2d64eeafcb9')} {displayName}{' '}
        {tI18nComplete.raw('text1e5fac867454')}
      </div>
      {connectionsQuery.isLoading ? (
        <div className="text-muted-foreground px-4 py-3 text-sm">
          {tI18nComplete.raw('textba3bbbe10d8b')}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground px-4 py-3 text-sm">
          {tI18nComplete.raw('text56e264eb39f6')} {displayName}{' '}
          {tI18nComplete.raw('textf55f49c47f7f')}
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
                  tI18nComplete.raw('text29824c5acaf8')}
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
  const isManagedProvider = isManagedConnectorProvider(connector.provider);
  const isChannel = connector.provider === 'channel';
  // A computer profile has no generic credential or connection form. Its
  // project-scoped tool policy remains editable here like every other connector.
  const isComputer = connector.provider === 'computer';
  const isManaged = isComputer;
  const authorizationStrategyEditable = connectorAuthorizationStrategyIsEditable(
    connector.provider,
  );
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
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
  const selectedConnection = usesProjectAuthorization ? connection : myPrivateConnection;
  const connected =
    connector.provider === 'composio'
      ? composioConnectionIsAuthorized(selectedConnection?.metadata)
      : usesProjectAuthorization && connector.secretSet;
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
  const showConnections = isManagedProvider && !isChannel && !isComputer;
  const showConnectionTab = canWrite && !isManagedProvider && !isManaged;
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
      successToast(tI18nHardcoded.raw('i18nComplete.text05487af3f074'));
      setEditingName(false);
      onChanged();
    },
    onError: (e: Error) =>
      errorToast(e.message || tI18nHardcoded.raw('i18nComplete.text8fcf8ce07dcf')),
  });

  const updateAuthorizationStrategy = useMutation({
    mutationFn: (next: ConnectorAuthorizationStrategy) =>
      setConnectorAuthorizationStrategy(projectId, connector.slug, next),
    onSuccess: (result, next) => {
      const syncError = result.sync?.errors.find((error) => error.slug === connector.slug);
      if (syncError) {
        warningToast(tI18nHardcoded('i18nComplete.textec7a4e3094f9', { value0: syncError.error }));
        onChanged();
        return;
      }
      successToast(
        tI18nHardcoded('i18nComplete.text67ccb61d5f27', {
          value0:
            next === tI18nHardcoded.raw('i18nComplete.text244210e48437')
              ? tI18nHardcoded.raw('i18nComplete.text985959785319')
              : tI18nHardcoded.raw('i18nComplete.textb512d97e7cbf'),
        }),
      );
      onChanged();
    },
    onError: (error: Error) => {
      setAuthorizationStrategyAwaitingRefresh(null);
      errorToast(error.message || tI18nHardcoded.raw('i18nComplete.texta743aa4452d3'));
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
      successToast(tI18nHardcoded('i18nComplete.textffd34ade9168', { value0: displayName }));
      onRemoved();
    },
    onError: (e: Error) =>
      errorToast(e.message || tI18nHardcoded.raw('i18nComplete.text1d0486014da5')),
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
                {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
              </Button>
            </form>
          ) : (
            <div className="group flex items-center gap-2">
              <h2 className="text-foreground truncate text-lg font-semibold">{displayName}</h2>
              {canWrite && (
                <Hint label={tI18nHardcoded.raw('i18nComplete.text3064d79a295c')}>
                  <button
                    type="button"
                    onClick={() => !strategyUpdating && setEditingName(true)}
                    disabled={strategyUpdating}
                    aria-label={tI18nHardcoded.raw('i18nComplete.text3064d79a295c')}
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
          (isManagedProvider || connector.authSecret) &&
          connected &&
          !isChannel &&
          usesProjectAuthorization &&
          (isManagedProvider ? (
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
              {tI18nHardcoded.raw('i18nComplete.textbf8a9eab9e7e')}
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
              {tI18nHardcoded.raw('i18nComplete.text54483ce856e0')}
            </Button>
          ))}
      </div>

      <div className="mt-7 space-y-5">
        <section className="space-y-2">
          <Label>{tI18nHardcoded.raw('i18nComplete.textca5839e38a15')}</Label>
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
              lockedReason={tI18nHardcoded.raw('i18nComplete.text70e7dfb50669')}
              pending={strategyUpdating}
            />
          </div>
        </section>
        {/* Project-owned connectors accept only project-managed connections. */}
        {(isManagedProvider || connector.authSecret) &&
          !connected &&
          !isChannel &&
          usesProjectAuthorization && (
            <InfoBanner
              tone="info"
              icon={Users}
              title={tI18nHardcoded('i18nComplete.textbe90d607b9d7', { value0: displayName })}
              action={
                canWrite ? (
                  <Button
                    size="lg"
                    className="h-11 shrink-0 gap-2 px-5 font-semibold"
                    onClick={() => (isManagedProvider ? reconnect.mutate() : setCredOpen(true))}
                    disabled={strategyUpdating || (isManagedProvider && reconnect.isPending)}
                  >
                    {isManagedProvider && reconnect.isPending && (
                      <Loading className="size-4 shrink-0" />
                    )}
                    {isManagedProvider
                      ? tI18nHardcoded.raw('i18nComplete.text4f8632819544')
                      : tI18nHardcoded.raw('i18nComplete.text65a59547b132')}
                  </Button>
                ) : undefined
              }
            >
              {isManagedProvider
                ? tI18nHardcoded('i18nComplete.text877733202b1b', { value0: displayName })
                : tI18nHardcoded.raw('i18nComplete.textd460f97920a4')}
            </InfoBanner>
          )}
        {connector.authSecret &&
          !isManagedProvider &&
          !isChannel &&
          !isComputer &&
          !usesProjectAuthorization && (
            <InfoBanner
              tone="info"
              icon={Lock}
              title={tI18nHardcoded('i18nComplete.text5fe5c81da268', { value0: displayName })}
              action={
                <Button
                  size="lg"
                  className="h-11 shrink-0 gap-2 px-5 font-semibold"
                  onClick={() => setCredOpen(true)}
                  disabled={strategyUpdating}
                >
                  <KeyRound className="size-4 shrink-0" />
                  {tI18nHardcoded.raw('i18nComplete.text3a8f214698ec')}
                </Button>
              }
            >
              {tI18nHardcoded.raw('i18nComplete.textc50fbc7b7acc')}
            </InfoBanner>
          )}
        {/* One tab per question this page answers: what can I use (Connections),
            what may the agent do with it (Permissions), which project members
            connected their own (Project members). Before this, everything stacked
            into one long scroll above a lone "Permissions" tab, because the only
            other trigger — Connection — is hidden for Pipedream connectors. */}
        {detailTabCount > 0 && (
          <Tabs value={detailTab} onValueChange={setDetailTab} className="gap-3">
            {/* A single trigger is not a choice — it reads as a broken tab bar. */}
            <TabsList
              type="underline"
              className={cn(
                'flex w-full items-center justify-start',
                detailTabCount < 2 && 'hidden',
              )}
            >
              {showConnections && (
                <TabsTrigger value="connections" className="w-fit flex-none gap-2">
                  {tI18nHardcoded.raw('i18nComplete.textdc273117482b')}
                  {connectionCount > 0 ? (
                    <Badge variant="secondary" size="sm">
                      {connectionCount}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              )}
              {showConnectionTab && (
                <TabsTrigger value="connection" className="w-fit flex-none">
                  {tI18nHardcoded.raw('i18nComplete.text639a40e82b9a')}
                </TabsTrigger>
              )}
              {showPermissions && (
                <TabsTrigger value="permissions" className="w-fit flex-none">
                  {tI18nHardcoded.raw('i18nComplete.textabccc78cc93c')}
                </TabsTrigger>
              )}
              {showRoster && (
                <TabsTrigger value="roster" className="w-fit flex-none">
                  {tI18nHardcoded.raw('i18nComplete.text96f64f836aa3')}
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
                      isManagedProvider || !usesProjectAuthorization
                        ? undefined
                        : () => setCredOpen(true)
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
                {tI18nHardcoded.raw('i18nComplete.textc3812fc4acb8')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tI18nHardcoded('i18nComplete.textbc43ab815937', { value0: displayName })}
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

/** Which connection UI a channel connector shows. */
type ChannelConnectionPlatform = ChannelPlatform;

function connectorPlatform(connector: AdminConnector): ChannelConnectionPlatform | null {
  if (connector.platform === 'slack' || connector.platform === 'email') {
    return connector.platform;
  }
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  return (
    <section className="space-y-4">
      <Label>{tI18nComplete.raw('text639a40e82b9a')}</Label>
      <div className="bg-popover rounded-md border px-4 py-3">
        <InfoBanner tone="warning">{tI18nComplete.raw('text53f76274b923')}</InfoBanner>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const install = useEmailInstall(projectId, connector.slug);

  return (
    <section className="space-y-4">
      <Label>{tI18nComplete.raw('text7033ce3d1e7a')}</Label>
      <p className="text-muted-foreground -mt-2 text-xs">{tI18nComplete.raw('text28d1c949e5e6')}</p>
      <div className="bg-popover rounded-md border px-4 py-3">
        {install.isLoading ? (
          <Skeleton className="h-24 w-full rounded-md" />
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
          <InfoBanner tone="neutral" icon={Mail} title={tI18nComplete.raw('textf0aea4d97b8e')}>
            {tI18nComplete.raw('text2dec6c273b47')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const disconnect = useDisconnectEmail();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <InfoBanner tone="success" icon={Check} title={tI18nComplete.raw('textc23cc1f72afe')}>
        {tI18nComplete.raw('text56ef8f20955f')}{' '}
        <code className="font-mono">{installation.email}</code>
        {' · '}
        {tI18nComplete.raw('text94835ea2fcf7')}{' '}
        <code className="font-mono">{installation.inboxId}</code>
        {installation.webhookId ? (
          <>
            {' · '}
            {tI18nComplete.raw('text4814f62c108d')}{' '}
            <code className="font-mono">{installation.webhookId}</code>
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
                {tI18nComplete.raw('text2a528ae2d4ae')}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {tI18nComplete.raw('text19766ed6ccb2')}
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
                {tI18nComplete.raw('textacfc5be785a9')}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              {tI18nComplete.raw('textacfc5be785a9')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const update = useUpdateEmailPolicy();
  const initial = normalizeEmailSenderPolicy(policy);
  const [restricted, setRestricted] = useState(initial.mode === 'restricted');
  const [emails, setEmails] = useState(() => initial.allowedEmails.join('\n'));
  const [domains, setDomains] = useState(() => initial.allowedDomains.join('\n'));
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
    <div className="border-border/60 bg-card rounded-md border p-4">
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
            <Label htmlFor="email-sender-restricted">{tI18nComplete.raw('texta48c89f63885')}</Label>
            <p className="text-muted-foreground mt-1 text-xs">
              {tI18nComplete.raw('text8c67b476d59b')}
            </p>
          </div>
          {restricted ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <Input
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder={tI18nComplete.raw('text542d24012988')}
                  disabled={!canWrite}
                />
              </Field>
              <Field>
                <Input
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder={tI18nComplete.raw('texta379a6f6eeaf')}
                  disabled={!canWrite}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field>
                  <Input
                    value={regex}
                    onChange={(e) => setRegex(e.target.value)}
                    placeholder={tI18nComplete.raw('text8b21058f3253')}
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
              label={tI18nComplete.raw('text57ee14ce1425')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        title={
          managedAvailable
            ? tI18nComplete.raw('texte654b63c8098')
            : tI18nComplete.raw('textafe9444782eb')
        }
      >
        {managedAvailable
          ? tI18nComplete.raw('textec9ace8d8ff6')
          : tI18nComplete.raw('text608977655d2d')}
      </InfoBanner>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <Input
            id="email-channel-display-name"
            name="email-channel-display-name"
            aria-label={tI18nComplete.raw('textf912567c97f2')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={tI18nComplete.raw('text952144fe1418')}
          />
        </Field>
        {attachExisting ? (
          <Field>
            <FieldLabel htmlFor="email-channel-existing-email">
              {tI18nComplete.raw('text2fcfd290b610')}
            </FieldLabel>
            <Input
              id="email-channel-existing-email"
              name="email-channel-existing-email"
              aria-label={tI18nComplete.raw('textaa042b472947')}
              value={existingEmail}
              onChange={(e) => setExistingEmail(e.target.value.trim().toLowerCase())}
              placeholder={tI18nComplete.raw('textbca888f9f9fd')}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ) : (
          <Field>
            <Input
              id="email-channel-username"
              name="email-channel-username"
              aria-label={tI18nComplete.raw('textcbf297bfb5e6')}
              value={username}
              onChange={(e) =>
                setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
              }
              placeholder={tI18nComplete.raw('texta18603086e5b')}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {tI18nComplete.raw('textf0a216500b54')} {username || 'support'}
              {tI18nComplete.raw('text39e4dae21daa')}
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
              <Label htmlFor="email-channel-existing-inbox">
                {tI18nComplete.raw('textd7cc97510eb3')}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">
                {tI18nComplete.raw('text3bb2e4fa1c03')}
              </p>
            </div>
            {attachExisting ? (
              <Field>
                <FieldLabel htmlFor="email-channel-existing-inbox-id">
                  {tI18nComplete.raw('texta35f4f3f0587')}
                </FieldLabel>
                <Input
                  id="email-channel-existing-inbox-id"
                  name="email-channel-existing-inbox-id"
                  aria-label={tI18nComplete.raw('textdc5376ca47b4')}
                  value={existingInboxId}
                  onChange={(e) => setExistingInboxId(e.target.value.trim())}
                  placeholder={tI18nComplete.raw('textbca888f9f9fd')}
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
          {tI18nComplete.raw('text1bb320d9db5d')}
        </Button>
        {customKeyOpen ? (
          <Field>
            <Input
              id="email-channel-agentmail-api-key"
              name="email-channel-agentmail-api-key"
              aria-label={tI18nComplete.raw('text87b0e5101fd8')}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={tI18nComplete.raw('text3ce8275b54eb')}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text0ec2e7ccbd17')}</p>
          </Field>
        ) : null}
      </div>
      <div className="border-border/60 bg-card rounded-md border p-4">
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
                {tI18nComplete.raw('textb1fb183269ba')}
              </Label>
              <p className="text-muted-foreground mt-1 text-xs">
                {tI18nComplete.raw('text5284184cef68')}
              </p>
            </div>
            {restricted ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <Input
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    placeholder={tI18nComplete.raw('text542d24012988')}
                    spellCheck={false}
                  />
                </Field>
                <Field>
                  <Input
                    value={domains}
                    onChange={(e) => setDomains(e.target.value)}
                    placeholder={tI18nComplete.raw('texta379a6f6eeaf')}
                    spellCheck={false}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field>
                    <Input
                      value={regex}
                      onChange={(e) => setRegex(e.target.value)}
                      placeholder={tI18nComplete.raw('text8b21058f3253')}
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
          {tI18nComplete.raw('text72d9ee78a15c')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const install = useSlackInstall(projectId);
  return (
    <section className="space-y-4">
      <Label>{tI18nComplete.raw('text51b3bfca2e8c')}</Label>
      <p className="text-muted-foreground -mt-2 text-xs">{tI18nComplete.raw('textff5091ba4fe1')}</p>
      <div className="bg-popover rounded-md border px-4 py-3">
        {install.isLoading ? (
          <Skeleton className="h-24 w-full rounded-md" />
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
          <InfoBanner
            tone="neutral"
            icon={<SlackLogo />}
            title={tI18nComplete.raw('textb36d622566f6')}
          >
            {tI18nComplete.raw('text98d27bdc2fa7')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-4">
      <InfoBanner tone="success" icon={Check} title={tI18nComplete.raw('text4fce550efde4')}>
        {tI18nComplete.raw('text87bb59ba2f92')}{' '}
        <code className="font-mono">{installation.workspaceName || installation.workspaceId}</code>
      </InfoBanner>
      {canWrite && (
        <div className="flex items-center justify-end gap-2">
          {confirming ? (
            <>
              <span className="text-muted-foreground mr-auto text-xs">
                {tI18nComplete.raw('text73b407259d54')}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {tI18nComplete.raw('text19766ed6ccb2')}
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
                {tI18nComplete.raw('textacfc5be785a9')}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              {tI18nComplete.raw('textacfc5be785a9')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text1f1228d5e972'));
      setTimeout(() => setCopiedManifest(false), 1500);
    } catch {
      errorToast(tI18nComplete.raw('text1801bed8cea5'));
    }
  };

  return (
    <div className="space-y-4">
      {!customOnly &&
        (mode.isLoading ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : installUrl ? (
          <InfoBanner
            tone="info"
            icon={<SlackLogo />}
            title={tI18nComplete.raw('text0e671041e03f')}
            action={
              <Button size="sm" className="shrink-0 gap-1.5" asChild>
                <a href={installUrl}>
                  {tI18nComplete.raw('text3357cd3d0cee')}
                  <ChevronRight className="h-4 w-4" />
                </a>
              </Button>
            }
          >
            {tI18nComplete.raw('text8b3305c40176')}
          </InfoBanner>
        ) : (
          <InfoBanner
            tone="warning"
            icon={<SlackLogo />}
            title={tI18nComplete.raw('text36e7df856716')}
          >
            {tI18nComplete.raw('text51e0d22747d7')}
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
            {tI18nComplete.raw('textaed3545ea8e4')}
          </Button>
        )}
        {showCustom ? (
          <div
            className={cn(
              'space-y-5',
              !customOnly && 'border-border/60 bg-card rounded-md border p-4',
            )}
          >
            {!customOnly && (
              <div className="space-y-1">
                <h3 className="text-foreground text-base font-semibold">
                  {tI18nComplete.raw('text6e3fcca472c5')}
                </h3>
                <p className="text-muted-foreground text-sm">
                  {tI18nComplete.raw('text0881271239f3')}
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
                    {tI18nComplete.raw('text8cd1f7bcdc71')}
                  </div>
                  <div className="text-muted-foreground text-xs font-medium">
                    {tI18nComplete.raw('textcc6e921330d3')}
                  </div>
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
                      {tI18nComplete.raw('text4ddf02a36df5')}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </div>

              {manifest.isLoading ? (
                <Skeleton className={cn('h-52 w-full', !customOnly && 'rounded-md')} />
              ) : manifest.isError ? (
                <InfoBanner tone="destructive">
                  {(manifest.error as Error)?.message || tI18nComplete.raw('text65a8ec4a4a48')}
                </InfoBanner>
              ) : manifest.data ? (
                <div className={cn('max-h-[26rem] overflow-auto', !customOnly && 'rounded-md')}>
                  <CodeSnippet code={manifest.data} language="json" />
                </div>
              ) : null}

              <ol className="space-y-2">
                {[
                  tI18nComplete.raw('texta89d28175307'),
                  tI18nComplete.raw('text690ee10ca19e'),
                  tI18nComplete.raw('text2cf7a6e21f7e'),
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
                  {tI18nComplete.raw('textf00ff63fb851')}
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {tI18nComplete.raw('texte5974d3936df')}
                </p>
              </div>
              <div className={cn('grid gap-3', !customOnly && 'sm:grid-cols-2')}>
                <Field>
                  <Input
                    id="slack-channel-bot-token"
                    name="slack-channel-bot-token"
                    aria-label={tI18nComplete.raw('textc297a4c9177d')}
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder={tI18nComplete.raw('textdf964376e432')}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field>
                  <Input
                    id="slack-channel-signing-secret"
                    name="slack-channel-signing-secret"
                    aria-label={tI18nComplete.raw('text52594f72e6fc')}
                    type="password"
                    value={signingSecret}
                    onChange={(e) => setSigningSecret(e.target.value)}
                    placeholder={tI18nComplete.raw('text52594f72e6fc')}
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
                  {tI18nComplete.raw('text75b86fa11745')}
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
      successToast(tI18nHardcoded.raw('i18nComplete.text23922935b1f8'));
      queryClient.invalidateQueries({
        queryKey: qk.project.connectorConfig(projectId, connector.slug),
      });
      onChanged();
    },
    onError: (e: Error) =>
      errorToast(e.message || tI18nHardcoded.raw('i18nComplete.textf9581c8d3b47')),
  });

  return (
    <section className="space-y-4">
      <Label>{tI18nHardcoded.raw('i18nComplete.text639a40e82b9a')}</Label>
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
                {tI18nHardcoded.raw('i18nComplete.text942087cc2d41')}
              </Button>
            }
          >
            {(configQuery.error as Error)?.message ??
              tI18nHardcoded.raw('i18nComplete.text27c2ccd962c2')}
          </InfoBanner>
        ) : configQuery.isLoading || !draft ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-2/3 rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
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
                    <p className="text-sm font-medium">
                      {tI18nHardcoded.raw('i18nComplete.textb1c42b3ce118')}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {connector.secretSet
                        ? tI18nHardcoded.raw('i18nComplete.text0b7bd1b43899')
                        : tI18nHardcoded.raw('i18nComplete.text44160e26b787')}
                    </p>
                  </div>
                  {/* One credential action per connector, and it lives in the
                      header ("Add credential" / "Replace credential",
                      connector-modal.tsx). A second button here read as a
                      different action and gave the same modal a third label. */}
                  <Badge variant={connector.secretSet ? 'secondary' : 'outline'}>
                    {connector.secretSet
                      ? 'Connected'
                      : tI18nHardcoded.raw('i18nComplete.text0303e1824670')}
                  </Badge>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const policyChoices = useLocalizedUiCatalog(POLICY_CHOICES);
  const policyLabels = useLocalizedUiCatalog(POLICY_LABEL);
  const meta =
    value === 'default'
      ? { label: tI18nComplete.raw('text21b111cbfe6e'), tint: 'text-muted-foreground' }
      : { label: policyLabels[value].label, tint: policyLabels[value].tint };
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
        {policyChoices.map((c) => (
          <DropdownMenuItem key={c.value} onClick={() => onChange(c.value)} className="text-xs">
            <span className={cn(c.value !== 'default' && policyLabels[c.value].tint)}>
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
  const rlParts: string[] = [];
  for (const r of rules) {
    const match = r.match.trim();
    if (match) rlParts.push(`${match}=${r.action}`);
  }
  return `${pt}|${rlParts.join(',')}`;
}

function tsSignature(slug: string, action: ConnectorAction): string {
  const props =
    (action.inputSchema as { properties?: Record<string, { type?: string }> } | null)?.properties ??
    {};
  const required = new Set((action.inputSchema as { required?: string[] } | null)?.required ?? []);
  const args = Object.entries(props).map(([k, v]) => {
    const t = v?.type === 'integer' ? 'number' : (v?.type ?? 'string');
    return `  ${k}${required.has(k) ? '' : '?'}: ${t};`;
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
      successToast(
        next
          ? tI18nHardcoded.raw('i18nComplete.text3f4f94c9ca11')
          : tI18nHardcoded.raw('i18nComplete.text5fcf2002eb0b'),
      );
      onChanged();
    },
    onError: (e: Error) =>
      errorToast(e.message || tI18nHardcoded.raw('i18nComplete.textc00080b272bc')),
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
      const policies: ConnectorPolicyRule[] = [];
      for (const t of tools) {
        const action = perTool[t.path];
        if (action) policies.push({ match: t.path, action });
      }
      for (const r of rules) {
        const match = r.match.trim();
        if (match) policies.push({ match, action: r.action });
      }
      return setConnectorPolicies(projectId, connector.slug, policies);
    },
    onSuccess: () => {
      successToast(tI18nHardcoded.raw('i18nComplete.text06f352cee5a7'));
      queryClient.invalidateQueries({
        queryKey: ['connector-policies', projectId, connector.slug],
      });
    },
    onError: (e: Error) =>
      errorToast(e.message || tI18nHardcoded.raw('i18nComplete.textecd3c555ab44')),
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
          <h3 className="text-sm font-medium">
            {tI18nHardcoded.raw('i18nComplete.textabccc78cc93c')}
          </h3>
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
          title={tI18nHardcoded('i18nComplete.textc5a4b3f3a022', {
            value0: projectDecided.size,
            value1:
              projectDecided.size === 1
                ? tI18nHardcoded.raw('i18nComplete.text547602d87c05')
                : tI18nHardcoded.raw('i18nComplete.text5273e4e9e2bc'),
          })}
        >
          {tI18nHardcoded.raw('i18nComplete.text0eaf8d2c6d6c')}
        </InfoBanner>
      )}
      <div className="bg-popover rounded-md border px-4 py-3">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{tI18nHardcoded.raw('i18nComplete.text21b111cbfe6e')}</Label>
            <RadioGroup
              value={connector.sensitive ? 'ask_first' : 'follow_rules'}
              onValueChange={(v) => canWrite && sensitiveMut.mutate(v === 'ask_first')}
              className="space-y-2"
            >
              <RadioGroupItem
                value="follow_rules"
                id={`connector-default-follow-${connector.slug}`}
                label={tI18nHardcoded.raw('i18nComplete.textb6a712c43af9')}
                description={tI18nHardcoded.raw('i18nComplete.texta1e247e8a9f9')}
                size="lg"
                variant="outline"
                disabled={sensitiveMut.isPending || !canWrite}
              />
              <RadioGroupItem
                value="ask_first"
                id={`connector-default-ask-${connector.slug}`}
                label={tI18nHardcoded.raw('i18nComplete.text4a9e8cf39abb')}
                description={
                  <>
                    {tI18nHardcoded.raw('i18nComplete.text284268708d2d')}{' '}
                    <span className="text-foreground font-medium">
                      {tI18nHardcoded.raw('i18nComplete.text3566cf23ecb6')}
                    </span>{' '}
                    {tI18nHardcoded.raw('i18nComplete.text5b707c83333c')}
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
            <div className="border-border/60 overflow-hidden rounded-md border">
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
                      {selected.size} {tI18nHardcoded.raw('i18nComplete.textd7cbbb688b2e')}
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
                      {tI18nHardcoded.raw('i18nComplete.text83b12c2216ef')}
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
                            title={tI18nHardcoded('i18nComplete.textdf6224fb4ca9', {
                              value0: ruled.match,
                            })}
                          >
                            {POLICY_LABEL[ruled.action].label}{' '}
                            {tI18nHardcoded.raw(
                              'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextRulebbcba279',
                            )}
                          </span>
                        )}
                        {projectAction && (
                          <Hint
                            label={tI18nHardcoded('i18nComplete.text9e2fda379985', {
                              value0: POLICY_LABEL[projectAction].label,
                            })}
                          >
                            <Badge variant="outline" size="sm" className="shrink-0 gap-1">
                              <Lock className="size-3 shrink-0" />
                              <span className={POLICY_LABEL[projectAction].tint}>
                                {POLICY_LABEL[projectAction].label}
                              </span>
                              {tI18nHardcoded.raw('i18nComplete.text9f382d463ed1')}
                            </Badge>
                          </Hint>
                        )}
                        <ChevronRight
                          className={cn(
                            'duration-normal size-3 shrink-0 transition-[transform,opacity,color]',
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
            <div className="border-border/60 rounded-md border">
              <button
                type="button"
                onClick={() => setShowRules((s) => !s)}
                className="text-foreground hover:bg-muted/40 flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm font-medium"
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
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <EmptyState
          icon={Plug}
          title={tI18nHardcoded.raw('i18nComplete.text51ae0a7e3783')}
          description={tI18nHardcoded.raw('i18nComplete.text0bf59aef2b27')}
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
        <h2 className="text-foreground text-xl font-medium">
          {tI18nHardcoded.raw('i18nComplete.text3a06bf051e48')}
        </h2>
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
          {discoverEnabled && (
            <TabsTrigger value="discover">
              {tI18nHardcoded.raw('i18nComplete.textd4a33d5b78bc')}
            </TabsTrigger>
          )}
          <TabsTrigger value="channels">
            {tI18nHardcoded.raw('i18nComplete.text4c8906cf76f5')}
          </TabsTrigger>
          <TabsTrigger value="custom">
            {tI18nHardcoded.raw('i18nComplete.text494ca78f7374')}
          </TabsTrigger>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Email inbox');
  const [username, setUsername] = useState('');
  const add = useMutation({
    mutationFn: async () => {
      const slug = buildEmailConnectorConnectionSlug(
        username || name,
        globalThis.crypto.randomUUID(),
      );
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
        warningToast(tI18nComplete('text4e12058e58c1', { value0: syncError }));
        onAdded();
        return;
      }
      successToast(tI18nComplete.raw('textd1dcd7a7bbec'));
      onAdded(slug);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text3df88e8f7ea6')),
  });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={CHANNEL_CATALOGUE_CARD_CLASS}>
        <div className="flex items-center gap-3">
          <EntityAvatar icon={Mail} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">
              {tI18nComplete.raw('textf00606184e4d')}
            </div>
            <div className="text-muted-foreground truncate text-xs">
              {tI18nComplete.raw('text2283269ca150')}
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
          {tI18nComplete.raw('text3b61c181f516')}
        </p>
      </button>
      <Modal open={open} onOpenChange={(next) => !add.isPending && setOpen(next)}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('text2b47dcc33a2a')}</ModalTitle>
            <ModalDescription>{tI18nComplete.raw('text630694bd2dec')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="email-connection-name">
                {tI18nComplete.raw('text2b7f6a84de91')}
              </FieldLabel>
              <Input
                id="email-connection-name"
                name="email-connection-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tI18nComplete.raw('text945ce03ec79f')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-connection-prefix">
                {tI18nComplete.raw('text4e6946711ca8')}
              </FieldLabel>
              <Input
                id="email-connection-prefix"
                name="email-connection-prefix"
                value={username}
                onChange={(e) =>
                  setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
                }
                placeholder={tI18nComplete.raw('texta18603086e5b')}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text2549e14d07c9')}
              </p>
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button variant="outline-ghost" onClick={() => setOpen(false)} disabled={add.isPending}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button onClick={() => add.mutate()} disabled={add.isPending} className="gap-1.5">
              {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('text8dff8c0800fd')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const handleConnected = () => {
    successToast(tI18nComplete.raw('text1bfa15228ca8'));
    setOpen(false);
    onAdded('kortix_slack');
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={CHANNEL_CATALOGUE_CARD_CLASS}>
        <div className="flex items-center gap-3">
          <SlackIconTile />
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">
              {tI18nComplete.raw('textb27fb38ba323')}
            </div>
            <div className="text-muted-foreground truncate text-xs">
              {tI18nComplete.raw('textbbbf43b8819c')}
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
          {tI18nComplete.raw('text43b4b568012f')}
        </p>
      </button>
      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('text62da6a2b1758')}</ModalTitle>
            <ModalDescription>{tI18nComplete.raw('text8b5b9b72f2ec')}</ModalDescription>
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
          tI18nHardcoded('i18nComplete.textd6a135de3872', {
            value0: connector.name,
            value1: connector.syncError,
          }),
        );
        onAdded();
        return;
      }
      successToast(tI18nHardcoded('i18nComplete.text590d36262e11', { value0: connector.name }));
      onAdded(connector.slug);
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.texta34a2714da91')),
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
            description={
              q
                ? tI18nHardcoded('i18nComplete.text3e71adfa7d54', { value0: q })
                : tI18nHardcoded.raw('i18nComplete.textecbd276ebec2')
            }
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
                    tI18nHardcoded.raw('i18nComplete.textac8991ef0101')
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
        description={tI18nHardcoded.raw('i18nComplete.text6acbef3d00c7')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value));
  // Re-seed only when the saved value genuinely differs from what we're showing,
  // so a refetch can't wipe a row the user is mid-way through typing.
  const [initialSeed] = useState(() => JSON.stringify(Object.entries(value)));
  const seeded = useRef(initialSeed);
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
      <FieldLabel>{tI18nComplete.raw('text194e9fe656a1')}</FieldLabel>
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
                  placeholder={tI18nComplete.raw('text1447557b9c1e')}
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
                  placeholder={tI18nComplete.raw('text822b33ad87c1')}
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
                    aria-label={tI18nComplete.raw('texte42db5eb1789')}
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
            <Plus className="size-3.5" /> {tI18nComplete.raw('text1192c90dd497')}
          </Button>
        )}
      </div>
      <FieldDescription>{tI18nComplete.raw('text3ca228539c82')}</FieldDescription>
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
          <FieldLabel htmlFor="connector-slug">
            {tI18nHardcoded.raw('i18nComplete.textd15387ecc6c5')}
          </FieldLabel>
          <Input
            id="connector-slug"
            value={draft.slug}
            onChange={(e) => {
              slugTouched.current = true;
              set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') });
            }}
            placeholder={tI18nHardcoded.raw('i18nComplete.text9696f2b4e020')}
            className="font-mono text-xs"
            variant="popover"
            disabled={!slugEditable || readOnly}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="connector-provider">
            {tI18nHardcoded.raw('i18nComplete.text472590ae974d')}
          </FieldLabel>
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
              <SelectItem value="openapi">
                {tI18nHardcoded.raw('i18nComplete.textcf2c9e218033')}
              </SelectItem>
              <SelectItem value="postman">
                {tI18nHardcoded.raw('i18nComplete.text213985e12832')}
              </SelectItem>
              <SelectItem value="graphql">
                {tI18nHardcoded.raw('i18nComplete.textee27322554e4')}
              </SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="channel">
                {tI18nHardcoded.raw('i18nComplete.textce4683e7013a')}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {p === 'channel' && (
        <div className="space-y-1.5">
          <Label>{tI18nHardcoded.raw('i18nComplete.textce4683e7013a')}</Label>
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
              {emailChannelEnabled && (
                <SelectItem value="email">
                  {tI18nHardcoded.raw('i18nComplete.text969ccbd3cf63')}
                </SelectItem>
              )}
              <SelectItem value="slack">
                {tI18nHardcoded.raw('i18nComplete.textb27fb38ba323')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {(p === 'openapi' || p === 'postman') && (
        <Field>
          <FieldLabel htmlFor="connector-spec">
            {p === 'postman'
              ? tI18nHardcoded.raw('i18nComplete.textcd8dd219cc48')
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
              {tI18nHardcoded.raw('i18nComplete.textc26ca4369200')}
            </FieldDescription>
          ) : null}
        </Field>
      )}
      {p === 'graphql' && (
        <>
          <Field>
            <FieldLabel htmlFor="connector-endpoint">
              {tI18nHardcoded.raw('i18nComplete.text3df9726c68ba')}
            </FieldLabel>
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
              placeholder={tI18nHardcoded.raw('i18nComplete.textecccd43d1878')}
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
            <FieldLabel htmlFor="connector-transport">
              {tI18nHardcoded.raw('i18nComplete.textaaead4abf5d0')}
            </FieldLabel>
            <Select
              value={draft.transport ?? 'http'}
              disabled={readOnly}
              onValueChange={(v) => set({ transport: v as 'http' | 'sse' })}
            >
              <SelectTrigger id="connector-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">
                  {tI18nHardcoded.raw('i18nComplete.texte0603c499aae')}
                </SelectItem>
                <SelectItem value="sse">
                  {tI18nHardcoded.raw('i18nComplete.textfe3811fe21af')}
                </SelectItem>
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
              placeholder={tI18nHardcoded.raw('i18nComplete.textb2c293b68745')}
              variant="popover"
              disabled={readOnly}
            />
          </Field>
        </>
      )}
      {needsAuth && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="connector-auth">
              {tI18nHardcoded.raw('i18nComplete.text8eb3ea9bbde6')}
            </FieldLabel>
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
                <SelectItem value="auto">
                  {tI18nHardcoded.raw('i18nComplete.text89ebfb7a88ca')}
                </SelectItem>
                <SelectItem value="none">
                  {tI18nHardcoded.raw('i18nComplete.textdc937b598926')}
                </SelectItem>
                <SelectItem value="bearer">
                  {tI18nHardcoded.raw('i18nComplete.text710e0dbdd422')}
                </SelectItem>
                <SelectItem value="basic">
                  {tI18nHardcoded.raw('i18nComplete.text0e35f6e9742e')}
                </SelectItem>
                <SelectItem value="api_key">
                  {tI18nHardcoded.raw('i18nComplete.text16f0ee47f993')}
                </SelectItem>
                {onOAuth2SelectedChange && (
                  <SelectItem value="oauth2_client_credentials">
                    {tI18nHardcoded.raw('i18nComplete.textaebabad39063')}
                  </SelectItem>
                )}
                <SelectItem value="oauth1">
                  {tI18nHardcoded.raw('i18nComplete.textf461c90d16f6')}
                </SelectItem>
                <SelectItem value="hmac">
                  {tI18nHardcoded.raw('i18nComplete.textf9a4ecea0836')}
                </SelectItem>
                <SelectItem value="aws_sigv4">
                  {tI18nHardcoded.raw('i18nComplete.text1746a52157af')}
                </SelectItem>
                <SelectItem value="mtls">
                  {tI18nHardcoded.raw('i18nComplete.textd0dd76e23558')}
                </SelectItem>
                <SelectItem value="custom">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextCustomHeader1e0e82ed',
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              {oauth2Selected ? (
                tI18nHardcoded.raw('i18nComplete.text80770d26537b')
              ) : draft.auth === undefined && detectedAuth ? (
                <>
                  {tI18nHardcoded.raw('i18nComplete.text756a8ba97dce')}{' '}
                  <span className="font-medium">{detectedAuth.type}</span>
                  {detectedAuth.parameterName ? (
                    <>
                      {' '}
                      {tI18nHardcoded.raw('i18nComplete.text4d327af41f96')}{' '}
                      <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                        {detectedAuth.parameterName}
                      </code>
                    </>
                  ) : null}
                  {tI18nHardcoded.raw('i18nComplete.text5c48a6568d59')}
                </>
              ) : (
                tI18nHardcoded.raw('i18nComplete.text566a18d73a39')
              )}
            </FieldDescription>
          </Field>
          {/* Show the detected header alongside the select so the actual header
              name is visible without saving first — read-only, because the
              source is the authority until the user picks an explicit override. */}
          {draft.auth === undefined && detectedAuth?.parameterName && (
            <Field>
              <FieldLabel htmlFor="connector-auth-detected">
                {tI18nHardcoded.raw('i18nComplete.textc1dcc8fb31f6')}
              </FieldLabel>
              <Input
                id="connector-auth-detected"
                value={detectedAuth.parameterName}
                readOnly
                variant="popover"
                className="font-mono text-xs"
              />
              <FieldDescription>
                {tI18nHardcoded.raw('i18nComplete.text46c6aec94116')}
              </FieldDescription>
            </Field>
          )}
          {(draft.auth?.type === 'custom' || draft.auth?.type === 'api_key') && (
            <>
              <Field>
                <FieldLabel htmlFor="connector-auth-name">
                  {tI18nHardcoded.raw('i18nComplete.textd7cb455aa690')}
                </FieldLabel>
                <Input
                  id="connector-auth-name"
                  value={draft.auth?.name ?? ''}
                  onChange={(e) => setAuth({ name: e.target.value })}
                  placeholder={tI18nHardcoded.raw('i18nComplete.text6f9f03f95e78')}
                  variant="popover"
                  disabled={readOnly}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connector-auth-placement">
                  {tI18nHardcoded.raw('i18nComplete.text4df9939944a7')}
                </FieldLabel>
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
                    <SelectItem value="header">
                      {tI18nHardcoded.raw('i18nComplete.textba5caa4285a8')}
                    </SelectItem>
                    <SelectItem value="query">
                      {tI18nHardcoded.raw('i18nComplete.textb80a37564fbb')}
                    </SelectItem>
                    <SelectItem value="cookie">
                      {tI18nHardcoded.raw('i18nComplete.text45823eaac0c8')}
                    </SelectItem>
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
          tI18nHardcoded('i18nComplete.textd6a135de3872', {
            value0: draft.slug,
            value1: result.syncError,
          }),
        );
        onAdded();
        return;
      }
      successToast(
        result.credentialStored
          ? tI18nHardcoded('i18nComplete.text5120ee26cbf5', { value0: draft.slug })
          : tI18nHardcoded('i18nComplete.text29f396e2d238', { value0: draft.slug }),
      );
      onAdded(draft.slug);
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.textbdc7d54433e6')),
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
              <InfoBanner tone="info" title={tI18nHardcoded.raw('i18nComplete.textc2a08c85f9d8')}>
                {tI18nHardcoded.raw('i18nComplete.text9dedee588b5e')}
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
              {tI18nHardcoded.raw('i18nComplete.text547a92020d87')}
            </InfoBanner>
          )}
          {draft.auth === undefined && discovery.isFetching && (
            <InfoBanner tone="info">
              {tI18nHardcoded.raw('i18nComplete.text0fc5f970755c')}
            </InfoBanner>
          )}
          {draft.auth === undefined && discovery.data?.status === 'none' && (
            <InfoBanner tone="neutral">
              {tI18nHardcoded.raw('i18nComplete.textcec52b040075')}
            </InfoBanner>
          )}
          {draft.auth === undefined && discovery.data?.status === 'unsupported' && (
            <InfoBanner tone="warning">
              {tI18nHardcoded.raw('i18nComplete.text028f0773776c')}
            </InfoBanner>
          )}
          {draft.auth === undefined && discovery.error && (
            <InfoBanner tone="warning">
              {tI18nHardcoded.raw('i18nComplete.textf26a5845c994')}{' '}
              {(discovery.error as Error).message}
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
  /**
   * `null` until the user picks a tab. The effective tab is then derived from
   * discovery, so a server that supports one-click OAuth opens on OAuth and a
   * plain API needs no detour through a grant selector.
   */
  const [credentialTypeChoice, setCredentialTypeChoice] = useState<'static' | 'oauth2' | null>(
    null,
  );
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
  const [manualSetup, setManualSetup] = useState(false);
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
          successToast(tI18nHardcoded.raw('i18nComplete.textc2a5f8398f12'));
          onSaved();
          onOpenChange(false);
        } else {
          errorToast(status.error_code || tI18nHardcoded.raw('i18nComplete.text911a1cde90bc'));
        }
      } catch (error) {
        if (!stopped)
          errorToast(
            error instanceof Error
              ? error.message
              : tI18nHardcoded.raw('i18nComplete.textfa23c868781d'),
          );
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), device.interval_seconds * 1000);
    const expiryTimer = window.setTimeout(
      () => {
        stopped = true;
        errorToast(tI18nHardcoded.raw('i18nComplete.text02c1d7b545ea'));
      },
      Math.max(0, new Date(device.expires_at).getTime() - Date.now()),
    );
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(expiryTimer);
    };
  }, [device, deviceConnectionId, onOpenChange, onSaved, projectId, tI18nHardcoded]);
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
  /**
   * The MCP authorization chain — `WWW-Authenticate` → protected resource
   * metadata → authorization server metadata → registration endpoint. Run once
   * when the OAuth 2.0 tab opens so a server that publishes its own metadata
   * needs one click and zero fields. Discovery is connection-scoped, so this
   * resolves (or creates) the connection first.
   */
  const discoveryQuery = useQuery({
    queryKey: qk.project.connectorOAuth2Discovery(projectId, connector?.slug ?? ''),
    queryFn: async () => {
      const activeConnectionId = await resolveConnectionId();
      const result = await discoverConnectionOAuth2Resource(projectId, activeConnectionId);
      return { connectionId: activeConnectionId, discovery: result.discovery };
    },
    // Runs as soon as the modal OPENS, not when the OAuth tab is clicked: the
    // answer decides which tab the user should land on, so it has to be known
    // before they choose. A connector with no server URL 400s here and simply
    // leaves the modal on its static-credential default.
    enabled: open && Boolean(connector),
    retry: false,
    // Same tier as the connector config it sits beside: provider metadata
    // changes on the provider's schedule, not on ours (FRESHNESS
    // .connectorOAuth2Discovery).
    ...contract('config'),
  });
  const discovery = discoveryQuery.data?.discovery ?? null;
  const discoveryError = discoveryQuery.isError
    ? ((discoveryQuery.error as Error)?.message ?? 'Discovery failed')
    : null;
  const discoveryPending = discoveryQuery.isFetching && !discovery;
  const plan = autoConnectPlan(discovery);
  /**
   * Discovery prefills the manual form at render time rather than through a
   * setState: the merge keeps anything the user typed, so applying it on every
   * render is idempotent and there is no effect to keep in sync.
   */
  const effectiveApplication = discovery
    ? mergeResourceDiscoveryIntoForm(application, discovery)
    : application;
  /**
   * The endpoint/client fields only appear when automatic setup cannot finish
   * the job: the user asked for their own app, or the server publishes nothing
   * Kortix can act on. `unknown` (discovery still running or not started) keeps
   * them visible so the modal is never empty.
   */
  /**
   * The tab the user is on. Discovery decides the default: a server that
   * publishes OAuth metadata opens on OAuth 2.0, everything else on the static
   * credential. An explicit tab click always wins.
   */
  const credentialType: 'static' | 'oauth2' =
    credentialTypeChoice ??
    (plan.kind === 'register' || plan.kind === 'client_id_required' ? 'oauth2' : 'static');
  const showManualOAuth2Fields =
    manualSetup || plan.kind === 'unknown' || plan.kind === 'client_id_required';
  const oauth2Valid =
    application.grant === 'client_credentials'
      ? oauth2CredentialFormValid(oauth2)
      : oauth2ApplicationFormValid(effectiveApplication);
  /**
   * One click: register Kortix with the authorization server (RFC 7591), then
   * start Authorization Code + PKCE. No client id, no secret, no endpoints.
   */
  const autoConnect = useMutation({
    mutationFn: async () => {
      if (!discovery) throw new Error('Discovery has not completed');
      const activeConnectionId = discoveryQuery.data?.connectionId ?? (await resolveConnectionId());
      await registerConnectionOAuth2Client(
        projectId,
        activeConnectionId,
        buildClientRegistrationInput(discovery),
      );
      const redirect = new URL(window.location.href);
      redirect.searchParams.delete('oauth2');
      redirect.searchParams.delete('oauth2_error');
      const result = await startConnectionOAuth2Authorization(projectId, activeConnectionId, {
        ...(discovery.scopes.length ? { scopes: discovery.scopes } : {}),
        success_redirect_uri: redirect.toString(),
        error_redirect_uri: redirect.toString(),
      });
      window.location.assign(result.authorization_url);
      return result;
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.text46c9f3b7520f')),
  });

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
          return updateConnectionCredential(projectId, await resolveConnectionId(), oauth2Input);
        }
        return setConnectorCredential(projectId, connector!.slug, oauth2Input);
      }
      const activeConnectionId = await resolveConnectionId();
      const resolvedApplication = effectiveApplication.discoveryUrl
        ? mergeOAuth2DiscoveryMetadata(
            effectiveApplication,
            (
              await discoverConnectionOAuth2(projectId, activeConnectionId, {
                discovery_url: effectiveApplication.discoveryUrl,
              })
            ).metadata,
          )
        : effectiveApplication;
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
      const result = await startConnectionOAuth2DeviceAuthorization(projectId, activeConnectionId, {
        scopes: scopes.length ? scopes : undefined,
      });
      setDeviceConnectionId(activeConnectionId);
      setDevice(result);
      return result;
    },
    onSuccess: () => {
      if (credentialType === 'oauth2' && application.grant !== 'client_credentials') return;
      successToast(
        credentialType === tI18nHardcoded.raw('i18nComplete.textd8ad572d2fb1')
          ? tI18nHardcoded.raw('i18nComplete.text6984a3c945fa')
          : tI18nHardcoded.raw('i18nComplete.textf0341f8dbcc5'),
      );
      setValue('');
      setOauth2(EMPTY_OAUTH2_CREDENTIAL_FORM);
      setApplication(EMPTY_OAUTH2_APPLICATION_FORM);
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.text2c07997249ab')),
  });
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (save.isPending) return;
        if (!o) {
          setManualSetup(false);
          setCredentialTypeChoice(null);
        }
        onOpenChange(o);
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
          <ModalDescription>{tI18nHardcoded.raw('i18nComplete.text8e5a984b8a84')}</ModalDescription>
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
              onValueChange={(next) => setCredentialTypeChoice(next as 'static' | 'oauth2')}
              className="gap-4"
            >
              <TabsList>
                <TabsTrigger value="static">
                  {tI18nHardcoded.raw('i18nComplete.text8f0b0d462a16')}
                </TabsTrigger>
                <TabsTrigger value="oauth2">
                  {tI18nHardcoded.raw('i18nComplete.textaebabad39063')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="static">
                <Field>
                  <FieldLabel htmlFor="connector-static-credential">
                    {objectCredential
                      ? tI18nHardcoded.raw('i18nComplete.textb8ce566177f1')
                      : 'Value'}
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
                      {tI18nHardcoded.raw('i18nComplete.textfdf7bc860f55')} {requestAuth}{' '}
                      {tI18nHardcoded.raw('i18nComplete.text41a01f64505d')}
                    </FieldDescription>
                  )}
                </Field>
              </TabsContent>
              <TabsContent value="oauth2" className="space-y-4">
                {discoveryPending ? (
                  <InfoBanner
                    tone="neutral"
                    title={tI18nHardcoded.raw('i18nComplete.text1ead5326bbb8')}
                  >
                    {tI18nHardcoded.raw('i18nComplete.textc9b1c409642d')}
                  </InfoBanner>
                ) : plan.kind === 'no_authorization' ? (
                  <InfoBanner
                    tone="neutral"
                    title={tI18nHardcoded.raw('i18nComplete.text24f46f717cfa')}
                  >
                    {tI18nHardcoded.raw('i18nComplete.text93bc06df8dd8')}
                  </InfoBanner>
                ) : plan.kind === 'register' && !manualSetup ? (
                  <div className="space-y-3">
                    <InfoBanner
                      tone="neutral"
                      title={tI18nHardcoded.raw('i18nComplete.text477d50f7ddbf')}
                    >
                      {tI18nHardcoded.raw('i18nComplete.text07fdd059f8a1')}
                      {plan.scopes.length
                        ? tI18nHardcoded('i18nComplete.text1d42883b00c1', {
                            value0: plan.scopes.join(', '),
                          })
                        : ''}
                    </InfoBanner>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        disabled={autoConnect.isPending}
                        onClick={() => autoConnect.mutate()}
                      >
                        {autoConnect.isPending && <Loading className="size-4 shrink-0" />}
                        {plan.label}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline-ghost"
                        onClick={() => setManualSetup(true)}
                      >
                        {tI18nHardcoded.raw('i18nComplete.texte67a6ef2363e')}
                      </Button>
                    </div>
                  </div>
                ) : plan.kind === 'client_id_required' ? (
                  <InfoBanner
                    tone="neutral"
                    title={tI18nHardcoded.raw('i18nComplete.textcb7c06207756')}
                  >
                    {tI18nHardcoded.raw('i18nComplete.text0dbb23e7febb')}
                  </InfoBanner>
                ) : plan.kind === 'manual' && !manualSetup ? (
                  <InfoBanner
                    tone="neutral"
                    title={tI18nHardcoded.raw('i18nComplete.texteb99bb9a22f3')}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setManualSetup(true)}
                      >
                        {tI18nHardcoded.raw('i18nComplete.textb1d877ab2f51')}
                      </Button>
                    }
                  >
                    {plan.reason}
                  </InfoBanner>
                ) : (
                  <InfoBanner tone="info">
                    {tI18nHardcoded.raw('i18nComplete.text67dc9c4395f1')}
                  </InfoBanner>
                )}
                {discoveryError && (
                  <InfoBanner
                    tone="neutral"
                    title={tI18nHardcoded.raw('i18nComplete.textdc258e9a953b')}
                  >
                    {discoveryError}
                  </InfoBanner>
                )}
                {showManualOAuth2Fields && (
                  <>
                    <Field>
                      <FieldLabel htmlFor="connector-oauth2-grant">
                        {tI18nHardcoded.raw('i18nComplete.text78b7d0379d5e')}
                      </FieldLabel>
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
                          <SelectItem value="client_credentials">
                            {tI18nHardcoded.raw('i18nComplete.text23c446ef2187')}
                          </SelectItem>
                          <SelectItem value="authorization_code">
                            {tI18nHardcoded.raw('i18nComplete.textac806359529b')}
                          </SelectItem>
                          <SelectItem value="device_authorization">
                            {tI18nHardcoded.raw('i18nComplete.text197da3e17a78')}
                          </SelectItem>
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
                        value={effectiveApplication}
                        onChange={setApplication}
                        idPrefix="connector-oauth2-application"
                      />
                    )}
                  </>
                )}
                {device && (
                  <InfoBanner
                    tone="neutral"
                    title={tI18nHardcoded('i18nComplete.textbfd271fe6ead', {
                      value0: device.user_code,
                    })}
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
                        {tI18nHardcoded.raw('i18nComplete.text97fc3d60fab5')}
                      </Button>
                    }
                  >
                    {tI18nHardcoded.raw('i18nComplete.text9c67cc26222a')} {device.interval_seconds}{' '}
                    {tI18nHardcoded.raw('i18nComplete.text4616b90a6d94')}{' '}
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
              {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
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
                ? tI18nHardcoded.raw('i18nComplete.text0c814b60fca5')
                : credentialType === 'oauth2' && application.grant === 'device_authorization'
                  ? tI18nHardcoded.raw('i18nComplete.text55e970c35216')
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
        <Skeleton className="h-28 w-full rounded-md" />
        <Skeleton className="h-64 w-full rounded-md" />
      </div>
    </div>
  );
}
