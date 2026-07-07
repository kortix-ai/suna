'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Plug, Plus } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  type ProjectSecret,
  type ProjectSecretsResponse,
  deleteProjectSecret,
  getProjectDetail,
  listProjectSecrets,
  upsertProjectSecret,
} from '@kortix/sdk/projects-client';
import { DangerTriangleSolid, Pencil, Search, TrashSolid } from '@mynaui/icons-react';

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
}

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

  const normalized = useMemo(() => normalizeResponse(secretsQuery.data), [secretsQuery.data]);
  const canManage = normalized.can_manage ?? false;
  const allRows = useMemo(() => buildRows(normalized), [normalized]);

  const missingRequired = allRows.filter((r) => r.requirement === 'required' && !r.configured);

  const [query, setQuery] = useState('');
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogRow, setDialogRow] = useState<SecretRow | null>(null);

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
        title={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line104JsxTextProjectSecrets')}
        description={tHardcodedUi.raw(
          'appProjectsIdCustomizeSecretsPage.line106JsxTextKeyValuePairsInjectedAsEnvironmentVariablesInto',
        )}
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
                <Icon.Plus className="size-4 shrink-0" />
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
                  icon={DangerTriangleSolid}
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
                      <TableHead>Status</TableHead>
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
                        onDelete={() => removeShared.mutate(row.identifier)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}

              <SecretDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                projectId={projectId}
                row={dialogRow}
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
    });
  }

  const rank = (r: SecretRow) => (r.requirement === 'required' ? 0 : r.requirement === 'optional' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key) || a.identifier.localeCompare(b.identifier));
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
                  <Loading className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <MoreHorizontal className="size-3.5 shrink-0" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-3.5 shrink-0" />
                {row.configured ? 'Edit secret' : 'Set value'}
              </DropdownMenuItem>
              {row.configured && (
                <DropdownMenuItem onClick={onDelete} variant="destructive">
                  <TrashSolid className="size-3.5 shrink-0" />
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
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  row: SecretRow | null;
  onSaved: () => void;
}) {
  const isEdit = row !== null;
  const [identifier, setIdentifier] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const requiresValue = !row?.configured;

  useEffect(() => {
    if (!open) return;
    setIdentifier(row?.identifier ?? '');
    setKey(row?.key ?? '');
    setValue('');
  }, [open, row]);

  const save = useMutation({
    mutationFn: () => {
      const finalKey = (row?.key ?? key).trim().toUpperCase();
      const finalIdentifier = (row?.identifier ?? identifier).trim() || finalKey;
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
      return upsertProjectSecret(projectId, {
        name: finalKey,
        identifier: finalIdentifier,
        ...(value.trim() ? { value } : {}),
      });
    },
    onSuccess: () => {
      successToast(`Saved ${(row?.identifier ?? identifier).trim() || (row?.key ?? key).trim().toUpperCase()}`);
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save secret'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    if (!isEdit && !key.trim()) return;
    save.mutate();
  }

  const title = !row ? 'Add secret' : row.configured ? `Edit ${row.identifier}` : `Set ${row.identifier}`;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        onOpenChange(next);
      }}
    >
      <ModalContent className="max-h-[90vh] lg:max-h-[85vh] lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          <ModalDescription>
            {isEdit
              ? 'Injected as an environment variable into every session the granted agents run.'
              : 'A profile-like secret: an identifier agents grant, a key injected as an env var, and a value.'}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit} autoComplete="off">
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <div className="border-border bg-sidebar flex flex-col overflow-hidden rounded-md border">
              <div className="flex flex-col gap-1 border-b px-3 py-2">
                <label className="text-muted-foreground text-xs font-medium" htmlFor="secret-dialog-identifier">
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
                Leave the identifier blank to use the key as its own identifier — the common case. Set
                it explicitly to keep a second value under the same key (e.g. a backup key).
              </p>
            )}
            {row?.configured && (
              <p className="text-muted-foreground text-xs">
                Leave the value blank to leave it unchanged.
              </p>
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
              disabled={(!isEdit && !key.trim()) || (requiresValue && !value.trim()) || save.isPending}
            >
              {save.isPending && <Loading className="size-4 shrink-0 animate-spin" />}
              Save
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
