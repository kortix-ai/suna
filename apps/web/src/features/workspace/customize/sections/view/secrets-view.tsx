'use client';

import { useTranslations } from 'next-intl';

import {
  AsteriskIcon as Asterisk,
  BookOpenIcon,
  CaretDownIcon,
  KeyIcon as KeyRound,
  LockSimpleIcon as Lock,
  DotsThreeIcon as MoreHorizontal,
  PlusIcon as Plus,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useCallback, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, infoToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { NewEntityMenu } from '@/features/workspace/capabilities/shared/new-entity-menu';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type ProjectSecret,
  type ProjectSecretsResponse,
  type SecretConsumer,
  type SecretDeliveryStatus,
  type SecretDeliveryStrategy,
  type SecretEgressPolicy,
  type SecretInjectionSlot,
  deleteProjectSecret,
  getProjectDetail,
  grantSecretToAgent,
  listConnectors,
  listProjectSecrets,
  setConnectorSecretBinding,
  setProjectSecretStrategy,
  upsertProjectSecret,
} from '@kortix/sdk';
import {
  contract,
  qk,
  refreshProjectProviderState,
  useFeatureFlag,
  useProjectConfig,
} from '@kortix/sdk/react';
import {
  WarningIcon as DangerTriangleSolid,
  PencilSimpleIcon,
  MagnifyingGlassIcon as Search,
  TrashIcon,
} from '@phosphor-icons/react';
import {
  type SecretDeliveryBlockedReason,
  type SecretExposure,
  agentGrantActionLabel,
  agentGrantCandidateHint,
  agentGrantConfirmation,
  agentGrantErrorMessage,
  agentGrantOutcome,
  agentGrantPlan,
  agentGrantSnippet,
  buildEnforcedPolicy,
  canSaveSecretDelivery,
  classifyNewSecret,
  connectorBindingChanges,
  connectorBindingOptions,
  defaultSecretExposure,
  enforcedEchoNotice,
  legacyInjectionDetail,
  missingAgentGrantNotice,
  secretDeliveryBlockedReason,
  secretDeliveryLegend,
  secretDeliveryPresentation,
  secretDeliverySyncWarning,
  secretDeliveryTarget,
  secretExposure,
  secretExposureOptions,
  secretUsageIsAssigned,
  shouldWarnMissingAgentGrant,
} from './secret-delivery';
import {
  type OptimisticProjectSecretInput,
  type ProjectSecretsCache,
  applyProjectSecretResponse,
  beginOptimisticProjectSecretSave,
  rollbackOptimisticProjectSecretSave,
} from './secret-optimistic-cache';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;
const IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

type Requirement = 'required' | 'optional' | null;

/**
 * A project secret is `{ identifier, key, value }` — authorization is
 * centralized on the agent grant (by identifier, in kortix.yaml); this page is
 * project-wide create/configure/value only. `identifier` is the unique handle;
 * `key` (the env var name) is NOT unique — two identifiers may share one.
 */
export interface SecretRow {
  identifier: string;
  key: string;
  requirement: Requirement;
  configured: boolean;
  system: boolean;
  readonly: boolean;
  purpose: string | null;
  canRotate: boolean;
  updatedAt: string | null;
  strategy: SecretDeliveryStrategy;
  consumer: SecretConsumer | null;
  deliveryStatus: SecretDeliveryStatus;
  egressPolicy: SecretEgressPolicy | null;
  requiresRotation: boolean;
  /** 'no_agent_grant' only when the API is certain. Null covers "unknown" too. */
  deliveryBlockedReason: SecretDeliveryBlockedReason | null;
}

type SecretSavePlan = {
  finalKey: string;
  finalIdentifier: string;
  strategy: SecretDeliveryStrategy;
  nextConsumer: SecretConsumer | null;
  value: string | undefined;
  hasValueChange: boolean;
  shouldSetStrategy: boolean;
  egressPolicy: SecretEgressPolicy | undefined;
  bindingChanges: { bind: string[]; unbind: string[] };
  optimistic: OptimisticProjectSecretInput;
};

export function SecretsView({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const { navigate } = useSettingsNav();
  const queryKey = useMemo(() => qk.project.secrets(projectId), [projectId]);
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);
  // Network-Enforced Secrets (`secrets_egress`) is experimental and off by
  // default. When off, the picker offers only Environment variable and
  // Disabled — a new secret loads its real value into the sandbox.
  const egressEnabled = useFeatureFlag(projectId, 'secrets_egress').enabled;

  const secretsQuery = useQuery({
    queryKey,
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
  });
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });

  const normalized = useMemo(() => normalizeResponse(secretsQuery.data), [secretsQuery.data]);
  // `project.secret.write` is the leaf every mutating secrets route asserts.
  // The response's `can_manage` was the coarse project-manage flag, so a custom
  // role that holds `project.secret.write` without the manager role saw a
  // read-only page, and one denied the leaf saw editable controls that 403.
  const canManage = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE).allowed === true;
  const allRows = useMemo(() => buildRows(normalized), [normalized]);

  // A legacy/enforced row keeps its "Enforce at the network" badge even with the
  // flag off, so the legend must still explain that value when one exists.
  const hasEnforcedRow = allRows.some((r) => secretExposure(r.strategy, r.consumer) === 'enforced');
  const showEnforced = egressEnabled || hasEnforcedRow;

  const missingRequired = allRows.filter((r) => r.requirement === 'required' && !r.configured);

  const [query, setQuery] = useState('');
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogRow, setDialogRow] = useState<SecretRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<SecretRow | null>(null);

  const refreshSecretsAndProviders = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
    refreshProjectProviderState(queryClient, projectId);
  }, [projectId, queryClient, queryKey]);

  const removeShared = useMutation({
    mutationFn: (identifier: string) => deleteProjectSecret(projectId, identifier),
    onSuccess: refreshSecretsAndProviders,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(
      (r) => r.identifier.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
    );
  }, [allRows, query]);

  const configure = useConfigureThread(projectId);
  const openCreate = () => {
    setDialogRow(null);
    setDialogOpen(true);
  };
  const openEdit = (row: SecretRow) => {
    setDialogRow(row);
    setDialogOpen(true);
  };
  const openProviderManagement = () => {
    if (llmGatewayEnabled) {
      navigate('llm-providers');
    } else {
      setProviderModalOpen(true);
    }
  };

  /** The list resolved. Neither header control means anything before it does. */
  const showContent = !secretsQuery.isLoading && !secretsQuery.isError;

  return (
    <CapabilityPageShell
      title="Secrets"
      /* "the real value" is exact, not hedged: an enforced secret DOES put an
         env var in the sandbox — an opaque handle under the same key
         (`apps/api/src/projects/secrets.ts`
         `env[row.key] = await input.mintHandleFor(row)`), never the
         credential. "Environment variable is the only exposure that puts a
         real value in the sandbox" is the claim the API actually guarantees
         (`deliversPlaintextToSandbox`, `apps/api/src/secrets/strategy.ts`). */
      description="Encrypted credentials this project keeps out of its repository. Access decides whether agent code can read each value — Environment variable is the only exposure that sets the real value as an environment variable in the sandbox; every other one keeps it outside."
      search={
        /* Hidden until there is a list to search, the same rule Triggers
           uses: a filter over nothing is a control that cannot do anything. */
        showContent && allRows.length > 0 ? (
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Search secrets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              variant="popover"
              size="sm"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>
        ) : undefined
      }
      action={
        /* One right-hand cluster, secondary control first, primary last —
           the pairing `SettingsTabHeader` renders for every pane with a
           `docsHref`. This page has no registry entry to declare one from,
           so the same button is written here rather than dropped. */
        <div className="flex min-w-0 items-center gap-2">
          {/* New tab: this page is often open over live work. */}
          <Button asChild variant="secondary" size="sm" className="gap-1.5">
            <Link href="/docs/project/secrets" target="_blank" rel="noreferrer">
              <BookOpenIcon className="size-3.5 shrink-0" />
              Docs
            </Link>
          </Button>
          {showContent && canManage ? (
            <NewEntityMenu
              label="New"
              pending={configure.pending}
              onChat={() => configure.start(newConfigPrompt('secret'))}
              manual={{
                description: 'Name it, paste the value, choose delivery.',
                onSelect: openCreate,
              }}
            />
          ) : null}
        </div>
      }
      /* The shell's secondary row — where Skills and Connectors put their
         scope tabs. The legend is the same kind of thing: one small control
         under the header that reframes the list below it. Collapsed it is a
         single line, so it costs the table nothing; in the content column it
         would sit between the header and the first row it explains. */
      filters={<SecretsAccessExplainer showEnforced={showEnforced} />}
    >
      <div className="space-y-4">
        {secretsQuery.isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : secretsQuery.isError ? (
          <ErrorState
            size="sm"
            title={tHardcodedUi.raw(
              'appProjectsIdCustomizeSecretsPage.line773JsxAttrTitleFailedToLoadSecrets',
            )}
            description={(secretsQuery.error as Error)?.message ?? 'Failed to load secrets'}
            action={
              <Button variant="outline" size="sm" onClick={() => secretsQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            {missingRequired.length > 0 && (
              <InfoBanner
                tone="warning"
                icon={<DangerTriangleSolid weight="fill" />}
                title={`${missingRequired.length} required ${missingRequired.length === 1 ? 'secret' : 'secrets'} not set`}
              >
                Sessions can still start, but the agent will be missing these values.
              </InfoBanner>
            )}

            {filtered.length === 0 ? (
              query.trim() ? (
                <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                  No matches for <span className="text-foreground font-mono">{query}</span>.
                </p>
              ) : (
                <EmptyState
                  icon={KeyRound}
                  size="sm"
                  title="No secrets yet"
                  description="Add one to inject it into every new session."
                  action={
                    canManage ? (
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={openCreate}>
                        <Plus className="size-3.5 shrink-0" />
                        Add secret
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <Table className="overflow-hidden rounded-md">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Identifier</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead className="w-[52px]">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => (
                    <SecretTableRow
                      key={row.identifier}
                      row={row}
                      llmGatewayEnabled={llmGatewayEnabled}
                      canManage={canManage}
                      busy={removeShared.isPending && removeShared.variables === row.identifier}
                      onEdit={() => openEdit(row)}
                      onDelete={() => setDeleteRow(row)}
                    />
                  ))}
                </TableBody>
              </Table>
            )}

            <SecretDialog
              key={dialogRow?.identifier ?? 'new'}
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              projectId={projectId}
              row={dialogRow}
              llmGatewayEnabled={llmGatewayEnabled}
              connectors={connectorsQuery.data?.connectors ?? []}
              connectorsLoading={connectorsQuery.isLoading}
              egressEnabled={egressEnabled}
              onSaved={refreshSecretsAndProviders}
            />
          </>
        )}
      </div>
      <ProjectProviderModal
        projectId={projectId}
        open={providerModalOpen}
        onOpenChange={setProviderModalOpen}
        canWrite={canManage}
      />
      <ConfirmDialog
        open={deleteRow !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRow(null);
        }}
        title="Delete secret"
        description={
          deleteRow ? `Delete ${deleteRow.identifier}? The stored value can't be recovered.` : ''
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!deleteRow) return;
          removeShared.mutate(deleteRow.identifier, {
            onSuccess: () => {
              setDeleteRow(null);
              successToast('Secret deleted');
            },
            onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not delete secret'),
          });
        }}
        isPending={removeShared.isPending}
      />
    </CapabilityPageShell>
  );
}

/**
 * What the Access column actually means, folded away until asked for.
 *
 * The page shipped with a bare Identifier / Value / Access table and no words
 * at all, so a one-word badge beside `STRIPE_API_KEY` was a label with nothing
 * behind it. Six values, and the split between them is the whole feature: the
 * first three are the exposure you choose, the last three are usages another
 * flow assigned.
 *
 * Collapsed by default, and one click from the badges it defines: six
 * definitions permanently expanded above a five-row table would be a wall of
 * text in front of the thing the page is for.
 *
 * The labels and sentences come from `secretDeliveryLegend()`, the same tables
 * that render each row's badge and each option in the dialog's picker.
 * Restating them here in JSX is how the legend and the badge start disagreeing.
 */
function SecretsAccessExplainer({ showEnforced }: { showEnforced: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    /* `w-full` because the shell's filters row is a flex line: without it the
       expanded legend shrink-wraps to its longest sentence instead of the
       column. */
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-medium transition-colors">
        <CaretDownIcon
          className={cn('size-3.5 shrink-0 transition-transform', open ? '' : '-rotate-90')}
        />
        What each Access value means
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="border-border bg-sidebar mt-2 flex flex-col gap-2.5 rounded-md border p-3">
          {secretDeliveryLegend(showEnforced).map((mode) => (
            <div key={mode.key} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="shrink-0 sm:w-44">
                <Badge variant={mode.tone} size="sm">
                  {mode.label}
                </Badge>
              </dt>
              <dd className="text-muted-foreground min-w-0 text-xs text-pretty">
                {mode.description}
              </dd>
            </div>
          ))}
          {/* Two things the list above cannot say on its own.

              First, the grant. `resolveSecretDelivery`
              (apps/api/src/secrets/strategy.ts) returns `agent_grant_unscoped`
              for EVERY strategy other than `runtime`, so the enforced,
              LLM gateway and Connector values are gated by the identical rule.
              Environment variable is the one exception, and it has to stay
              one — a project with no `agents:` block hands every environment
              secret to every agent, so a blanket "a grant is always required"
              would be false for most projects. See
              `shouldWarnMissingAgentGrant`.

              Second, the three assigned values. Their own flows write them,
              which is why the picker does not offer them. A row can therefore
              show a badge with no matching option, and that reads as a bug
              unless the page says who set it. */}
          <p className="text-muted-foreground border-border mt-0.5 border-t pt-2.5 text-xs text-pretty">
            {showEnforced ? 'The first values' : 'The first two'} are the exposure you choose.
            {showEnforced ? (
              <>
                {' '}
                <span className="text-foreground">Enforce at the network</span> reaches a session
                only when its agent lists the identifier under{' '}
                <code className="font-mono">secrets</code> in{' '}
                <code className="font-mono">kortix.yaml</code>;{' '}
                <code className="font-mono">secrets: all</code> does not count.
              </>
            ) : null}{' '}
            The last three are usages Kortix assigns —{' '}
            <span className="text-foreground">LLM gateway</span> when you connect a model provider,{' '}
            <span className="text-foreground">Connector</span> when you bind a connector,{' '}
            <span className="text-foreground">Git</span> when you connect a repository — and each is
            gated the same way; none of them can be chosen or changed here.
          </p>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Normalize whatever the API gave us into the shape we expect. We're defensive
 * about: (a) older API builds that returned a bare array, (b) malformed
 * manifests that left required/optional missing.
 */
function normalizeResponse(
  data: ProjectSecretsResponse | ProjectSecret[] | null | undefined,
): ProjectSecretsResponse {
  if (Array.isArray(data)) {
    return { items: data, required: [], optional: [] };
  }
  return {
    items: Array.isArray(data?.items) ? data!.items : [],
    required: Array.isArray(data?.required) ? data!.required : [],
    optional: Array.isArray(data?.optional) ? data!.optional : [],
    manifest_status: data?.manifest_status,
    manifest_path: data?.manifest_path,
    manifest_error: data?.manifest_error,
  };
}

export function buildRows(
  raw: ProjectSecretsResponse | ProjectSecret[] | null | undefined,
): SecretRow[] {
  const data = normalizeResponse(raw);
  const requirementByKey = new Map<string, Requirement>();
  for (const key of data.required) requirementByKey.set(key, 'required');
  for (const key of data.optional) {
    if (!requirementByKey.has(key)) requirementByKey.set(key, 'optional');
  }

  const toRow = (item: ProjectSecret, requirement: Requirement): SecretRow => ({
    identifier: item.identifier,
    key: item.name,
    requirement,
    configured: Boolean(item.configured),
    system: Boolean(item.system),
    readonly: Boolean(item.readonly),
    purpose: item.purpose ?? null,
    canRotate: Boolean(item.can_rotate),
    updatedAt: item.updated_at ?? null,
    strategy: item.strategy ?? 'runtime',
    consumer: item.consumer ?? (item.strategy === 'denied' ? null : 'sandbox'),
    deliveryStatus: item.delivery_status ?? (item.strategy === 'denied' ? 'disabled' : 'available'),
    egressPolicy: item.egress_policy ?? null,
    requiresRotation: Boolean(item.requires_rotation),
    deliveryBlockedReason: secretDeliveryBlockedReason(item),
  });

  const rows: SecretRow[] = [];
  const keysWithRows = new Set<string>();
  for (const item of data.items) {
    rows.push(toRow(item, requirementByKey.get(item.name) ?? null));
    keysWithRows.add(item.name);
  }
  // Manifest-declared keys with NO stored secret under them yet → one
  // "not set" placeholder row, keyed by the key itself (identifier === key,
  // matching what creating it would default to).
  for (const [key, requirement] of requirementByKey) {
    if (keysWithRows.has(key)) continue;
    rows.push({
      identifier: key,
      key,
      requirement,
      configured: false,
      system: false,
      readonly: false,
      purpose: null,
      canRotate: false,
      updatedAt: null,
      strategy: 'runtime',
      consumer: 'sandbox',
      deliveryStatus: 'available',
      egressPolicy: null,
      requiresRotation: false,
      deliveryBlockedReason: null,
    });
  }

  const rank = (r: SecretRow) =>
    r.requirement === 'required' ? 0 : r.requirement === 'optional' ? 1 : 2;
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) || a.key.localeCompare(b.key) || a.identifier.localeCompare(b.identifier),
  );
  return rows;
}

function statusLabel(row: SecretRow): string {
  if (row.system) return row.configured ? 'Managed by Kortix' : 'Not set';
  return row.configured ? 'Set' : 'Not set';
}

/**
 * The two marks that can sit beside a secret's identifier.
 *
 * This replaced three word-badges — `Managed`, `Required`, `Optional` — that
 * sat on their own line under the identifier. Each carried one bit and cost a
 * word, and because `Optional` rendered on every optional row, *every* row had
 * a badge. `Required` therefore marked nothing: the one state worth spotting
 * looked exactly as busy as the default.
 *
 * So `Optional` is gone rather than shortened. It is the default — a row with
 * no mark is optional, and dropping it leaves `Required` as the only thing in
 * the column, which is the entire job of the column.
 *
 * The other two become icons with a `Hint`, so they read at a glance and still
 * announce themselves to a screen reader:
 *   lock      — managed by Kortix, you cannot edit it
 *   asterisk  — required; orange while unset, muted once set, the same
 *               "required field" convention every form uses
 */
function SecretMarks({ row }: { row: SecretRow }) {
  if (!row.system && row.requirement !== 'required') return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {row.system ? (
        <Hint label="Managed by Kortix" side="top">
          <Lock
            className="text-muted-foreground size-3.5 shrink-0"
            aria-label="Managed by Kortix"
          />
        </Hint>
      ) : null}
      {row.requirement === 'required' ? (
        <Hint label={row.configured ? 'Required' : 'Required — not set'} side="top">
          <Asterisk
            className={cn(
              'size-3.5 shrink-0',
              row.configured ? 'text-muted-foreground' : 'text-kortix-orange',
            )}
            aria-label={row.configured ? 'Required' : 'Required, not set'}
          />
        </Hint>
      ) : null}
    </span>
  );
}

function SecretTableRow({
  row,
  llmGatewayEnabled,
  canManage,
  busy,
  onEdit,
  onDelete,
}: {
  row: SecretRow;
  llmGatewayEnabled: boolean;
  canManage: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const canManageShared = canManage && !row.system;
  const distinctKey = row.identifier !== row.key;
  const delivery = secretDeliveryPresentation(row.strategy, row.consumer, { llmGatewayEnabled });

  return (
    <TableRow
      className={cn(row.requirement === 'required' && !row.configured && 'bg-kortix-orange/[0.04]')}
    >
      {/* The identifier and its marks share one line — the cell used to stack
          three blocks (identifier, → key, a badge row), so a five-row table
          read as fifteen. `→ key` still gets its own muted line, but only on
          the rows where the key actually differs from the identifier. */}
      <TableCell className="max-w-[260px] align-middle">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <code className="text-foreground truncate font-mono text-xs">{row.identifier}</code>
            <SecretMarks row={row} />
          </div>
          {distinctKey && (
            <code className="text-muted-foreground truncate font-mono text-xs">→ {row.key}</code>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[160px] align-middle text-xs whitespace-nowrap">
        {statusLabel(row)}
      </TableCell>
      <TableCell className="max-w-[220px] align-middle whitespace-normal">
        <div className="flex flex-col items-start gap-1">
          <Badge variant={delivery.tone} size="sm">
            {delivery.label}
          </Badge>
          {row.requiresRotation && (
            <span className="text-kortix-orange text-[11px] font-medium">Rotation required</span>
          )}
          {shouldWarnMissingAgentGrant(row.deliveryBlockedReason, row.strategy, row.consumer) && (
            <span className="text-kortix-orange text-[11px] font-medium">No agent grant</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        {!canManageShared ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label={tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsSecretsViewJsxAttrAriaLabelda70cb1c',
                )}
              >
                {busy ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <MoreHorizontal className="size-3.5 shrink-0" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onEdit}>
                <PencilSimpleIcon className="size-3.5 shrink-0" />
                {row.configured ? 'Edit secret' : 'Set value'}
              </DropdownMenuItem>
              {row.configured && (
                <DropdownMenuItem onClick={onDelete}>
                  <TrashIcon className="size-3.5 shrink-0" />
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextDeleteSharedd7bb1731',
                  )}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * `SecretDialog` with its plumbing resolved from the project alone, for a
 * surface that is not the Secrets page — the agent editor's Secrets page
 * opens the SAME create/edit dialog from a secret card (Marko, 2026-09-03:
 * "hardcore reuse same components … same modals"). Nothing here is new
 * behavior; it is the exact reads `SecretsView` does before it mounts the
 * dialog, so the two can never drift.
 */
export function ProjectSecretDialog({
  projectId,
  row,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  /** The secret to edit, or null to create one. */
  row: SecretRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
    enabled: open,
  });
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
    enabled: open,
  });
  const egressEnabled = useFeatureFlag(projectId, 'secrets_egress').enabled;
  return (
    <SecretDialog
      key={row?.identifier ?? 'new'}
      open={open}
      onOpenChange={onOpenChange}
      projectId={projectId}
      row={row}
      llmGatewayEnabled={isLlmGatewayEnabled(projectDetailQuery.data?.project)}
      connectors={connectorsQuery.data?.connectors ?? []}
      connectorsLoading={connectorsQuery.isLoading}
      egressEnabled={egressEnabled}
      onSaved={() => {
        queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
        refreshProjectProviderState(queryClient, projectId);
        onSaved?.();
      }}
    />
  );
}

function SecretDialog({
  open,
  onOpenChange,
  projectId,
  row,
  llmGatewayEnabled,
  connectors,
  connectorsLoading,
  egressEnabled,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  row: SecretRow | null;
  llmGatewayEnabled: boolean;
  connectors: Awaited<ReturnType<typeof listConnectors>>['connectors'];
  connectorsLoading: boolean;
  egressEnabled: boolean;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const projectConfig = useProjectConfig(projectId);
  const isEdit = row !== null;
  const [identifier, setIdentifier] = useState(row?.identifier ?? '');
  const [key, setKey] = useState(row?.key ?? '');
  const [value, setValue] = useState('');
  /**
   * What the system makes of the name and value typed so far (spec §7). It is
   * recomputed on every keystroke rather than latched on blur: a user who
   * pastes an `AKIA…` value has to see the environment default and the signing
   * sentence at the moment they paste it, not after they leave the field.
   */
  const classification = useMemo(() => classifyNewSecret({ key, value }), [key, value]);
  /**
   * ONE control, one piece of state: "can your code read this value?".
   *
   * `null` means the user has not answered, so the answer follows the
   * classification as they type. Any explicit pick latches — a user who chose
   * Environment variable must not be moved off it by their next keystroke.
   */
  const [pickedExposure, setPickedExposure] = useState<SecretExposure | null>(null);
  const exposure = pickedExposure ?? defaultSecretExposure(row, classification);
  const { strategy, consumer: nextConsumer } = secretDeliveryTarget(exposure, row);
  /**
   * The LLM gateway, a connector, or the git connection owns this row's
   * usage, so the picker must not be shown at all. It writes three
   * `(strategy, consumer)` pairs and none of them is the one this row has;
   * rendering it would silently disconnect whatever assigned it.
   */
  const usageAssigned = secretUsageIsAssigned(row?.consumer);
  const [selectedConnectorSlugs, setSelectedConnectorSlugs] = useState<string[] | null>(null);
  const effectiveSelectedConnectorSlugs =
    selectedConnectorSlugs ??
    connectors
      .filter((connector) => connector.secretIdentifier === row?.identifier)
      .map((connector) => connector.slug);
  const effectiveSelectedConnectorSlugSet = new Set(effectiveSelectedConnectorSlugs);
  const currentPolicy = row?.egressPolicy;
  const storedHosts = currentPolicy?.rules.map((rule) => rule.host).join('\n') ?? '';
  /** `null` until the user edits it, so a new secret's host list follows the
   *  classification's prefill while they are still typing the key. */
  const [editedHosts, setEditedHosts] = useState<string | null>(null);
  const hosts = editedHosts ?? (row ? storedHosts : classification.hosts.join('\n'));
  /**
   * A slot this row was created with, before Kortix substituted handles in
   * place. It rides through every save untouched unless the user removes it —
   * dropping it silently would stop a working injection on an unrelated edit
   * such as a value rotation.
   */
  const [legacyInject, setLegacyInject] = useState<SecretInjectionSlot | null>(
    currentPolicy?.inject ?? null,
  );

  const resetForm = () => {
    setIdentifier(row?.identifier ?? '');
    setKey(row?.key ?? '');
    setValue('');
    setPickedExposure(null);
    setSelectedConnectorSlugs(null);
    setEditedHosts(null);
    setLegacyInject(currentPolicy?.inject ?? null);
  };

  const requiresValue = !row?.configured;
  const enforcedPolicy = buildEnforcedPolicy({
    hosts,
    legacyInject,
    backend: nextConsumer === 'http_broker' ? 'kortix_fetch' : undefined,
  });
  const needsHosts = strategy === 'egress' || nextConsumer === 'http_broker';

  const prepareSavePlan = (): SecretSavePlan => {
    const finalKey = (row?.key ?? key).trim().toUpperCase();
    const finalIdentifier = (row?.identifier ?? identifier).trim() || finalKey;
    const nextConnectorSlugs = row?.consumer === 'connector' ? effectiveSelectedConnectorSlugs : [];
    const bindingChanges = connectorBindingChanges(connectors, finalIdentifier, nextConnectorSlugs);
    if (!SECRET_NAME_REGEX.test(finalKey)) {
      throw new Error('Key: use A-Z, 0-9, _ only. Must start with a letter or _. Max 64 chars.');
    }
    if (!IDENTIFIER_REGEX.test(finalIdentifier)) {
      throw new Error('Identifier: letters, numbers, _, ., - only. Max 128 chars.');
    }
    if (requiresValue && !value.trim()) {
      throw new Error('Value is required.');
    }
    if (finalKey.startsWith('KORTIX_')) {
      throw new Error('KORTIX_* keys are reserved for platform variables');
    }
    if (strategy === 'runtime' && row?.requiresRotation && !value.trim()) {
      throw new Error('Enter a new value before making this secret readable in the sandbox.');
    }
    if (needsHosts && !enforcedPolicy) {
      throw new Error('Add at least one exact HTTPS host.');
    }
    if (row?.consumer === 'connector' && nextConnectorSlugs.length === 0) {
      throw new Error('Select at least one connector.');
    }

    const hasValueChange = Boolean(value.trim()) || !row?.configured;
    const egressPolicy = needsHosts ? (enforcedPolicy ?? undefined) : undefined;
    const shouldSetStrategy =
      strategy !== (row?.strategy ?? 'runtime') ||
      nextConsumer !== (row?.consumer ?? 'sandbox') ||
      strategy === 'broker' ||
      strategy === 'egress';
    return {
      finalKey,
      finalIdentifier,
      strategy,
      nextConsumer,
      value: value.trim() ? value : undefined,
      hasValueChange,
      shouldSetStrategy,
      egressPolicy,
      bindingChanges,
      optimistic: {
        projectId,
        identifier: finalIdentifier,
        name: finalKey,
        strategy,
        consumer: nextConsumer,
        deliveryStatus: strategy === 'denied' ? 'disabled' : 'available',
        egressPolicy: egressPolicy ?? null,
        valueChanged: Boolean(value.trim()),
      },
    };
  };

  const save = useMutation({
    mutationFn: async (plan: SecretSavePlan) => {
      const {
        finalKey,
        finalIdentifier,
        strategy,
        nextConsumer,
        value: nextValue,
        hasValueChange,
        shouldSetStrategy,
        egressPolicy,
        bindingChanges,
      } = plan;

      if (!(strategy === 'broker' && nextConsumer === 'connector')) {
        await Promise.all(
          bindingChanges.unbind.map((slug) => setConnectorSecretBinding(projectId, slug, null)),
        );
      }

      if (hasValueChange) {
        const result = await upsertProjectSecret(projectId, {
          name: finalKey,
          identifier: finalIdentifier,
          ...(nextValue ? { value: nextValue } : {}),
          strategy,
          consumer: nextConsumer,
          ...(egressPolicy ? { egress_policy: egressPolicy } : {}),
        });
        if (strategy === 'broker' && nextConsumer === 'connector') {
          await Promise.all([
            ...bindingChanges.unbind.map((slug) =>
              setConnectorSecretBinding(projectId, slug, null),
            ),
            ...bindingChanges.bind.map((slug) =>
              setConnectorSecretBinding(projectId, slug, finalIdentifier),
            ),
          ]);
        }
        return result;
      }
      if (shouldSetStrategy) {
        const result = await setProjectSecretStrategy(projectId, finalIdentifier, strategy, {
          consumer: nextConsumer,
          ...(egressPolicy ? { egress_policy: egressPolicy } : {}),
        });
        if (strategy === 'broker' && nextConsumer === 'connector') {
          await Promise.all([
            ...bindingChanges.unbind.map((slug) =>
              setConnectorSecretBinding(projectId, slug, null),
            ),
            ...bindingChanges.bind.map((slug) =>
              setConnectorSecretBinding(projectId, slug, finalIdentifier),
            ),
          ]);
        }
        return result;
      }
      return null;
    },
    onMutate: async (plan) => {
      const queryKey = qk.project.secrets(projectId);
      await queryClient.cancelQueries({ queryKey });
      const context = beginOptimisticProjectSecretSave(queryClient, queryKey, plan.optimistic);
      onOpenChange(false);
      return context;
    },
    onSuccess: (result, plan) => {
      if (result) {
        queryClient.setQueryData<ProjectSecretsCache>(qk.project.secrets(projectId), (cache) =>
          cache ? applyProjectSecretResponse(cache, result) : cache,
        );
      }
      // The write can land while the running sandboxes refuse the new policy.
      // A plain success toast would hide that split outcome.
      const syncWarning = secretDeliverySyncWarning(plan.finalIdentifier, result);
      if (syncWarning) {
        warningToast(syncWarning.message, { description: syncWarning.description });
      } else {
        successToast(`Saved ${plan.finalIdentifier}`);
      }
      resetForm();
      onSaved();
      queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    },
    onError: (err: Error, _plan, context) => {
      rollbackOptimisticProjectSecretSave(
        queryClient,
        qk.project.secrets(projectId),
        context?.previous,
      );
      onOpenChange(true);
      errorToast(err.message || 'Failed to save secret');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    },
  });

  const grantIdentifier = row?.identifier ?? '';
  const grantPlan = agentGrantPlan(projectConfig, grantIdentifier);
  const [grantAgent, setGrantAgent] = useState<string | null>(null);
  const selectedGrantAgent = grantAgent ?? grantPlan.preselected;
  const selectedGrantCandidate =
    grantPlan.candidates.find((candidate) => candidate.name === selectedGrantAgent) ?? null;
  const [grantConfirmOpen, setGrantConfirmOpen] = useState(false);

  const grant = useMutation({
    mutationFn: (agent: string) => grantSecretToAgent(projectId, grantIdentifier, agent),
    onSuccess: (result) => {
      setGrantConfirmOpen(false);
      const outcome = agentGrantOutcome(result);
      const options = outcome.description ? { description: outcome.description } : undefined;
      if (outcome.tone === 'info') infoToast(outcome.message, options);
      else successToast(outcome.message, options);
      // The block verdict is derived from the manifest the project detail
      // carries, so refreshing the secrets list alone leaves the warning up.
      queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
      onSaved();
    },
  });

  const startGrant = () => {
    if (!selectedGrantAgent || grant.isPending) return;
    if (grantPlan.adoptsGovernance) {
      setGrantConfirmOpen(true);
      return;
    }
    grant.mutate(selectedGrantAgent);
  };

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    if (!isEdit && !key.trim()) return;
    try {
      save.mutate(prepareSavePlan());
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Failed to save secret');
    }
  }

  const title = !row
    ? 'Add secret'
    : row.configured
      ? `Edit ${row.identifier}`
      : `Set ${row.identifier}`;
  const selectedDelivery = secretDeliveryPresentation(strategy, nextConsumer, {
    llmGatewayEnabled,
  });
  const bindingIdentifier = (row?.identifier ?? identifier).trim() || key.trim().toUpperCase();
  const connectorOptions = connectorBindingOptions(connectors, bindingIdentifier);
  // Offer "Enforce at the network" only when the experimental flag is on, or
  // when this row is already enforced (so a legacy secret stays readable and
  // can be moved off enforcement even after the flag is switched back off).
  const rowIsEnforced = row ? secretExposure(row.strategy, row.consumer) === 'enforced' : false;
  const exposureOptions = secretExposureOptions(egressEnabled || rowIsEnforced);
  const echoNotice = enforcedEchoNotice(hosts);
  const legacyDetail = legacyInjectionDetail(legacyInject ? currentPolicy : null);
  // The dialog keeps the row it opened with, so a completed grant clears its own
  // warning — the refetch only reaches the table behind it.
  const grantNotice =
    row &&
    shouldWarnMissingAgentGrant(row.deliveryBlockedReason, strategy, nextConsumer) &&
    !grant.isSuccess
      ? missingAgentGrantNotice(row.identifier)
      : null;
  const grantManifest = agentGrantSnippet(
    grantIdentifier,
    selectedGrantAgent,
    selectedGrantCandidate?.currentSecrets,
  );
  const grantConfirmation = agentGrantConfirmation(grantIdentifier, selectedGrantAgent ?? '');
  const selectedGrantHint = selectedGrantCandidate
    ? agentGrantCandidateHint(selectedGrantCandidate)
    : null;
  const canSave = canSaveSecretDelivery({
    isEdit,
    key,
    value,
    requiresValue,
    requiresRotation: Boolean(row?.requiresRotation),
    currentStrategy: row?.strategy ?? 'runtime',
    nextStrategy: strategy,
    nextConsumer,
    enforcedPolicyValid: enforcedPolicy !== null,
    selectedConnectorCount: effectiveSelectedConnectorSlugs.length,
  });

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (save.isPending) return;
          if (!next) resetForm();
          onOpenChange(next);
        }}
      >
        <ModalContent className="max-h-[90vh] lg:max-h-[85vh] lg:max-w-xl">
          <ModalHeader>
            <ModalTitle>{title}</ModalTitle>
            <ModalDescription>
              The identifier selects this credential. Access decides whether agent code can read the
              value, and who else may spend it.
            </ModalDescription>
          </ModalHeader>
          <form onSubmit={handleSubmit} autoComplete="off">
            <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
              <div className="border-border bg-sidebar flex flex-col overflow-hidden rounded-md border">
                <div className="flex flex-col gap-1 border-b px-3 py-2">
                  <label
                    className="text-muted-foreground text-xs font-medium"
                    htmlFor="secret-dialog-identifier"
                  >
                    Identifier
                  </label>
                  <Input
                    id="secret-dialog-identifier"
                    name="kortix-secret-identifier"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder={key ? key : 'e.g. GMAPS-primary'}
                    className="bg-sidebar disabled:bg-sidebar h-8 rounded-none border-none px-0 font-mono"
                    autoFocus={!isEdit}
                    autoComplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    disabled={isEdit || save.isPending}
                  />
                </div>
                <Input
                  id="secret-dialog-key"
                  name="kortix-secret-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                  placeholder="KEY_NAME"
                  className="bg-sidebar disabled:bg-sidebar rounded-none border-none font-mono"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  disabled={isEdit || save.isPending}
                  required
                />
                <Input
                  id="secret-dialog-value"
                  name="kortix-secret-value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="••••••••"
                  className="bg-secondary rounded-none rounded-t-sm border-none font-mono"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  autoFocus={isEdit}
                  disabled={save.isPending}
                />
              </div>

              {!isEdit && (
                <p className="text-muted-foreground text-xs">
                  Leave the identifier blank to use the key as its own identifier — the common case.
                  Set it explicitly to keep a second value under the same key (e.g. a backup key).
                </p>
              )}
              {row?.configured && (
                <p className="text-muted-foreground text-xs">
                  Leave the value blank to leave it unchanged.
                </p>
              )}

              {/* The two things the system recognized, said once, where the
                  user can act on them. Both only ever change a DEFAULT — the
                  picker below stays free. */}
              {!isEdit && classification.signingNote && (
                <InfoBanner tone="warning" title="This credential signs requests locally">
                  {classification.signingNote} Keep it in the environment so the code that computes
                  the signature can hold it.
                </InfoBanner>
              )}
              {!isEdit && classification.modelProvider && exposure === 'enforced' && (
                <InfoBanner
                  tone="neutral"
                  title={`Recognized: ${classification.modelProvider.label} key`}
                >
                  {classification.hosts.length > 0
                    ? `The approved host is prefilled with ${classification.hosts[0]}, so agent code can call ${classification.modelProvider.label} directly without ever holding the key.`
                    : `Add ${classification.modelProvider.label}'s API host below so agent code can call it directly without ever holding the key.`}{' '}
                  If the Kortix model gateway should spend it for model requests instead, connect{' '}
                  {classification.modelProvider.label} under LLM providers — one key is served by
                  one of the two, not both.
                </InfoBanner>
              )}

              <Field>
                <FieldLabel htmlFor="secret-dialog-delivery">
                  {usageAssigned ? 'Access' : 'Can your code read this value?'}
                </FieldLabel>
                {usageAssigned ? (
                  /* Read-only, because another flow assigned it. Same treatment
                     the git-connection secret always had, now covering the LLM
                     gateway and connector rows it was always true of. */
                  <div
                    id="secret-dialog-delivery"
                    className="border-border bg-sidebar rounded-md border p-3"
                  >
                    <Badge variant={selectedDelivery.tone} size="sm">
                      {selectedDelivery.label}
                    </Badge>
                    <p className="text-muted-foreground mt-2 text-xs text-pretty">
                      {selectedDelivery.description} Kortix assigned this — it cannot be changed
                      here.
                    </p>
                  </div>
                ) : (
                  <Select
                    value={exposure}
                    onValueChange={(next) => setPickedExposure(next as SecretExposure)}
                    disabled={save.isPending}
                  >
                    <SelectTrigger id="secret-dialog-delivery" className="min-h-10 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    {/* One list, three values, no second screen and no
                        grouping: every item answers the label's question. */}
                    <SelectContent>
                      {exposureOptions.map((option) => (
                        <SelectItem
                          key={option.exposure}
                          value={option.exposure}
                          description={option.description}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!usageAssigned && (
                  <FieldDescription>{selectedDelivery.description}</FieldDescription>
                )}
              </Field>

              {strategy === 'runtime' && (
                <InfoBanner tone="warning" title="Readable inside the sandbox">
                  Agent code and commands can read this value. Use this option only when the secret
                  must be available to a local process — a credential that signs requests, or a
                  protocol Kortix cannot enforce.
                </InfoBanner>
              )}

              {grantNotice && (
                <InfoBanner
                  tone="warning"
                  icon={<DangerTriangleSolid weight="fill" />}
                  title={grantNotice.title}
                  className="[&_[data-slot=alert-content]]:min-w-0"
                >
                  <span className="block text-pretty">{grantNotice.body}</span>
                  {grantPlan.candidates.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {grantPlan.candidates.length > 1 && (
                        <Select
                          value={selectedGrantAgent ?? ''}
                          onValueChange={setGrantAgent}
                          disabled={grant.isPending}
                        >
                          <SelectTrigger
                            aria-label="Agent to grant this secret to"
                            className="h-8 w-48"
                          >
                            <SelectValue placeholder="Choose an agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {grantPlan.candidates.map((candidate) => (
                              <SelectItem
                                key={candidate.name}
                                value={candidate.name}
                                description={agentGrantCandidateHint(candidate) ?? undefined}
                              >
                                {candidate.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={startGrant}
                        disabled={!selectedGrantAgent || grant.isPending}
                      >
                        {grant.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                        {agentGrantActionLabel(grantPlan, selectedGrantAgent)}
                      </Button>
                    </div>
                  )}
                  {grantPlan.candidates.length === 0 && (
                    <span className="text-muted-foreground mt-2 block text-xs text-pretty">
                      This project declares no agent. Add one to kortix.yaml first.
                    </span>
                  )}
                  {selectedGrantHint && (
                    <span className="text-muted-foreground mt-2 block text-xs text-pretty">
                      {selectedGrantHint}
                    </span>
                  )}
                  {grant.error && (
                    <span className="text-kortix-red mt-2 block text-xs text-pretty">
                      {agentGrantErrorMessage(grant.error)}
                    </span>
                  )}
                  <pre className="border-border bg-muted mt-2 overflow-x-auto rounded-sm border p-2 font-mono text-xs leading-relaxed">
                    {grantManifest}
                  </pre>
                </InfoBanner>
              )}

              {needsHosts && (
                <div className="border-border bg-sidebar space-y-4 rounded-md border p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Approved hosts</p>
                    <p className="text-muted-foreground text-xs text-pretty">
                      The sandbox holds a handle under this key. Kortix swaps the real value in
                      outside the sandbox, and only on a request to one of these hosts.
                    </p>
                  </div>

                  {/* `min-w-0` on the alert's content wrapper lets the flex
                      child shrink below the <pre>'s intrinsic (white-space: pre)
                      width, so the probe scrolls inside its own overflow-x-auto
                      box instead of forcing the whole dialog to scroll. */}
                  <InfoBanner
                    tone="neutral"
                    title={echoNotice.title}
                    className="[&_[data-slot=alert-content]]:min-w-0"
                  >
                    <span className="block text-pretty">{echoNotice.body}</span>
                    <pre className="border-border bg-muted mt-2 overflow-x-auto rounded-sm border p-2 font-mono text-xs leading-relaxed">
                      {echoNotice.probe}
                    </pre>
                    <Link
                      href={echoNotice.docsHref}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline underline-offset-2"
                    >
                      {echoNotice.docsLabel}
                    </Link>
                  </InfoBanner>

                  <Field>
                    <FieldLabel htmlFor="secret-dialog-hosts">Hosts</FieldLabel>
                    <Textarea
                      id="secret-dialog-hosts"
                      value={hosts}
                      onChange={(event) => setEditedHosts(event.target.value)}
                      placeholder={'api.example.com\nuploads.example.com'}
                      minHeight={56}
                      maxHeight={112}
                      variant="outline"
                      className="font-mono text-xs"
                      disabled={save.isPending}
                    />
                    <FieldDescription>
                      One exact HTTPS host per line. Wildcards, paths, and ports are not accepted.
                      Every other host is denied.
                    </FieldDescription>
                  </Field>

                  {/* Legacy rows only. The slot is shown, never edited: it is
                      not part of the shape a new secret can have, and hiding
                      it would leave an author unable to see why their request
                      carries a header they never configured here. */}
                  {legacyDetail && (
                    <div className="border-border bg-popover space-y-2 rounded-md border p-3">
                      <p className="text-sm font-medium">{legacyDetail.title}</p>
                      <p className="text-muted-foreground text-xs text-pretty">
                        {legacyDetail.body}
                      </p>
                      <dl className="text-muted-foreground space-y-0.5 font-mono text-xs">
                        {legacyDetail.lines.map((line) => (
                          <dd key={line}>{line}</dd>
                        ))}
                      </dl>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setLegacyInject(null)}
                        disabled={save.isPending}
                      >
                        Remove the slot
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* The connector binding keeps its own control: the usage above
                  is read-only, but WHICH connectors resolve this secret is a
                  real choice and this is where it is made. */}
              {row?.consumer === 'connector' && (
                <div className="border-border bg-sidebar space-y-4 rounded-md border p-3">
                  <Field>
                    <FieldLabel>Connectors</FieldLabel>
                    {connectorsLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-12 rounded-md" />
                        <Skeleton className="h-12 rounded-md" />
                      </div>
                    ) : connectorOptions.length === 0 ? (
                      <InfoBanner tone="neutral" title="No connectors available">
                        Add a connector that requires project-owned authentication first.
                      </InfoBanner>
                    ) : (
                      <div className="bg-popover overflow-hidden rounded-md border">
                        {connectorOptions.map((option, index) => (
                          <label
                            key={option.slug}
                            className={cn(
                              'flex min-h-12 items-center gap-3 px-3 py-2',
                              index > 0 && 'border-t',
                              option.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                            )}
                          >
                            <Checkbox
                              checked={effectiveSelectedConnectorSlugSet.has(option.slug)}
                              disabled={option.disabled || save.isPending}
                              onCheckedChange={(checked) => {
                                setSelectedConnectorSlugs((current) =>
                                  checked
                                    ? [
                                        ...new Set([
                                          ...(current ?? effectiveSelectedConnectorSlugs),
                                          option.slug,
                                        ]),
                                      ]
                                    : (current ?? effectiveSelectedConnectorSlugs).filter(
                                        (slug) => slug !== option.slug,
                                      ),
                                );
                              }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {option.name}
                              </span>
                              <span className="text-muted-foreground block text-xs text-pretty">
                                {option.description}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    <FieldDescription>
                      Selected connectors resolve this secret on the server. The sandbox receives no
                      value.
                    </FieldDescription>
                  </Field>
                </div>
              )}

              {row?.requiresRotation && (
                <InfoBanner tone="warning" title="Replace the previous value">
                  An earlier sandbox may retain the previous value. Rotate it at the provider, then
                  save the replacement here.
                </InfoBanner>
              )}
            </ModalBody>

            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => onOpenChange(false)}
                disabled={save.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="w-full sm:w-auto"
                disabled={save.isPending || !canSave}
              >
                {save.isPending && <Loading className="size-4 shrink-0" />}
                Save
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={grantConfirmOpen}
        onOpenChange={(next) => {
          if (!next && !grant.isPending) setGrantConfirmOpen(false);
        }}
        title={grantConfirmation.title}
        description={grantConfirmation.body}
        confirmLabel={grantConfirmation.confirmLabel}
        onConfirm={() => {
          if (selectedGrantAgent) grant.mutate(selectedGrantAgent);
        }}
        isPending={grant.isPending}
      />
    </>
  );
}
