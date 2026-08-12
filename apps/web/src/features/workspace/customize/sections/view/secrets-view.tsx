'use client';

import { useTranslations } from 'next-intl';

import {
  AsteriskIcon as Asterisk,
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
import { Plus as PlusIcon } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { cn } from '@/lib/utils';
import {
  type ProjectSecret,
  type ProjectSecretsResponse,
  type SecretConsumer,
  type SecretDeliveryStatus,
  type SecretDeliveryStrategy,
  type SecretEgressPolicy,
  deleteProjectSecret,
  getProjectDetail,
  grantSecretToAgent,
  listConnectors,
  listProjectSecrets,
  setConnectorSecretBinding,
  setProjectSecretStrategy,
  upsertProjectSecret,
} from '@kortix/sdk';
import { contract, qk, refreshProjectProviderState, useProjectConfig } from '@kortix/sdk/react';
import {
  WarningIcon as DangerTriangleSolid,
  PencilSimpleIcon,
  MagnifyingGlassIcon as Search,
  TrashIcon,
} from '@phosphor-icons/react';
import {
  type NetworkBoundaryAvailability,
  type SecretDeliveryBlockedReason,
  agentGrantActionLabel,
  agentGrantCandidateHint,
  agentGrantConfirmation,
  agentGrantErrorMessage,
  agentGrantOutcome,
  agentGrantPlan,
  agentGrantSnippet,
  brokerConsumerForSecret,
  buildBrokerPolicy,
  buildNetworkBoundaryPolicy,
  canSaveSecretDelivery,
  connectorBindingChanges,
  connectorBindingOptions,
  missingAgentGrantNotice,
  networkBoundaryAvailability,
  networkBoundaryBlockedReason,
  networkBoundaryEchoNotice,
  secretDeliveryBlockedReason,
  secretDeliveryOptions,
  secretDeliveryPresentation,
  secretDeliverySyncWarning,
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
interface SecretRow {
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
  const networkBoundary = networkBoundaryAvailability(projectDetailQuery.data?.project);

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
  const canManage = normalized.can_manage ?? false;
  const allRows = useMemo(() => buildRows(normalized), [normalized]);

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

  return (
    <>
      <CustomizeSectionWrapper
        title="Secrets"
        description="Store encrypted values and control where each value can be used."
        action={
          !secretsQuery.isLoading && !secretsQuery.isError && canManage ? (
            <Button size="sm" variant="secondary" onClick={openCreate}>
              <PlusIcon className="size-4 shrink-0" />
              AddS
            </Button>
          ) : null
        }
      >
        <div className="space-y-4">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Search secrets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              variant="popover"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>

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
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={openCreate}
                        >
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
                connectors={connectorsQuery.data?.connectors ?? []}
                connectorsLoading={connectorsQuery.isLoading}
                networkBoundary={networkBoundary}
                onSaved={refreshSecretsAndProviders}
              />
            </>
          )}
        </div>
      </CustomizeSectionWrapper>
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
    </>
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
    can_manage: data?.can_manage,
    manifest_status: data?.manifest_status,
    manifest_path: data?.manifest_path,
    manifest_error: data?.manifest_error,
  };
}

function buildRows(raw: ProjectSecretsResponse | ProjectSecret[] | null | undefined): SecretRow[] {
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
  canManage,
  busy,
  onEdit,
  onDelete,
}: {
  row: SecretRow;
  canManage: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const canManageShared = canManage && !row.system;
  const distinctKey = row.identifier !== row.key;
  const delivery = secretDeliveryPresentation(row.strategy, row.consumer);

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
          {shouldWarnMissingAgentGrant(row.deliveryBlockedReason, row.strategy) && (
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

function SecretDialog({
  open,
  onOpenChange,
  projectId,
  row,
  connectors,
  connectorsLoading,
  networkBoundary,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  row: SecretRow | null;
  connectors: Awaited<ReturnType<typeof listConnectors>>['connectors'];
  connectorsLoading: boolean;
  networkBoundary: NetworkBoundaryAvailability;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const projectConfig = useProjectConfig(projectId);
  const isEdit = row !== null;
  const [identifier, setIdentifier] = useState(row?.identifier ?? '');
  const [key, setKey] = useState(row?.key ?? '');
  const [value, setValue] = useState('');
  const [strategy, setStrategy] = useState<SecretDeliveryStrategy>(row?.strategy ?? 'runtime');
  const [brokerConsumer, setBrokerConsumer] = useState(() =>
    brokerConsumerForSecret(row?.consumer),
  );
  const [selectedConnectorSlugs, setSelectedConnectorSlugs] = useState<string[] | null>(null);
  const effectiveSelectedConnectorSlugs =
    selectedConnectorSlugs ??
    connectors
      .filter((connector) => connector.secretIdentifier === row?.identifier)
      .map((connector) => connector.slug);
  const currentPolicy = row?.egressPolicy;
  const currentInjection = currentPolicy?.inject;
  const [brokerHosts, setBrokerHosts] = useState(
    currentPolicy?.rules.map((rule) => rule.host).join('\n') ?? '',
  );
  const [brokerMethods, setBrokerMethods] = useState(
    currentPolicy?.rules[0]?.methods?.join(', ') ?? 'POST',
  );
  const [brokerPath, setBrokerPath] = useState(currentPolicy?.rules[0]?.path ?? '/');
  const [injectionKind, setInjectionKind] = useState<'header' | 'query' | 'json_body_field'>(
    currentInjection?.kind ?? 'header',
  );
  const [injectionTarget, setInjectionTarget] = useState(
    currentInjection?.kind === 'json_body_field'
      ? currentInjection.path
      : (currentInjection?.name ?? 'authorization'),
  );
  const [injectionTemplate, setInjectionTemplate] = useState(
    currentInjection?.kind === 'header' ? (currentInjection.template ?? '') : '',
  );

  const resetForm = () => {
    setIdentifier(row?.identifier ?? '');
    setKey(row?.key ?? '');
    setValue('');
    setStrategy(row?.strategy ?? 'runtime');
    setBrokerConsumer(brokerConsumerForSecret(row?.consumer));
    setSelectedConnectorSlugs(null);
    setBrokerHosts(currentPolicy?.rules.map((rule) => rule.host).join('\n') ?? '');
    setBrokerMethods(currentPolicy?.rules[0]?.methods?.join(', ') ?? 'POST');
    setBrokerPath(currentPolicy?.rules[0]?.path ?? '/');
    setInjectionKind(currentInjection?.kind ?? 'header');
    setInjectionTarget(
      currentInjection?.kind === 'json_body_field'
        ? currentInjection.path
        : (currentInjection?.name ?? 'authorization'),
    );
    setInjectionTemplate(
      currentInjection?.kind === 'header' ? (currentInjection.template ?? '') : '',
    );
  };

  const requiresValue = !row?.configured;
  const brokerPolicy = buildBrokerPolicy({
    hosts: brokerHosts,
    methods: brokerMethods,
    path: brokerPath,
    injectionKind,
    injectionTarget,
    template: injectionTemplate,
  });
  const networkBoundaryPolicy = buildNetworkBoundaryPolicy({
    hosts: brokerHosts,
    injectionTarget,
    template: injectionTemplate,
  });

  const prepareSavePlan = (): SecretSavePlan => {
    const finalKey = (row?.key ?? key).trim().toUpperCase();
    const finalIdentifier = (row?.identifier ?? identifier).trim() || finalKey;
    const nextConnectorSlugs =
      strategy === 'broker' && brokerConsumer === 'connector'
        ? effectiveSelectedConnectorSlugs
        : [];
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
    if (strategy === 'broker' && brokerConsumer === 'http_broker' && !brokerPolicy) {
      throw new Error('Complete the broker destination and credential placement.');
    }
    if (strategy === 'egress' && !networkBoundaryPolicy) {
      throw new Error('Add an exact HTTPS host and a valid header placement.');
    }
    if (
      strategy === 'broker' &&
      brokerConsumer === 'connector' &&
      nextConnectorSlugs.length === 0
    ) {
      throw new Error('Select at least one connector.');
    }

    const nextConsumer: SecretConsumer | null =
      strategy === 'runtime'
        ? 'sandbox'
        : strategy === 'denied'
          ? null
          : strategy === 'egress'
            ? 'network'
            : brokerConsumer;
    const hasValueChange = Boolean(value.trim()) || !row?.configured;
    const egressPolicy =
      strategy === 'egress'
        ? (networkBoundaryPolicy ?? undefined)
        : strategy === 'broker' && brokerConsumer === 'http_broker' && brokerPolicy
          ? brokerPolicy
          : undefined;
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
  const selectedDelivery = secretDeliveryPresentation(
    strategy,
    strategy === 'broker' ? brokerConsumer : undefined,
  );
  const bindingIdentifier = (row?.identifier ?? identifier).trim() || key.trim().toUpperCase();
  const connectorOptions = connectorBindingOptions(connectors, bindingIdentifier);
  const deliveryOptions = secretDeliveryOptions(
    strategy,
    row?.deliveryStatus ?? 'available',
    networkBoundary,
  );
  const networkBoundaryNotice = networkBoundaryBlockedReason(networkBoundary);
  const echoNotice = networkBoundaryEchoNotice(brokerHosts);
  // The dialog keeps the row it opened with, so a completed grant clears its own
  // warning — the refetch only reaches the table behind it.
  const grantNotice =
    row && shouldWarnMissingAgentGrant(row.deliveryBlockedReason, strategy) && !grant.isSuccess
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
    nextConsumer:
      strategy === 'runtime'
        ? 'sandbox'
        : strategy === 'denied'
          ? null
          : strategy === 'egress'
            ? 'network'
            : brokerConsumer,
    brokerPolicyValid: brokerPolicy !== null,
    networkBoundaryPolicyValid: networkBoundaryPolicy !== null,
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
              The identifier selects this credential. The delivery policy controls where its value
              can be used.
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

              <Field>
                <FieldLabel htmlFor="secret-dialog-delivery">Delivery</FieldLabel>
                <Select
                  value={strategy}
                  onValueChange={(next) => setStrategy(next as SecretDeliveryStrategy)}
                  disabled={save.isPending}
                >
                  <SelectTrigger id="secret-dialog-delivery" className="min-h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {deliveryOptions.map((option) => (
                      <SelectItem
                        key={option.strategy}
                        value={option.strategy}
                        disabled={option.disabled}
                        description={
                          option.disabledReason
                            ? `${option.description} ${option.disabledReason}`
                            : option.description
                        }
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{selectedDelivery.description}</FieldDescription>
              </Field>

              {strategy === 'runtime' && (
                <InfoBanner tone="warning" title="Readable inside the sandbox">
                  Agent code and commands can read this value. Use this option only when the secret
                  must be available to a local process.
                </InfoBanner>
              )}

              {grantNotice && (
                <InfoBanner
                  tone="warning"
                  icon={<DangerTriangleSolid weight="fill" />}
                  title={grantNotice.title}
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

              {strategy === 'egress' && (
                <div className="border-border bg-sidebar space-y-4 rounded-md border p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Network boundary</p>
                    <p className="text-muted-foreground text-xs text-pretty">
                      Platinum adds this value to matching HTTPS requests outside the sandbox.
                    </p>
                  </div>

                  {networkBoundaryNotice && (
                    <InfoBanner
                      tone="warning"
                      icon={<DangerTriangleSolid weight="fill" />}
                      title="Nothing injects this header today"
                    >
                      {networkBoundaryNotice}
                    </InfoBanner>
                  )}

                  <InfoBanner tone="neutral" title="Not readable inside the sandbox">
                    The sandbox receives no value, alias, or placeholder. The agent sends an
                    ordinary request and the header appears in flight.
                  </InfoBanner>

                  <InfoBanner tone="neutral" title={echoNotice.title}>
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
                    <FieldLabel htmlFor="secret-dialog-boundary-hosts">Allowed hosts</FieldLabel>
                    <Textarea
                      id="secret-dialog-boundary-hosts"
                      value={brokerHosts}
                      onChange={(event) => setBrokerHosts(event.target.value)}
                      placeholder={'api.example.com\nuploads.example.com'}
                      minHeight={56}
                      maxHeight={112}
                      variant="outline"
                      className="font-mono text-xs"
                      disabled={save.isPending}
                    />
                    <FieldDescription>
                      One exact HTTPS host per line. Wildcards, paths, and ports are not accepted.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="secret-dialog-boundary-header">Header name</FieldLabel>
                    <Input
                      id="secret-dialog-boundary-header"
                      value={injectionTarget}
                      onChange={(event) => setInjectionTarget(event.target.value)}
                      placeholder="authorization"
                      className="font-mono text-xs"
                      disabled={save.isPending}
                    />
                    <FieldDescription>
                      Platinum replaces this header only for the allowed hosts.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="secret-dialog-boundary-template">
                      Header value template
                    </FieldLabel>
                    <Input
                      id="secret-dialog-boundary-template"
                      value={injectionTemplate}
                      onChange={(event) => setInjectionTemplate(event.target.value)}
                      placeholder="Bearer {{secret}}"
                      className="font-mono text-xs"
                      disabled={save.isPending}
                    />
                    <FieldDescription>
                      Optional. Include {'{{secret}}'} where Platinum inserts the value. Leave it
                      blank and the header carries the bare value with no scheme, which most APIs
                      reject with 401.
                    </FieldDescription>
                  </Field>
                </div>
              )}

              {strategy === 'broker' && (
                <div className="border-border bg-sidebar space-y-4 rounded-md border p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Kortix service</p>
                    <p className="text-muted-foreground text-xs">
                      The selected service uses the value outside the sandbox.
                    </p>
                  </div>

                  <Field>
                    <FieldLabel htmlFor="secret-dialog-broker-consumer">Used by</FieldLabel>
                    <Select
                      value={brokerConsumer}
                      onValueChange={(next) =>
                        setBrokerConsumer(next as 'llm_gateway' | 'connector' | 'http_broker')
                      }
                      disabled={save.isPending}
                    >
                      <SelectTrigger id="secret-dialog-broker-consumer" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          value="llm_gateway"
                          description="Kortix sends model requests. The sandbox receives no key."
                        >
                          LLM gateway
                        </SelectItem>
                        <SelectItem
                          value="http_broker"
                          description="Kortix adds the value to one approved HTTPS destination."
                        >
                          HTTPS broker
                        </SelectItem>
                        <SelectItem
                          value="connector"
                          description="An authorized connector uses the value. The sandbox receives no key."
                        >
                          Connector
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  {brokerConsumer === 'connector' && (
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
                                option.disabled
                                  ? 'cursor-not-allowed opacity-60'
                                  : 'cursor-pointer',
                              )}
                            >
                              <Checkbox
                                checked={effectiveSelectedConnectorSlugs.includes(option.slug)}
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
                        Selected connectors resolve this secret on the server. The sandbox receives
                        no value.
                      </FieldDescription>
                    </Field>
                  )}

                  {brokerConsumer === 'http_broker' && (
                    <>
                      <InfoBanner tone="neutral" title="Opaque sandbox handle">
                        The sandbox receives a session handle. Kortix adds the real value only to a
                        matching HTTPS request.
                      </InfoBanner>

                      <Field>
                        <FieldLabel htmlFor="secret-dialog-broker-hosts">Allowed hosts</FieldLabel>
                        <Textarea
                          id="secret-dialog-broker-hosts"
                          value={brokerHosts}
                          onChange={(event) => setBrokerHosts(event.target.value)}
                          placeholder={'api.example.com\n*.service.example.com'}
                          minHeight={56}
                          maxHeight={112}
                          variant="outline"
                          className="font-mono text-xs"
                          disabled={save.isPending}
                        />
                        <FieldDescription>
                          One exact host or leading wildcard per line. Kortix denies every other
                          host.
                        </FieldDescription>
                      </Field>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="secret-dialog-broker-methods">Methods</FieldLabel>
                          <Input
                            id="secret-dialog-broker-methods"
                            value={brokerMethods}
                            onChange={(event) => setBrokerMethods(event.target.value.toUpperCase())}
                            placeholder="POST"
                            className="font-mono text-xs"
                            disabled={save.isPending}
                          />
                          <FieldDescription>
                            Comma-separated. Blank allows any method.
                          </FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="secret-dialog-broker-path">Path</FieldLabel>
                          <Input
                            id="secret-dialog-broker-path"
                            value={brokerPath}
                            onChange={(event) => setBrokerPath(event.target.value)}
                            placeholder="/v1/*"
                            className="font-mono text-xs"
                            disabled={save.isPending}
                          />
                          <FieldDescription>
                            Exact path or one trailing /* wildcard.
                          </FieldDescription>
                        </Field>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="secret-dialog-injection-kind">
                            Credential location
                          </FieldLabel>
                          <Select
                            value={injectionKind}
                            onValueChange={(next) =>
                              setInjectionKind(next as 'header' | 'query' | 'json_body_field')
                            }
                            disabled={save.isPending}
                          >
                            <SelectTrigger id="secret-dialog-injection-kind" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="header">Header</SelectItem>
                              <SelectItem value="query">Query parameter</SelectItem>
                              <SelectItem value="json_body_field">JSON body field</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="secret-dialog-injection-target">
                            {injectionKind === 'header'
                              ? 'Header name'
                              : injectionKind === 'query'
                                ? 'Parameter name'
                                : 'JSON field path'}
                          </FieldLabel>
                          <Input
                            id="secret-dialog-injection-target"
                            value={injectionTarget}
                            onChange={(event) => setInjectionTarget(event.target.value)}
                            placeholder={
                              injectionKind === 'header'
                                ? 'authorization'
                                : injectionKind === 'query'
                                  ? 'api_key'
                                  : 'auth.api_key'
                            }
                            className="font-mono text-xs"
                            disabled={save.isPending}
                          />
                        </Field>
                      </div>

                      {injectionKind === 'header' && (
                        <Field>
                          <FieldLabel htmlFor="secret-dialog-injection-template">
                            Header value template
                          </FieldLabel>
                          <Input
                            id="secret-dialog-injection-template"
                            value={injectionTemplate}
                            onChange={(event) => setInjectionTemplate(event.target.value)}
                            placeholder="Bearer {{secret}}"
                            className="font-mono text-xs"
                            disabled={save.isPending}
                          />
                          <FieldDescription>
                            Optional. Include {'{{secret}}'} where Kortix inserts the value. Leave
                            it blank and the header carries the bare value with no scheme, which
                            most APIs reject with 401.
                          </FieldDescription>
                        </Field>
                      )}
                    </>
                  )}
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
