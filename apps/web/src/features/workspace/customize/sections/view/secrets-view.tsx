'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound, MoreHorizontal, Plug, Plus, Users } from 'lucide-react';
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
import { AgentAccessPicker } from '@/features/workspace/shared/agent-access-picker';
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

type Requirement = 'required' | 'optional' | null;

/**
 * Per-key view-model for the shared/project secret. Personal ("only me")
 * overrides are retired — a secret is now project-scoped and gated by which
 * AGENTS may use it (`agentScope`: null = all agents; a list = restricted).
 */
interface SecretRow {
  name: string;
  requirement: Requirement;
  configured: boolean;
  /** null / [] = all agents; a list of agent names = restricted to those. */
  agentScope: string[] | null;
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
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: refreshSecretsAndProviders,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
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
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Access</TableHead>
                      <TableHead className="w-[52px]">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((row) => (
                      <SecretTableRow
                        key={row.name}
                        row={row}
                        canManage={canManage}
                        busy={removeShared.isPending && removeShared.variables === row.name}
                        onEdit={() => openEdit(row)}
                        onDelete={() => removeShared.mutate(row.name)}
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
  const requirementByName = new Map<string, Requirement>();
  for (const name of data.required) requirementByName.set(name, 'required');
  for (const name of data.optional) {
    if (!requirementByName.has(name)) requirementByName.set(name, 'optional');
  }

  const storedByName = new Map(data.items.map((item) => [item.name, item]));
  const seen = new Set<string>();
  const rows: SecretRow[] = [];

  const toRow = (
    name: string,
    requirement: Requirement,
    item: ProjectSecret | undefined,
  ): SecretRow => ({
    name,
    requirement,
    configured: Boolean(item?.configured),
    agentScope: item?.agent_scope ?? null,
    system: Boolean(item?.system),
    readonly: Boolean(item?.readonly),
    purpose: item?.purpose ?? null,
    canRotate: Boolean(item?.can_rotate),
    updatedAt: item?.updated_at ?? null,
  });

  // Manifest entries first (required, then optional), so the "must-set" rows
  // dominate the visual hierarchy regardless of whether they're set yet.
  for (const [name, requirement] of requirementByName) {
    rows.push(toRow(name, requirement, storedByName.get(name)));
    seen.add(name);
  }
  // Anything stored that the manifest doesn't mention.
  for (const item of data.items) {
    if (seen.has(item.name)) continue;
    rows.push(toRow(item.name, null, item));
  }
  return rows;
}

function statusLabel(row: SecretRow): string {
  if (row.system) return row.configured ? 'Managed by Kortix' : 'Not set';
  return row.configured ? 'Set' : 'Not set';
}

/** Human summary of which agents may use the secret. null/[] = all agents. */
function agentAccessLabel(scope: string[] | null): { text: string; title?: string } {
  if (!scope || scope.length === 0) return { text: 'All agents' };
  if (scope.length === 1) return { text: scope[0]!, title: scope[0]! };
  return { text: `${scope.length} agents`, title: scope.join(', ') };
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
  const access = agentAccessLabel(row.agentScope);
  const restricted = Boolean(row.agentScope && row.agentScope.length > 0);

  return (
    <TableRow
      className={cn(row.requirement === 'required' && !row.configured && 'bg-kortix-orange/[0.04]')}
    >
      <TableCell className="max-w-[180px]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <code className="text-foreground truncate font-mono text-xs">{row.name}</code>
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
      <TableCell className="text-xs">
        {row.system ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          <span
            className="text-muted-foreground inline-flex items-center gap-1.5"
            title={access.title}
          >
            {restricted ? (
              <Bot className="size-3.5 shrink-0" />
            ) : (
              <Users className="size-3.5 shrink-0" />
            )}
            {access.text}
          </span>
        )}
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
  const fixedName = row?.name ?? null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  // null = all agents; [] = "specific" chosen but none picked (invalid); list = restricted.
  const [agentScope, setAgentScope] = useState<string[] | null>(null);

  const requiresValue = !row?.configured;
  // "Specific agents" selected but nothing picked — block save (never persist []).
  const specificButEmpty = Array.isArray(agentScope) && agentScope.length === 0;

  useEffect(() => {
    if (!open) return;
    setName(row?.name ?? '');
    setValue('');
    setAgentScope(row?.agentScope ?? null);
  }, [open, row]);

  const save = useMutation({
    mutationFn: () => {
      const finalName = (fixedName ?? name).trim().toUpperCase();
      if (!SECRET_NAME_REGEX.test(finalName)) {
        throw new Error('Use A-Z, 0-9, _ only. Must start with a letter or _. Max 64 chars.');
      }
      if (requiresValue && !value.trim()) {
        throw new Error('Value is required.');
      }
      if (finalName.startsWith('KORTIX_')) {
        throw new Error('KORTIX_* names are reserved for platform variables');
      }
      if (specificButEmpty) {
        throw new Error('Pick at least one agent, or choose “All agents”.');
      }
      return upsertProjectSecret(projectId, {
        name: finalName,
        ...(value.trim() ? { value } : {}),
        agentScope,
      });
    },
    onSuccess: () => {
      successToast(`Saved ${(fixedName ?? name).trim().toUpperCase()}`);
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save secret'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    if (!fixedName && !name.trim()) return;
    save.mutate();
  }

  const title = !row ? 'Add secret' : row.configured ? `Edit ${row.name}` : `Set ${row.name}`;

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
            Injected as an environment variable into every session the chosen agents run.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit} autoComplete="off">
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <div className="border-border bg-sidebar flex flex-col overflow-hidden rounded-md border">
              <Input
                id="secret-dialog-name"
                name="kortix-secret-name"
                value={fixedName ?? name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="KEY_NAME"
                className="bg-sidebar disabled:bg-sidebar rounded-none border-none font-mono"
                autoFocus={!fixedName}
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                disabled={!!fixedName || save.isPending}
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
                autoFocus={!!fixedName}
                disabled={save.isPending}
              />
            </div>

            {row?.configured && (
              <p className="text-muted-foreground text-xs">
                Leave the value blank to change access without rotating the secret.
              </p>
            )}

            <AgentAccessPicker
              projectId={projectId}
              value={agentScope}
              onChange={setAgentScope}
              label="Which agents can use this secret"
              allDescription="Every agent in this project can use it (default)."
            />
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
              disabled={
                (!fixedName && !name.trim()) ||
                (requiresValue && !value.trim()) ||
                specificButEmpty ||
                save.isPending
              }
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
