'use client';

import { useTranslations } from 'next-intl';

import {
  KeyIcon as KeyRound,
  DotsThreeIcon as MoreHorizontal,
  PlugIcon as Plug,
  PlusIcon as Plus,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { Plus as PlusIcon } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  type ProjectSecret,
  type ProjectSecretsResponse,
  type SecretConsumer,
  type SecretDeliveryStatus,
  type SecretDeliveryStrategy,
  type SecretEgressPolicy,
  deleteProjectSecret,
  getProjectDetail,
  listConnectors,
  listProjectSecrets,
  setConnectorSecretBinding,
  setProjectSecretStrategy,
  upsertProjectSecret,
} from '@kortix/sdk';
import { refreshProjectProviderState } from '@kortix/sdk/react';
import {
  WarningIcon as DangerTriangleSolid,
  PencilSimpleIcon,
  MagnifyingGlassIcon as Search,
  TrashIcon,
} from '@phosphor-icons/react';
import {
  buildBrokerPolicy,
  canSaveSecretDelivery,
  connectorBindingChanges,
  connectorBindingOptions,
  secretDeliveryOptions,
  secretDeliveryPresentation,
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
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const queryKey = useMemo(() => ['project-secrets', projectId], [projectId]);
  const projectDetailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 30_000,
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);

  const secretsQuery = useQuery({
    queryKey,
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
  });
  const connectorsQuery = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: 10_000,
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
      openCustomize('llm-providers');
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
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={openProviderManagement}>
                <Plug className="size-4 shrink-0" />
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextConnectLLMd75427c8',
                )}
              </Button>
              <Button size="sm" variant="secondary" onClick={openCreate}>
                <PlusIcon className="size-4 shrink-0" />
                Add
              </Button>
            </div>
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
      <TableCell className="max-w-[220px]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <code className="text-foreground truncate font-mono text-xs">{row.identifier}</code>
          {distinctKey && (
            <code className="text-muted-foreground truncate font-mono text-xs">→ {row.key}</code>
          )}
          <div className="flex flex-wrap gap-1">
            {row.system && (
              <Badge variant="outline" size="xs">
                Managed
              </Badge>
            )}
            {row.requirement === 'required' && (
              <Badge variant="warning" size="xs">
                Required
              </Badge>
            )}
            {row.requirement === 'optional' && (
              <Badge variant="outline" size="xs">
                Optional
              </Badge>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[200px] text-xs font-medium whitespace-normal">
        {statusLabel(row)}
      </TableCell>
      <TableCell className="max-w-[220px] whitespace-normal">
        <div className="flex flex-col items-start gap-1">
          <Badge variant={delivery.tone} size="xs">
            {delivery.label}
          </Badge>
          {row.requiresRotation && (
            <span className="text-kortix-orange text-[11px] font-medium">Rotation required</span>
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
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  row: SecretRow | null;
  connectors: Awaited<ReturnType<typeof listConnectors>>['connectors'];
  connectorsLoading: boolean;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = row !== null;
  const [identifier, setIdentifier] = useState(row?.identifier ?? '');
  const [key, setKey] = useState(row?.key ?? '');
  const [value, setValue] = useState('');
  const [strategy, setStrategy] = useState<SecretDeliveryStrategy>(row?.strategy ?? 'runtime');
  const [brokerConsumer, setBrokerConsumer] = useState<
    'llm_gateway' | 'connector' | 'executor' | 'http_broker'
  >(
    row?.consumer === 'llm_gateway' || row?.consumer === 'connector' || row?.consumer === 'executor'
      ? row.consumer
      : 'http_broker',
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
    setBrokerConsumer(
      row?.consumer === 'llm_gateway' ||
        row?.consumer === 'connector' ||
        row?.consumer === 'executor'
        ? row.consumer
        : 'http_broker',
    );
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
      strategy === 'broker' && brokerConsumer === 'http_broker' && brokerPolicy
        ? brokerPolicy
        : undefined;
    const shouldSetStrategy =
      strategy !== (row?.strategy ?? 'runtime') ||
      nextConsumer !== (row?.consumer ?? 'sandbox') ||
      strategy === 'broker';
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
      const queryKey = ['project-secrets', projectId] as const;
      await queryClient.cancelQueries({ queryKey });
      const context = beginOptimisticProjectSecretSave(queryClient, queryKey, plan.optimistic);
      onOpenChange(false);
      return context;
    },
    onSuccess: (result, plan) => {
      if (result) {
        queryClient.setQueryData<ProjectSecretsCache>(['project-secrets', projectId], (cache) =>
          cache ? applyProjectSecretResponse(cache, result) : cache,
        );
      }
      successToast(`Saved ${plan.finalIdentifier}`);
      resetForm();
      onSaved();
      queryClient.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
    onError: (err: Error, _plan, context) => {
      rollbackOptimisticProjectSecretSave(
        queryClient,
        ['project-secrets', projectId],
        context?.previous,
      );
      onOpenChange(true);
      errorToast(err.message || 'Failed to save secret');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-connectors', projectId] });
    },
  });

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
  const deliveryOptions = secretDeliveryOptions(strategy, row?.deliveryStatus ?? 'available');
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
    selectedConnectorCount: effectiveSelectedConnectorSlugs.length,
  });

  return (
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
            The identifier selects this credential profile. The delivery policy controls where its
            value can be used.
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
                        option.disabled
                          ? `${option.description} Not available in this deployment.`
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
                      setBrokerConsumer(
                        next as 'llm_gateway' | 'connector' | 'executor' | 'http_broker',
                      )
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
                      <SelectItem
                        value="executor"
                        description="Server-side triggers and actions use the value. The sandbox receives no key."
                      >
                        Automation
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
                              option.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
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
                      Selected connectors resolve this secret on the server. The sandbox receives no
                      value.
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
                        One exact host or leading wildcard per line. Kortix denies every other host.
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
                        <FieldDescription>Exact path or one trailing /* wildcard.</FieldDescription>
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
                          Optional. Include {'{{secret}}'} where Kortix inserts the value.
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
  );
}
