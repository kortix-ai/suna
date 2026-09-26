'use client';

import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';

import { connectorCredentialHelpLinks } from '@/features/workspace/capabilities/connectors/detail/connector-doc-links';

import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CopyIcon as Copy,
  DotsThreeIcon,
  ArrowSquareOutIcon as ExternalLink,
  LockIcon as Lock,
  EnvelopeIcon as Mail,
  PlugIcon as Plug,
  PlusIcon as Plus,
  MagnifyingGlassIcon as Search,
  UsersIcon as Users,
  XIcon as X,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { parameterNameLooksLikeSecret } from './auth-param-name';

import { HighlightedCode } from '@/components/markdown/code';
import { ConnectorHandshake } from '@/components/setup-links/connector-handshake';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { connectorDisplayName } from '@/features/workspace/capabilities/connectors/connector-filter';
import { isManagedConnectorProvider } from '@/features/workspace/capabilities/connectors/provider-label';
import { SlackLogo } from '@/features/workspace/capabilities/connectors/slack-logo';
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
import { useCopy } from '@/hooks/use-copy';
import { isConnectorsEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import {
  type AdminConnector,
  type Connection,
  type ConnectionCredentialInput,
  type ConnectorAuthDiscovery,
  type ConnectorConfig,
  type ConnectorDraftInput,
  type ConnectorRequestAuthType,
  createConnector,
  deleteConnector,
  discoverConnectionOAuth2,
  discoverConnectionOAuth2Resource,
  discoverConnectorAuth,
  ensureProjectConnectorConnection,
  getConnectorConfig,
  getConnectStatus,
  listAllConnections,
  listConnections,
  listPipedreamApps,
  listProjectAccess,
  type OAuth2DeviceAuthorizationStartResult,
  pollConnectionOAuth2DeviceAuthorization,
  putConnectionOAuth2Application,
  reconcileConnection,
  reconcileMemberConnection,
  registerConnectionOAuth2Client,
  renameConnection,
  revokeConnection,
  setConnectorCredential,
  setDefaultConnection,
  startConnectionOAuth2Authorization,
  startConnectionOAuth2DeviceAuthorization,
  updateConnectionCredential,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  buildEasyConnectConnectorDraft,
  buildEmailConnectorConnectionSlug,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  type EasyConnectApp,
  type EasyConnectConnectionInput,
  proposeConnectorConnectionSlug,
} from './connector-connection-form';
import { ConnectorConnectionModal } from './connector-connection-modal';
import { credentialWriteTarget, oauth2DiscoveryConnectionKey } from './connector-credential-target';
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
  oauth2CredentialOffered,
} from './connector-oauth2-auto';
import { OAuth2CredentialFields } from './connector-oauth2-fields';
import { DiscoverCatalogue } from './discover-catalogue';
import { connectorConnectionRows } from './view/connector-connections';

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);

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

/** One row in the connections list — a single connected account. */
function ConnectionRow({
  connection,
  isMine,
  canManage,
  onSetDefault,
  onDisconnect,
  onRename,
  onStartSession,
  onSetCredential,
  pending,
  disabled = false,
}: {
  connection: Connection;
  isMine: boolean;
  canManage: boolean;
  onSetDefault: () => void;
  onDisconnect: () => void;
  /** Change the label only. The account stays authorized. */
  onRename: () => void;
  onStartSession?: () => void;
  /** Re-open the credential entry for THIS account. Direct providers
   *  (openapi/http/mcp/graphql/…) hold their own static credential per
   *  account instead of a connector-wide one; managed (Composio/Pipedream)
   *  providers re-authorize through OAuth instead, so this is omitted there. */
  onSetCredential?: () => void;
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
          {/* WHO the account was authorized as. Hidden when the label already
              says it (finalize names a default-labelled account after it). */}
          {connection.connected_as && connection.connected_as !== connection.label
            ? tI18nComplete('texte9e0b20cf289', { value0: connection.connected_as })
            : null}
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
          {mayMutate && (
            <DropdownMenuItem onClick={onRename}>
              {tI18nComplete.raw('text3064d79a295c')}
            </DropdownMenuItem>
          )}
          {mayMutate && isMine && active && onStartSession && (
            <DropdownMenuItem onClick={onStartSession}>
              {tI18nComplete.raw('textfae237eed0c5')}
            </DropdownMenuItem>
          )}
          {mayMutate && onSetCredential && (
            <DropdownMenuItem onClick={onSetCredential}>
              {tI18nComplete.raw('text3d6627454174')}
            </DropdownMenuItem>
          )}
          {mayMutate && !connection.is_default && active && (
            <DropdownMenuItem onClick={onSetDefault}>
              {tI18nComplete.raw('texta92f66fd3d83')}
              {isProjectAuthorization ? ` ${tI18nComplete.raw('text801a345cd406')}` : ''}
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

/** Which owner a group of accounts belongs to. */
type ConnectionOwner = 'project' | 'me';

/**
 * One owner group: heading, its add control, and its rows.
 *
 * Both groups render the same `ConnectionRow`, so a shared and a private
 * account read identically apart from the tile and the "Shared with the
 * project" / "Private — only you" line the row already prints.
 */
function ConnectionOwnerGroup({
  title,
  action,
  loading,
  rows,
  emptyTitle,
  emptyDescription,
  canManageConnections,
  disabled,
  pendingConnectionId,
  onSetDefault,
  onDisconnect,
  onRename,
  onStartSession,
  onSetCredential,
}: {
  title: string;
  action: React.ReactNode;
  loading: boolean;
  rows: readonly Connection[];
  emptyTitle: string;
  emptyDescription: string;
  canManageConnections: boolean;
  disabled: boolean;
  pendingConnectionId: string | null;
  onSetDefault: (connection: Connection) => void;
  onDisconnect: (connection: Connection) => void;
  onRename: (connection: Connection) => void;
  onStartSession?: (connection: Connection) => void;
  onSetCredential?: (connection: Connection) => void;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Label>{title}</Label>
        <div className="flex items-center gap-2">{action}</div>
      </div>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-md" />
          <Skeleton className="h-14 rounded-md" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState size="sm" icon={Plug} title={emptyTitle} description={emptyDescription} />
      ) : (
        <ul className="space-y-2">
          {rows.map((connection) => (
            <ConnectionRow
              key={connection.connection_id}
              connection={connection}
              isMine={connection.owner_type === 'member'}
              canManage={canManageConnections}
              pending={pendingConnectionId === connection.connection_id}
              disabled={disabled}
              onSetDefault={() => onSetDefault(connection)}
              onDisconnect={() => onDisconnect(connection)}
              onRename={() => onRename(connection)}
              onStartSession={onStartSession ? () => onStartSession(connection) : undefined}
              onSetCredential={onSetCredential ? () => onSetCredential(connection) : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every account this connector can run as, in two groups: the project's shared
 * accounts and the caller's own.
 *
 * The two are NOT alternatives. A connector is a declared capability with no
 * identity; an account is an authorized identity on it, owned by the project or
 * by one member, and a call resolves the caller's own default first and the
 * project's default second. `connectors.authorization_strategy` used to make
 * the two owner types mutually exclusive, which is what left a `user`-mode
 * connector with no connect flow anywhere — the incident this list is the fix
 * for. Connecting a SHARED account is manager-gated
 * (`PROJECT_CONNECTOR_CONNECTIONS_MANAGE`, the same right the API checks);
 * connecting your own never is.
 *
 * The API already scopes the list to the caller, so "Only you" can only ever
 * hold the caller's own rows — another member's private account is not visible
 * here and is not meant to be.
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
  /** Start a session bound to this exact account. Omitted where that is not offered. */
  onStartSession?: (connection: Connection) => void;
  disabled?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // A direct provider (openapi/http/mcp/graphql/…) has no hosted OAuth: "Add"
  // creates (or selects) the account and this then opens `SetCredentialModal`
  // for it — the same create-then-credential sequence `connector-modal.tsx`
  // runs from its header button, run here per ACCOUNT instead of per
  // connector. A managed provider (Composio/Pipedream) keeps running hosted
  // OAuth through `usePipedreamConnectProject`/`usePipedreamConnectMember`.
  const isDirectProvider = !isManagedConnectorProvider(connector.provider);
  const [addOwner, setAddOwner] = useState<ConnectionOwner | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState<Connection | null>(null);
  const [renameTarget, setRenameTarget] = useState<Connection | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [credentialTarget, setCredentialTarget] = useState<{
    connectionId: string;
    owner: ConnectionOwner;
  } | null>(null);

  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
  });
  const refresh = () => {
    void connectionsQuery.refetch();
    onChanged();
  };

  const rows = connectorConnectionRows(connectionsQuery.data?.connections, connector.slug);
  const sharedRows = rows.filter((connection) => connection.owner_type === 'project');
  const myRows = rows.filter((connection) => connection.owner_type === 'member');

  const closeAdd = () => {
    setAddOwner(null);
    setLabelDraft('');
  };
  const addProject = usePipedreamConnectProject(projectId, connector.slug, () => {
    closeAdd();
    refresh();
  });
  const addMine = usePipedreamConnectMember(projectId, connector.slug, () => {
    closeAdd();
    refresh();
  });
  const createSharedAccount = useMutation({
    mutationFn: (label: string) =>
      reconcileConnection(projectId, {
        connector_alias: connector.slug,
        owner_type: 'project',
        label,
      }),
    onSuccess: (connection) => {
      closeAdd();
      setCredentialTarget({ connectionId: connection.connection_id, owner: 'project' });
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('texta2cf78785484')),
  });
  const createOwnAccount = useMutation({
    mutationFn: (label: string) =>
      reconcileMemberConnection(projectId, { connector_alias: connector.slug, label }),
    onSuccess: (connection) => {
      closeAdd();
      setCredentialTarget({ connectionId: connection.connection_id, owner: 'me' });
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('texta2cf78785484')),
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

  const rename = useMutation({
    mutationFn: (input: { connectionId: string; label: string }) =>
      renameConnection(projectId, input.connectionId, input.label),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text499d7f6dfdfc'));
      setRenameTarget(null);
      refresh();
    },
    // The API names the refusal (a clash with another account, a reserved
    // word), so show its message rather than a generic one.
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('text11ef24ea6e15')),
  });
  const openRename = (connection: Connection) => {
    setRenameDraft(connection.label);
    setRenameTarget(connection);
  };
  const submitRename = () => {
    const label = renameDraft.trim();
    if (disabled || !renameTarget || !label) return;
    if (label === renameTarget.label) {
      setRenameTarget(null);
      return;
    }
    rename.mutate({ connectionId: renameTarget.connection_id, label });
  };

  const adding = isDirectProvider
    ? createSharedAccount.isPending || createOwnAccount.isPending
    : addProject.isPending || addMine.isPending;
  const submitAdd = () => {
    if (disabled || !addOwner || !labelDraft.trim()) return;
    if (isDirectProvider) {
      if (addOwner === 'project') createSharedAccount.mutate(labelDraft.trim());
      else createOwnAccount.mutate(labelDraft.trim());
    } else if (addOwner === 'project') {
      addProject.mutate({ label: labelDraft });
    } else {
      addMine.mutate({ label: labelDraft });
    }
  };
  const pendingConnectionId =
    setDefault.isPending && typeof setDefault.variables === 'string'
      ? setDefault.variables
      : disconnect.isPending && typeof disconnect.variables === 'string'
        ? disconnect.variables
        : rename.isPending && rename.variables
          ? rename.variables.connectionId
          : null;
  // Re-open the credential entry for an existing direct-provider account —
  // wired from the row menu ("Set credential") and reused right after
  // `createSharedAccount`/`createOwnAccount` creates a brand new one.
  const setCredential = isDirectProvider
    ? (connection: Connection) =>
        setCredentialTarget({
          connectionId: connection.connection_id,
          owner: connection.owner_type === 'project' ? 'project' : 'me',
        })
    : undefined;

  return (
    <div className="space-y-6">
      <ConnectionOwnerGroup
        title={tI18nComplete.raw('text1c22fac2a9fd')}
        action={
          canManageConnections ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAddOwner('project')}
              disabled={disabled}
            >
              <Plus className="size-4" />
              {tI18nComplete.raw('textc6309c452031')}
            </Button>
          ) : null
        }
        loading={connectionsQuery.isLoading}
        rows={sharedRows}
        emptyTitle={tI18nComplete.raw('textded4b88e52f7')}
        // A reader cannot connect a shared account, so telling them to is a
        // dead end. Name who can instead.
        emptyDescription={
          canManageConnections
            ? tI18nComplete.raw('texte6e0b4594c95')
            : tI18nComplete.raw('textea5d0ffa0962')
        }
        canManageConnections={canManageConnections}
        disabled={disabled}
        pendingConnectionId={pendingConnectionId}
        onSetCredential={setCredential}
        onSetDefault={(connection) => setDefault.mutate(connection.connection_id)}
        onDisconnect={setConfirmDisconnect}
        onRename={openRename}
        onStartSession={onStartSession}
      />

      <ConnectionOwnerGroup
        title={tI18nComplete.raw('textc080649df657')}
        action={
          <Button size="sm" variant="outline" onClick={() => setAddOwner('me')} disabled={disabled}>
            <Lock className="size-3.5 shrink-0" />
            {tI18nComplete.raw('textcbf6389cf9df')}
          </Button>
        }
        loading={connectionsQuery.isLoading}
        rows={myRows}
        emptyTitle={tI18nComplete.raw('textc3bafa5156b4')}
        emptyDescription={tI18nComplete.raw('text6533f1aa30ab')}
        canManageConnections={canManageConnections}
        disabled={disabled}
        pendingConnectionId={pendingConnectionId}
        onSetCredential={setCredential}
        onSetDefault={(connection) => setDefault.mutate(connection.connection_id)}
        onDisconnect={setConfirmDisconnect}
        onRename={openRename}
        onStartSession={onStartSession}
      />

      <Modal
        open={addOwner !== null}
        onOpenChange={(open) => {
          if (!open && !adding) closeAdd();
        }}
      >
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>
              {addOwner === 'project'
                ? tI18nComplete('textca04bb211a4b', { value0: displayName })
                : tI18nComplete('text9819d9aeec29', { value0: displayName })}
            </ModalTitle>
            <ModalDescription>
              {addOwner === 'project'
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
                    addOwner === 'project' ? tI18nComplete.raw('text945ce03ec79f') : 'Work'
                  }
                  maxLength={255}
                  autoFocus
                  disabled={adding || disabled}
                />
                <FieldDescription>{tI18nComplete.raw('text99953938d987')}</FieldDescription>
              </Field>
            </ModalBody>
            <ModalFooter className="sm:justify-between">
              <Button type="button" variant="outline-ghost" onClick={closeAdd} disabled={adding}>
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

      <Modal
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rename.isPending) setRenameTarget(null);
        }}
      >
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>
              {tI18nComplete('textbb7a240d3660', { value0: renameTarget?.label ?? '' })}
            </ModalTitle>
            <ModalDescription>{tI18nComplete.raw('text64f07c825803')}</ModalDescription>
          </ModalHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <ModalBody>
              <Field>
                <FieldLabel htmlFor="connection-rename-label">
                  {tI18nComplete.raw('textdcd1d5223f73')}
                </FieldLabel>
                <Input
                  id="connection-rename-label"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  maxLength={255}
                  autoFocus
                  disabled={rename.isPending || disabled}
                />
                {renameTarget?.connected_as ? (
                  <FieldDescription>
                    {tI18nComplete('texte9e0b20cf289', { value0: renameTarget.connected_as })}
                  </FieldDescription>
                ) : null}
              </Field>
            </ModalBody>
            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                onClick={() => setRenameTarget(null)}
                disabled={rename.isPending}
              >
                {tI18nComplete.raw('text19766ed6ccb2')}
              </Button>
              <Button type="submit" disabled={rename.isPending || disabled || !renameDraft.trim()}>
                {rename.isPending ? <Loading className="size-4 shrink-0" /> : null}
                {tI18nComplete.raw('text1509f561f241')}
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

      {isDirectProvider ? (
        <SetCredentialModal
          projectId={projectId}
          connector={credentialTarget ? connector : null}
          connectionId={credentialTarget?.connectionId ?? null}
          owner={credentialTarget?.owner ?? 'me'}
          open={credentialTarget !== null}
          onOpenChange={(open) => {
            if (!open) setCredentialTarget(null);
          }}
          onSaved={() => {
            setCredentialTarget(null);
            refresh();
          }}
        />
      ) : null}
    </div>
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
    mutationFn: async (connector: EasyConnectConnectionInput) => {
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
                {/* The first user pasted their API KEY here and then met the
                    Connect dialog asking for "the value" again — a loop with
                    no explanation (Jay, 2026-09-17). Say what the field IS,
                    and call out a pasted secret the moment it appears. */}
                {parameterNameLooksLikeSecret(draft.auth?.name ?? '') ? (
                  <FieldDescription className="text-kortix-orange">
                    {tI18nHardcoded.raw('i18nComplete.text74d49e84f16e')}
                  </FieldDescription>
                ) : (
                  <FieldDescription>
                    {tI18nHardcoded.raw('i18nComplete.textfd3f01bb8cf4')}
                  </FieldDescription>
                )}
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
  });
  const [oauth2Selected, setOauth2Selected] = useState(false);
  const [oauth2, setOauth2] = useState<OAuth2CredentialForm>(EMPTY_OAUTH2_CREDENTIAL_FORM);
  const [discoveryDraft, setDiscoveryDraft] = useState(draft);
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
    // Channel connectors have no OAuth2-at-creation offer.
    if (draft.provider === 'channel' && oauth2Selected) {
      setOauth2Selected(false);
    }
  }, [draft.provider, oauth2Selected]);

  const save = useMutation({
    mutationFn: () =>
      createConnectorWithOptionalOAuth2(projectId, draft, oauth2Selected ? oauth2 : null, {
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
          if (oauth2Selected && !oauth2CredentialFormValid(oauth2)) return;
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
            oauth2Selected={oauth2Selected}
            onOAuth2SelectedChange={setOauth2Selected}
          />
          {oauth2Selected && (
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
          {authActive && !oauth2Selected && (
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
                (oauth2Selected && !oauth2CredentialFormValid(oauth2))
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
  owner,
  open,
  onOpenChange,
  onSaved,
  shell = 'modal',
}: {
  projectId: string;
  connector: AdminConnector | null;
  connectionId: string | null;
  /** Which owner this credential is being set for. */
  owner: 'project' | 'me';
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  /**
   * Which surface hosts the dialog. `modal` floats it (the default, used by
   * legacy callers); `split` renders `SplitSheetContent` for a caller that
   * wraps its page in `<SplitSheet>` — the connector page's Connect opens as
   * an inline column instead of an overlay. One body, one footer, two shells.
   */
  shell?: 'modal' | 'split';
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // The typed `UiTranslator` the shared doc-links helper takes — the same
  // catalog `tI18nHardcoded` reads, scoped one level deeper.
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
    enabled: open && Boolean(connector) && owner === 'project',
    ...contract('config'),
  });
  const requestAuth = owner === 'me' ? connector?.requestAuthType : configQuery.data?.auth.type;
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
  // Where the pasted value COMES from — the app's developer docs (curated)
  // and the Kortix guide. A bare input assumed the user already had a token
  // in hand (Jay, 2026-09-15).
  const credentialHelpLinks = connector
    ? connectorCredentialHelpLinks(connector, tI18nComplete)
    : [];
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
  /**
   * The user explicitly asked for OAuth 2.0 on a connector whose server never
   * advertised it. Kept separate from `credentialTypeChoice` so closing the
   * modal forgets it — the next open starts from what discovery says again.
   */
  const [oauth2Requested, setOauth2Requested] = useState(false);
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
    if (owner === 'me') {
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
    queryKey: qk.project.connectorOAuth2Discovery(
      projectId,
      connector?.slug ?? '',
      oauth2DiscoveryConnectionKey(owner, connectionId),
    ),
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
    // One retry, not zero: the probe walks the server's whole metadata chain
    // (WWW-Authenticate → resource metadata → AS metadata), so one transient
    // failure anywhere in it used to silently cost the OAuth tab for the rest
    // of the open — the "sometimes there is no Connect button" report
    // (Jay, 2026-09-15). A designed 400 (no server URL) pays one extra
    // request and still lands on the static default.
    retry: 1,
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
  /**
   * Whether OAuth 2.0 is on the table AT ALL. It used to be a permanent
   * second tab on every connector — an API-key connector opened onto a
   * selector between its real credential and a grant flow its server does not
   * speak (the probe just 400s into a warning banner). Now the tab strip
   * appears only when discovery says the server actually requires OAuth
   * (`oauth2CredentialOffered`), or when the user asks for it via the escape
   * hatch under the credential field.
   */
  const showOAuth2Tabs =
    oauth2CredentialOffered(plan) || oauth2Requested || credentialTypeChoice === 'oauth2';
  const showManualOAuth2Fields =
    manualSetup || plan.kind === 'unknown' || plan.kind === 'client_id_required';
  const oauth2Valid =
    application.grant === 'client_credentials'
      ? oauth2CredentialFormValid(oauth2)
      : oauth2ApplicationFormValid(effectiveApplication);
  /**
   * The static tab names the thing the server actually wants, read off the
   * connector's declared auth shape. A generic "Credential" label is the
   * fallback, not the norm — "API key" vs "OAuth 2.0" is the distinction the
   * whole dialog exists to make.
   */
  const staticTabLabel =
    requestAuth === 'api_key'
      ? 'API key'
      : requestAuth === 'bearer'
        ? 'Bearer token'
        : requestAuth === 'basic'
          ? 'Username & password'
          : requestAuth === 'oauth1'
            ? 'OAuth 1.0 keys'
            : requestAuth === 'hmac'
              ? 'HMAC keys'
              : requestAuth === 'aws_sigv4'
                ? 'AWS keys'
                : requestAuth === 'mtls'
                  ? 'mTLS certificate'
                  : 'Credential';
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

  /** Write a static or `client_credentials` credential to the selected account. */
  const writeCredential = async (input: ConnectionCredentialInput) => {
    const target = credentialWriteTarget(owner, connectionId);
    if (target.kind === 'connector-default') {
      return setConnectorCredential(projectId, connector!.slug, input);
    }
    const targetConnectionId =
      target.kind === 'connection' ? target.connectionId : await resolveConnectionId();
    return updateConnectionCredential(projectId, targetConnectionId, input);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (credentialType === 'static') {
        return writeCredential({ value });
      }
      if (application.grant === 'client_credentials') {
        return writeCredential(buildOAuth2CredentialInput(oauth2));
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
  const handleShellOpenChange = (o: boolean) => {
    if (save.isPending) return;
    if (!o) {
      setManualSetup(false);
      setCredentialTypeChoice(null);
      setOauth2Requested(false);
    }
    onOpenChange(o);
  };
  const handleDialogSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      (credentialType === 'static' && staticValid) ||
      (credentialType === 'oauth2' && oauth2Valid)
    ) {
      save.mutate();
    }
  };
  /* Named for the outcome, not the mechanism. "Set credential <slug>" plus a
     two-tab strip left three controls in one journey all talking about
     credentials with nothing distinguishing them. The title says what
     finishing this dialog achieves; the tab labels below name the specific
     thing the server wants. */
  const dialogTitle = `Connect ${connector ? connector.name?.trim() || connector.slug : 'connector'}`;
  const dialogDescription =
    'Kortix stores what you enter encrypted and attaches it to every call. Agents and the sandbox never see it.';
  const credentialBody = (
    <Tabs
      value={credentialType}
      onValueChange={(next) => setCredentialTypeChoice(next as 'static' | 'oauth2')}
      className="gap-4"
    >
      {showOAuth2Tabs ? (
        <TabsList>
          <TabsTrigger value="static">{staticTabLabel}</TabsTrigger>
          <TabsTrigger value="oauth2">
            {tI18nHardcoded.raw('i18nComplete.textaebabad39063')}
          </TabsTrigger>
        </TabsList>
      ) : null}
      <TabsContent value="static">
        <Field>
          {/* Named for the thing the server wants ("API key", "Bearer
              token"), never the generic "Value" — beside the Connection
              form's parameter-name field, "Value" read as a duplicate ask
              (Jay, 2026-09-17). */}
          <FieldLabel htmlFor="connector-static-credential">
            {objectCredential
              ? tI18nHardcoded.raw('i18nComplete.textb8ce566177f1')
              : staticTabLabel}
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
          {objectCredential ? (
            <FieldDescription>
              {tI18nHardcoded.raw('i18nComplete.textfdf7bc860f55')} {requestAuth}{' '}
              {tI18nHardcoded.raw('i18nComplete.text41a01f64505d')}
            </FieldDescription>
          ) : (
            <FieldDescription>
              {tI18nHardcoded.raw('i18nComplete.text82a532f91165')}
            </FieldDescription>
          )}
        </Field>
        {/* Where the value comes from. The app's developer docs are where
            API keys and tokens are actually minted; the Kortix guide covers
            the pasting side. At most two links — this is a form, not a
            reading list. */}
        {credentialHelpLinks.length > 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {tI18nHardcoded.raw('i18nComplete.text7bc4d9a2803c')}{' '}
            {credentialHelpLinks.map((link, index) => (
              <span key={link.href}>
                {index > 0 ? ' · ' : null}
                {link.external ? (
                  <Link
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                ) : (
                  <Link
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                )}
              </span>
            ))}
          </p>
        ) : null}
        {/* Below the field, one quiet line about the OTHER way in. On an MCP
            connector the one-click OAuth flow is the expected path, so while
            the strip is absent the line says WHY: still checking, or the
            probe failed (with the retry that brings the option back —
            before this, a failed probe left a bare token field and no trace
            of the missing Connect button; Jay, 2026-09-15). Every other
            provider keeps only the escape hatch: for an API key, "no OAuth"
            is the designed answer, not a failure worth narrating. */}
        {!showOAuth2Tabs ? (
          connector?.provider === 'mcp' && discoveryPending ? (
            <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
              <Loading className="size-3.5 shrink-0" />
              {tI18nHardcoded.raw('i18nComplete.textb1e4036909b6')}
            </p>
          ) : connector?.provider === 'mcp' && discoveryError ? (
            <p className="text-muted-foreground mt-3 text-xs">
              {tI18nHardcoded.raw('i18nComplete.text6b05881dfe08')}{' '}
              <Button
                type="button"
                variant="text"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={() => void discoveryQuery.refetch()}
              >
                {tI18nHardcoded.raw('i18nComplete.text942087cc2d41')}
              </Button>
            </p>
          ) : (
            /* The escape hatch for the hidden tab: a server can require
               OAuth 2.0 without advertising it in any way discovery can
               see. One quiet text action instead of a permanent tab. */
            <Button
              type="button"
              variant="text"
              size="sm"
              className="text-muted-foreground mt-3 h-auto px-0 text-xs"
              onClick={() => {
                setOauth2Requested(true);
                setCredentialTypeChoice('oauth2');
              }}
            >
              {tI18nHardcoded.raw('i18nComplete.textdee89ced3d79')}
            </Button>
          )
        ) : null}
      </TabsContent>
      <TabsContent value="oauth2" className="space-y-4">
        {discoveryPending ? (
          <InfoBanner tone="neutral" title={tI18nHardcoded.raw('i18nComplete.text1ead5326bbb8')}>
            {tI18nHardcoded.raw('i18nComplete.textc9b1c409642d')}
          </InfoBanner>
        ) : plan.kind === 'no_authorization' ? (
          <InfoBanner tone="neutral" title={tI18nHardcoded.raw('i18nComplete.text24f46f717cfa')}>
            {tI18nHardcoded.raw('i18nComplete.text93bc06df8dd8')}
          </InfoBanner>
        ) : plan.kind === 'register' && !manualSetup ? (
          <div className="space-y-3">
            <InfoBanner tone="neutral" title={tI18nHardcoded.raw('i18nComplete.text477d50f7ddbf')}>
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
          <InfoBanner tone="neutral" title={tI18nHardcoded.raw('i18nComplete.textcb7c06207756')}>
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
          <InfoBanner tone="info">{tI18nHardcoded.raw('i18nComplete.text67dc9c4395f1')}</InfoBanner>
        )}
        {discoveryError && (
          <InfoBanner tone="neutral" title={tI18nHardcoded.raw('i18nComplete.textdc258e9a953b')}>
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
  );
  const footerActions = (
    <>
      <Button
        type="button"
        variant="outline-ghost"
        size="sm"
        onClick={() => handleShellOpenChange(false)}
        disabled={save.isPending}
      >
        {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
      </Button>
      <Button
        type="submit"
        size="sm"
        disabled={save.isPending || (credentialType === 'static' ? !staticValid : !oauth2Valid)}
        className="gap-1.5"
      >
        {save.isPending && <Loading className="size-4 shrink-0" />}
        {credentialType === 'oauth2' && application.grant === 'authorization_code'
          ? tI18nHardcoded.raw('i18nComplete.text0c814b60fca5')
          : credentialType === 'oauth2' && application.grant === 'device_authorization'
            ? tI18nHardcoded.raw('i18nComplete.text55e970c35216')
            : tI18nHardcoded.raw('i18nComplete.texta88c299ab989')}
      </Button>
    </>
  );

  /**
   * One-click OAuth leads (Jay's OA1 pick, 2026-09-26). When discovery says
   * the server registers Kortix itself (`plan.kind === 'register'`), the
   * panel is the connect dialog's band — the app and Kortix side by side on
   * an `aspect-[21/9]` strip (`ConnectDialogBody`) — one sentence, and one
   * primary action in the footer. The token and own-app paths stay one click
   * away as quiet links; picking either returns to the full form.
   */
  const appName = connector ? connectorDisplayName(connector) : '';
  const oneClick =
    plan.kind === 'register' &&
    !manualSetup &&
    credentialTypeChoice !== 'static' &&
    !discoveryError &&
    !discoveryPending;
  const oneClickBody = (
    <>
      <div className="bg-background border-border flex aspect-[21/9] shrink-0 items-center justify-center border-b">
        <ConnectorHandshake
          name={appName}
          iconUrl={connector?.iconUrl ?? null}
          size="xl"
          collapsible={false}
        />
      </div>
      <div className="space-y-6 px-4 py-5">
        <div className="space-y-1">
          <p className="text-foreground text-base font-medium text-balance">
            {tI18nHardcoded.raw('i18nComplete.text6aaa89f1c199')}
          </p>
          <p className="text-muted-foreground text-sm text-pretty">
            {tI18nHardcoded('i18nComplete.textdc97f4aff662', { value0: appName })}
            {plan.kind === 'register' && plan.scopes.length
              ? ` ${tI18nHardcoded('i18nComplete.text1d42883b00c1', { value0: plan.scopes.join(', ') })}`
              : ''}
          </p>
        </div>
        <div className="space-y-1.5 border-t pt-4">
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw('i18nComplete.text2ff5a35c01eb')}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => setCredentialTypeChoice('static')}
            >
              {tI18nHardcoded('i18nComplete.text14957e170611', { value0: staticTabLabel })}
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => {
                setCredentialTypeChoice('oauth2');
                setManualSetup(true);
              }}
            >
              {tI18nHardcoded.raw('i18nComplete.texte67a6ef2363e')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
  const oneClickFooter = (
    <>
      <Button
        type="button"
        variant="outline-ghost"
        size="sm"
        onClick={() => handleShellOpenChange(false)}
        disabled={autoConnect.isPending}
      >
        {tI18nHardcoded.raw('i18nComplete.text19766ed6ccb2')}
      </Button>
      <Button
        type="button"
        size="sm"
        className="gap-1.5"
        disabled={autoConnect.isPending}
        onClick={() => autoConnect.mutate()}
      >
        {autoConnect.isPending && <Loading className="size-4 shrink-0" />}
        {tI18nHardcoded('i18nComplete.text29e18e882443', { value0: appName })}
      </Button>
    </>
  );

  if (shell === 'split' && oneClick) {
    return (
      <SplitSheetContent>
        <SplitSheetHeader>
          <SplitSheetTitle>{dialogTitle}</SplitSheetTitle>
          <SplitSheetDescription>{dialogDescription}</SplitSheetDescription>
        </SplitSheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{oneClickBody}</div>
        <SplitSheetFooter className="justify-between">{oneClickFooter}</SplitSheetFooter>
      </SplitSheetContent>
    );
  }

  if (oneClick) {
    return (
      <Modal open={open} onOpenChange={handleShellOpenChange}>
        <ModalContent className="overflow-hidden p-0 lg:max-w-xl">
          <ModalHeader className="px-4 pt-4">
            <ModalTitle>{dialogTitle}</ModalTitle>
            <ModalDescription>{dialogDescription}</ModalDescription>
          </ModalHeader>
          {oneClickBody}
          <ModalFooter className="px-4 pb-4 sm:justify-between">{oneClickFooter}</ModalFooter>
        </ModalContent>
      </Modal>
    );
  }

  if (shell === 'split') {
    return (
      <SplitSheetContent>
        <SplitSheetHeader>
          <SplitSheetTitle>{dialogTitle}</SplitSheetTitle>
          <SplitSheetDescription>{dialogDescription}</SplitSheetDescription>
        </SplitSheetHeader>
        <form onSubmit={handleDialogSubmit} className="flex min-h-0 flex-1 flex-col">
          <SplitSheetBody>{credentialBody}</SplitSheetBody>
          <SplitSheetFooter className="justify-between">{footerActions}</SplitSheetFooter>
        </form>
      </SplitSheetContent>
    );
  }

  return (
    <Modal open={open} onOpenChange={handleShellOpenChange}>
      <ModalContent className="lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>{dialogTitle}</ModalTitle>
          <ModalDescription>{dialogDescription}</ModalDescription>
        </ModalHeader>
        <form onSubmit={handleDialogSubmit}>
          <ModalBody>{credentialBody}</ModalBody>
          <ModalFooter className="sm:justify-between">{footerActions}</ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
