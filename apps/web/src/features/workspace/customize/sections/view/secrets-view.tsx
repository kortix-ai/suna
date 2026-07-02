'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Plug, Plus } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import {
  SharingPicker,
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/features/workspace/shared/sharing-picker';
import {
  deletePersonalProjectSecret,
  deleteProjectSecret,
  getProjectDetail,
  listProjectSecrets,
  setPersonalProjectSecret,
  upsertProjectSecret,
  type ConnectorSharing,
  type ProjectSecret,
  type ProjectSecretsResponse,
} from '@kortix/sdk/projects-client';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  DangerTriangleSolid,
  LockSolid,
  Pencil,
  Search,
  TrashSolid,
  UserSolid,
  UsersSolid,
} from '@mynaui/icons-react';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;

type Requirement = 'required' | 'optional' | null;

/**
 * Merged per-key view-model: the shared/project row (what managers control +
 * who it's shared with) + the viewer's own override + which one wins for them.
 */
interface SecretRow {
  name: string;
  requirement: Requirement;
  // Shared/project row.
  sharedConfigured: boolean;
  shareScope: 'project' | 'restricted';
  sharing: ConnectorSharing | null;
  usableByMe: boolean;
  // The viewer's private override.
  mine: { active: boolean } | null;
  // What actually runs in the viewer's sessions for this key.
  effectiveSource: 'mine' | 'shared' | 'none';
  // Kortix-managed (git auth etc.).
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

  const missingRequired = allRows.filter(
    (r) => r.requirement === 'required' && r.effectiveSource === 'none',
  );

  const [query, setQuery] = useState('');
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [sharedDialogOpen, setSharedDialogOpen] = useState(false);
  const [sharedDialogRow, setSharedDialogRow] = useState<SecretRow | null>(null);
  const [personalDialog, setPersonalDialog] = useState<{ open: boolean; row: SecretRow | null }>({
    open: false,
    row: null,
  });

  const refreshSecretsAndProviders = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
    refreshProjectProviderState(queryClient, projectId);
  }, [projectId, queryClient, queryKey]);

  const removeShared = useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: refreshSecretsAndProviders,
  });
  const removeMine = useMutation({
    mutationFn: (name: string) => deletePersonalProjectSecret(projectId, name),
    onSuccess: refreshSecretsAndProviders,
  });
  const setSource = useMutation({
    mutationFn: ({ name, active }: { name: string; active: boolean }) =>
      setPersonalProjectSecret(projectId, name, { active }),
    onSuccess: refreshSecretsAndProviders,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [allRows, query]);

  const openSharedCreate = () => {
    setSharedDialogRow(null);
    setSharedDialogOpen(true);
  };
  const openSharedEdit = (row: SecretRow) => {
    setSharedDialogRow(row);
    setSharedDialogOpen(true);
  };
  const openProviderManagement = () => {
    if (llmGatewayEnabled) {
      openCustomize('llm-providers');
    } else {
      setProviderModalOpen(true);
    }
  };

  const chooseSource = useCallback(
    (row: SecretRow, source: 'shared' | 'mine') => {
      if (source === 'mine') {
        if (row.mine) {
          if (!row.mine.active) setSource.mutate({ name: row.name, active: true });
        } else {
          setPersonalDialog({ open: true, row });
        }
      } else if (row.mine?.active) {
        setSource.mutate({ name: row.name, active: false });
      }
    },
    [setSource],
  );

  return (
    <>
      <CustomizeSectionWrapper
        // className="max-w-3xl"
        title={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line104JsxTextProjectSecrets')}
        description={tHardcodedUi.raw(
          'appProjectsIdCustomizeSecretsPage.line106JsxTextKeyValuePairsInjectedAsEnvironmentVariablesInto',
        )}
        action={
          !secretsQuery.isLoading && !secretsQuery.isError ? (
            <div className="flex items-center gap-1.5">
              {canManage && (
                <Button size="sm" variant="outline" onClick={openProviderManagement}>
                  <Plug className="size-4 shrink-0" />
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextConnectLLMd75427c8',
                  )}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={
                  canManage ? openSharedCreate : () => setPersonalDialog({ open: true, row: null })
                }
              >
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
                  title={`${missingRequired.length} required ${missingRequired.length === 1 ? 'secret' : 'secrets'} not set for you`}
                >
                  {tHardcodedUi.raw(
                    'appProjectsIdCustomizeSecretsPage.line278JsxTextSessionsCanStillStartButTheAgentWill',
                  )}
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={
                          canManage
                            ? openSharedCreate
                            : () => setPersonalDialog({ open: true, row: null })
                        }
                      >
                        <Plus className="size-3.5 shrink-0" />
                        Add secret
                      </Button>
                    }
                  />
                )
              ) : (
                <Table className="overflow-hidden rounded-md">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Source</TableHead>
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
                        busy={
                          (setSource.isPending && setSource.variables?.name === row.name) ||
                          (removeMine.isPending && removeMine.variables === row.name) ||
                          (removeShared.isPending && removeShared.variables === row.name)
                        }
                        onChooseSource={chooseSource}
                        onEditShared={() => openSharedEdit(row)}
                        onDeleteShared={() => removeShared.mutate(row.name)}
                        onEditMine={() => setPersonalDialog({ open: true, row })}
                        onRemoveMine={() => removeMine.mutate(row.name)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}

              <SecretDialog
                open={sharedDialogOpen}
                onOpenChange={setSharedDialogOpen}
                projectId={projectId}
                row={sharedDialogRow}
                onSaved={refreshSecretsAndProviders}
              />
              <PersonalSecretDialog
                open={personalDialog.open}
                row={personalDialog.row}
                projectId={projectId}
                onClose={() => setPersonalDialog({ open: false, row: null })}
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
    sharedConfigured: Boolean(item?.configured),
    shareScope: item?.share_scope ?? 'project',
    sharing: item?.sharing ?? null,
    usableByMe: Boolean(item?.usable_by_me),
    mine: item?.mine ?? null,
    effectiveSource: item?.effective_source ?? 'none',
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

function sharingScopeLabel(sharing: ConnectorSharing | null): string | null {
  if (!sharing || sharing.mode === 'project') return null;
  return sharing.mode === 'private' ? 'Owner only' : 'Select members';
}

function effectiveStatusLabel(row: SecretRow): string {
  if (row.system) return row.sharedConfigured ? 'Managed by Kortix' : 'Not set';
  if (row.effectiveSource === 'mine') return 'Using your own value';
  if (row.effectiveSource === 'shared') return 'Using the shared value';
  if (row.sharedConfigured && !row.usableByMe) {
    return "Shared value exists but isn't shared with you";
  }
  let label = 'Not set';
  if (row.mine) label += ' · your value saved';
  return label;
}

function SecretTableRow({
  row,
  canManage,
  busy,
  onChooseSource,
  onEditShared,
  onDeleteShared,
  onEditMine,
  onRemoveMine,
}: {
  row: SecretRow;
  canManage: boolean;
  busy: boolean;
  onChooseSource: (row: SecretRow, source: 'shared' | 'mine') => void;
  onEditShared: () => void;
  onDeleteShared: () => void;
  onEditMine: () => void;
  onRemoveMine: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const scopeLabel = sharingScopeLabel(row.sharing);
  const canManageShared = canManage && !row.system;
  const statusLabel = effectiveStatusLabel(row);

  return (
    <TableRow
      className={cn(
        row.requirement === 'required' &&
          row.effectiveSource === 'none' &&
          'bg-kortix-orange/[0.04]',
      )}
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
            {scopeLabel && (
              <Badge variant="outline" size="xs">
                {scopeLabel}
              </Badge>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[200px] text-xs font-medium whitespace-normal">
        {statusLabel}
      </TableCell>
      <TableCell>
        {row.system ? (
          <span className="text-muted-foreground/50 text-xs">—</span>
        ) : (
          <SourceChooser row={row} busy={busy} onChoose={(s) => onChooseSource(row, s)} />
        )}
      </TableCell>
      <TableCell>
        {row.system ? null : (
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
              <DropdownMenuItem onClick={onEditMine}>
                <UserSolid className="size-3.5 shrink-0" />
                {row.mine ? 'Edit my value' : 'Use my own value'}
              </DropdownMenuItem>
              {row.mine && (
                <DropdownMenuItem onClick={onRemoveMine} variant="destructive">
                  <TrashSolid className="size-3.5 shrink-0" />
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextRemoveMy28722d0f',
                  )}
                </DropdownMenuItem>
              )}
              {canManageShared && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onEditShared}>
                    <Pencil className="size-3.5 shrink-0" />
                    {row.sharedConfigured ? 'Edit shared value' : 'Set shared value'}
                  </DropdownMenuItem>
                  {row.sharedConfigured && (
                    <DropdownMenuItem onClick={onDeleteShared} variant="destructive">
                      <TrashSolid className="size-3.5 shrink-0" />
                      {tI18nHardcoded.raw(
                        'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextDeleteSharedd7bb1731',
                      )}
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

function SourceChooser({
  row,
  busy,
  onChoose,
}: {
  row: SecretRow;
  busy: boolean;
  onChoose: (source: 'shared' | 'mine') => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const sharedAvailable = row.sharedConfigured && row.usableByMe;
  const tabValue =
    row.effectiveSource === 'mine' ? 'mine' : row.effectiveSource === 'shared' ? 'shared' : '';

  return (
    <Tabs
      className="gap-0"
      value={tabValue}
      onValueChange={(value) => {
        if (value === 'shared' || value === 'mine') onChoose(value);
      }}
    >
      <TabsListCompact>
        <TabsTriggerCompact
          value="shared"
          disabled={busy || !sharedAvailable}
          title={
            sharedAvailable ? 'Use the shared project value' : 'No shared value available to you'
          }
        >
          <UsersSolid />
          Shared
        </TabsTriggerCompact>
        <TabsTriggerCompact
          value="mine"
          disabled={busy}
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsSecretsViewJsxAttrTitleUsed8cf287f',
          )}
        >
          <LockSolid />
          Mine
        </TabsTriggerCompact>
      </TabsListCompact>
    </Tabs>
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const fixedName = row?.name ?? null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [sharing, setSharing] = useState<SharingSelection>({ mode: 'project', memberIds: [] });

  const requiresValue = !row?.sharedConfigured;

  useEffect(() => {
    if (!open) return;
    setName(row?.name ?? '');
    setValue('');
    setSharing(intentToSelection(row?.sharing ?? null));
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
      if (!isSharingComplete(sharing)) {
        throw new Error('Pick at least one member, or choose another sharing option.');
      }
      return upsertProjectSecret(projectId, {
        name: finalName,
        ...(value.trim() ? { value } : {}),
        sharing: selectionToIntent(sharing),
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

  const title = !row
    ? 'Add shared secret'
    : row.sharedConfigured
      ? `Edit ${row.name}`
      : `Set ${row.name}`;

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
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextTheShared55c37a86',
            )}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit} autoComplete="off">
          <ModalBody className="max-h-[60vh] overflow-y-auto">
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

            {row?.sharedConfigured && (
              <p className="text-muted-foreground text-xs">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextLeaveBlank2964f5bb',
                )}
              </p>
            )}

            <SharingPicker projectId={projectId} value={sharing} onChange={setSharing} />
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
                !isSharingComplete(sharing) ||
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

function PersonalSecretDialog({
  open,
  row,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  row: SecretRow | null;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const fixedName = row?.name ?? null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(row?.name ?? '');
    setValue('');
  }, [open, row]);

  const save = useMutation({
    mutationFn: () => {
      const finalName = (fixedName ?? name).trim().toUpperCase();
      if (!SECRET_NAME_REGEX.test(finalName)) {
        throw new Error('Use A-Z, 0-9, _ only. Must start with a letter or _. Max 64 chars.');
      }
      if (finalName.startsWith('KORTIX_')) {
        throw new Error('KORTIX_* names are reserved for platform variables');
      }
      if (!value.trim()) {
        throw new Error('Value is required.');
      }
      // Setting a value activates the override ("use mine").
      return setPersonalProjectSecret(projectId, finalName, { value, active: true });
    },
    onSuccess: () => {
      successToast(`Saved your ${(fixedName ?? name).trim().toUpperCase()}`);
      onSaved();
      onClose();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    if (!fixedName && !name.trim()) return;
    save.mutate();
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        if (!next) onClose();
      }}
    >
      <ModalContent className="z-[999999999] lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{row ? `Your value for ${row.name}` : 'Add your own secret'}</ModalTitle>
          <ModalDescription>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextAPrivate3616193c',
            )}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit} autoComplete="off">
          <ModalBody>
            <div className="border-border bg-sidebar flex flex-col overflow-hidden rounded-md border">
              <Input
                id="personal-secret-name"
                value={fixedName ?? name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="KEY_NAME"
                variant="default"
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
                id="personal-secret-value"
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
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={onClose}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="w-full gap-1.5 sm:w-auto"
              disabled={(!fixedName && !name.trim()) || !value.trim() || save.isPending}
            >
              {save.isPending && <Loading className="size-4 shrink-0 animate-spin" />}
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsSecretsViewJsxTextUseMineb9944133',
              )}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
