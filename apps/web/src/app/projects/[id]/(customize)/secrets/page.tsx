'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, use, useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import {
  AlertTriangle,
  Check,
  FileWarning,
  KeyRound,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  User,
  Users,
} from 'lucide-react';

import { ProjectProviderModal } from '@/components/projects/project-provider-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  deletePersonalProjectSecret,
  deleteProjectSecret,
  listProjectSecrets,
  setPersonalProjectSecret,
  upsertProjectSecret,
  type ConnectorSharing,
  type ProjectSecret,
  type ProjectSecretsResponse,
} from '@/lib/projects-client';
import {
  SharingPicker,
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/components/projects/sharing-picker';

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

export default function ProjectSecretsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <SecretsView projectId={projectId} />;
}

export function SecretsView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CustomizeSectionHeader icon={KeyRound} title="Secrets" />
      <ProjectSecretsBody projectId={projectId} />
    </div>
  );
}

function ProjectSecretsBody({ projectId }: { projectId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
        <header className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line104JsxTextProjectSecrets')}</h2>
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line106JsxTextKeyValuePairsInjectedAsEnvironmentVariablesInto')}{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">kortix.toml</code>
            {' '}{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line109JsxTextManifestValuesAreEncryptedAtRest')}</p>
        </header>

        {secretsQuery.isLoading ? (
          <SecretsSkeleton />
        ) : secretsQuery.isError ? (
          <ErrorNotice
            message={(secretsQuery.error as Error)?.message ?? 'Failed to load secrets'}
            onRetry={() => secretsQuery.refetch()}
          />
        ) : (
          <SecretsCard projectId={projectId} data={secretsQuery.data} />
        )}
      </div>
    </div>
  );
}

/**
 * Normalize whatever the API gave us into the shape we expect. We're defensive
 * about: (a) older API builds that returned a bare array, (b) malformed
 * manifests that left required/optional missing.
 */
function normalizeResponse(data: ProjectSecretsResponse | ProjectSecret[] | null | undefined): ProjectSecretsResponse {
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

/** Merge stored secrets + manifest requirements into a single sortable list. */
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

  const toRow = (name: string, requirement: Requirement, item: ProjectSecret | undefined): SecretRow => ({
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

/** Short label for the shared row's sharing scope (null = the implicit project-wide). */
function sharingScopeLabel(sharing: ConnectorSharing | null): string | null {
  if (!sharing || sharing.mode === 'project') return null;
  return sharing.mode === 'private' ? 'Owner only' : 'Select members';
}

function SecretsCard({
  projectId,
  data,
}: {
  projectId: string;
  data: ProjectSecretsResponse | ProjectSecret[] | null | undefined;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const queryKey = ['project-secrets', projectId];

  const normalized = useMemo(() => normalizeResponse(data), [data]);
  const canManage = normalized.can_manage ?? false;
  const allRows = useMemo(() => buildRows(normalized), [normalized]);

  // "Missing" = the member has no effective value (shared not reaching them and
  // no active override of their own).
  const missingRequired = allRows.filter((r) => r.requirement === 'required' && r.effectiveSource === 'none');

  const [search, setSearch] = useState('');
  const [providerModalOpen, setProviderModalOpen] = useState(false);

  // Shared (manager) add/edit dialog — null row = create new.
  const [sharedDialogOpen, setSharedDialogOpen] = useState(false);
  const [sharedDialogRow, setSharedDialogRow] = useState<SecretRow | null>(null);
  // Personal override dialog (any member). `open` is tracked separately so
  // "create new" (row === null) is distinct from "closed".
  const [personalDialog, setPersonalDialog] = useState<{ open: boolean; row: SecretRow | null }>({
    open: false,
    row: null,
  });

  const removeShared = useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const removeMine = useMutation({
    mutationFn: (name: string) => deletePersonalProjectSecret(projectId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  // The per-key source choice (use shared vs use mine) — only flips the active
  // flag; the value is set via the personal dialog.
  const setSource = useMutation({
    mutationFn: ({ name, active }: { name: string; active: boolean }) =>
      setPersonalProjectSecret(projectId, name, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const filtered = useMemo(() => {
    if (!search) return allRows;
    const q = search.toLowerCase();
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [allRows, search]);

  const openSharedCreate = () => {
    setSharedDialogRow(null);
    setSharedDialogOpen(true);
  };
  const openSharedEdit = (row: SecretRow) => {
    setSharedDialogRow(row);
    setSharedDialogOpen(true);
  };

  const chooseSource = useCallback(
    (row: SecretRow, source: 'shared' | 'mine') => {
      if (source === 'mine') {
        if (row.mine) {
          if (!row.mine.active) setSource.mutate({ name: row.name, active: true });
        } else {
          // No personal value yet — collect one.
          setPersonalDialog({ open: true, row });
        }
      } else {
        // Use shared: deactivate the override if we have one (kept for later).
        if (row.mine?.active) setSource.mutate({ name: row.name, active: false });
      }
    },
    [setSource],
  );

  return (
    <div className="space-y-4">
      <ManifestStatusBanner
        status={normalized.manifest_status}
        path={normalized.manifest_path}
        error={normalized.manifest_error}
        envCount={normalized.required.length + normalized.optional.length}
      />

      {missingRequired.length > 0 && (
        <InfoBanner
          tone="warning"
          icon={AlertTriangle}
          title={`${missingRequired.length} required ${missingRequired.length === 1 ? 'secret' : 'secrets'} not set for you`}
        >{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line278JsxTextSessionsCanStillStartButTheAgentWill')}</InfoBanner>
      )}

      <ProjectProviderModal
        projectId={projectId}
        open={providerModalOpen}
        onOpenChange={setProviderModalOpen}
      />

      <SectionCard
        title="Secrets"
        description={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line290JsxAttrDescriptionKeyValuePairsInjectedIntoEveryNewSession')}
        flush
        action={
          <div className="flex items-center gap-2">
            <div className="relative w-44">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter..."
                className="h-8 pl-8 text-xs shadow-none"
              />
            </div>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setProviderModalOpen(true)}
              >
                <Plug className="h-3.5 w-3.5" />Connect LLM provider</Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={canManage ? openSharedCreate : () => setPersonalDialog({ open: true, row: null })}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        }
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={search ? 'No matches' : 'No secrets yet'}
            description={
              search
                ? 'No secrets match your filter.'
                : 'Add one to inject it into every new session.'
            }
          />
        ) : (
          <List>
            {filtered.map((row) => (
              <SecretListRow
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
          </List>
        )}
      </SectionCard>

      <SecretDialog
        open={sharedDialogOpen}
        onOpenChange={setSharedDialogOpen}
        projectId={projectId}
        row={sharedDialogRow}
        onSaved={() => queryClient.invalidateQueries({ queryKey })}
      />
      <PersonalSecretDialog
        open={personalDialog.open}
        row={personalDialog.row}
        projectId={projectId}
        onClose={() => setPersonalDialog({ open: false, row: null })}
        onSaved={() => queryClient.invalidateQueries({ queryKey })}
      />
    </div>
  );
}

/** One secret row: name + badges + the per-key source chooser + actions. */
function SecretListRow({
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
  const scopeLabel = sharingScopeLabel(row.sharing);
  const canManageShared = canManage && !row.system;

  // Git-auth / Kortix-managed rows keep their dedicated, simpler treatment.
  if (row.system) {
    return (
      <ListRow
        leading={<EntityAvatar icon={KeyRound} size="sm" />}
        title={<code className="truncate font-mono text-xs text-foreground">{row.name}</code>}
        badges={<Badge variant="outline" size="sm">Managed</Badge>}
        subtitle={
          <span className="truncate text-xs text-muted-foreground">
            {row.sharedConfigured ? 'Managed by Kortix' : 'Not set'}
          </span>
        }
      />
    );
  }

  const subtitle = (
    <span className="truncate text-xs text-muted-foreground">
      {row.effectiveSource === 'mine'
        ? 'Using your own value'
        : row.effectiveSource === 'shared'
          ? 'Using the shared value'
          : row.sharedConfigured && !row.usableByMe
            ? 'Shared value exists but isn’t shared with you'
            : 'Not set'}
      {row.mine && row.effectiveSource !== 'mine' && ' · your value saved'}
    </span>
  );

  return (
    <ListRow
      className={cn(row.requirement === 'required' && row.effectiveSource === 'none' && 'bg-amber-500/[0.02]')}
      leading={<EntityAvatar icon={row.effectiveSource === 'mine' ? User : KeyRound} size="sm" />}
      title={<code className="truncate font-mono text-xs text-foreground">{row.name}</code>}
      badges={
        <>
          {row.requirement === 'required' && <Badge variant="warning" size="sm">Required</Badge>}
          {row.requirement === 'optional' && <Badge variant="outline" size="sm">Optional</Badge>}
          {scopeLabel && <Badge variant="outline" size="sm">{scopeLabel}</Badge>}
        </>
      }
      subtitle={subtitle}
      trailing={
        <div className="flex items-center gap-1.5">
          <SourceChooser row={row} busy={busy} onChoose={(s) => onChooseSource(row, s)} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Secret actions">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onEditMine}>
                <User className="h-3.5 w-3.5" />
                {row.mine ? 'Edit my value' : 'Use my own value'}
              </DropdownMenuItem>
              {row.mine && (
                <DropdownMenuItem onClick={onRemoveMine} variant="destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove my value
                </DropdownMenuItem>
              )}
              {canManageShared && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onEditShared}>
                    <Pencil className="h-3.5 w-3.5" />
                    {row.sharedConfigured ? 'Edit shared value' : 'Set shared value'}
                  </DropdownMenuItem>
                  {row.sharedConfigured && (
                    <DropdownMenuItem onClick={onDeleteShared} variant="destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete shared value
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}

/** The per-key segmented choice: use the shared value or your own. */
function SourceChooser({
  row,
  busy,
  onChoose,
}: {
  row: SecretRow;
  busy: boolean;
  onChoose: (source: 'shared' | 'mine') => void;
}) {
  const usingMine = row.effectiveSource === 'mine';
  // Picking "Shared" is only meaningful if a shared value can reach the member.
  const sharedAvailable = row.sharedConfigured && row.usableByMe;
  return (
    <div className="flex items-center rounded-lg border border-border/60 p-0.5">
      <button
        type="button"
        disabled={busy || !sharedAvailable}
        onClick={() => onChoose('shared')}
        className={cn(
          'flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed',
          !usingMine && sharedAvailable
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground',
        )}
        title={sharedAvailable ? 'Use the shared project value' : 'No shared value available to you'}
      >
        <Users className="h-3 w-3" />
        Shared
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onChoose('mine')}
        className={cn(
          'flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed',
          usingMine ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
        title="Use your own value for this key"
      >
        <Lock className="h-3 w-3" />
        Mine
      </button>
    </div>
  );
}

// ─── Shared (manager) add / set / rotate dialog ──────────────────────────────

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
  /** null = create a brand-new shared secret; otherwise set/edit this row. */
  row: SecretRow | null;
  onSaved: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      toast.success(`Saved ${(fixedName ?? name).trim().toUpperCase()}`);
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save secret'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    if (!fixedName && !name.trim()) return;
    save.mutate();
  }

  const title = !row ? 'Add shared secret' : row.sharedConfigured ? `Edit ${row.name}` : `Set ${row.name}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>The shared project value, injected into every member’s sessions (subject to sharing).</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          {/* Dummy fields absorb browser autofill so the real inputs below
              aren't treated as a username/password login form. */}
          <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input type="password" name="password" autoComplete="new-password" className="hidden" tabIndex={-1} aria-hidden="true" />
          <div className="space-y-1.5">
            <Label htmlFor="secret-dialog-name">Name</Label>
            <Input
              id="secret-dialog-name"
              name="kortix-secret-name"
              value={fixedName ?? name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="KEY_NAME"
              className="font-mono"
              autoFocus={!fixedName}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              disabled={!!fixedName || save.isPending}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-dialog-value">
              {row?.sharedConfigured ? 'New value' : 'Value'}
            </Label>
            <Input
              id="secret-dialog-value"
              name="kortix-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="••••••••"
              className="font-mono"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              autoFocus={!!fixedName}
              disabled={save.isPending}
            />
            {row?.sharedConfigured && (
              <p className="text-xs text-muted-foreground">Leave blank to keep the current value.</p>
            )}
          </div>

          <SharingPicker projectId={projectId} value={sharing} onChange={setSharing} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                (!fixedName && !name.trim()) ||
                (requiresValue && !value.trim()) ||
                !isSharingComplete(sharing) ||
                save.isPending
              }
              className="gap-1.5"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Personal override dialog (any member) ───────────────────────────────────

function PersonalSecretDialog({
  open,
  row,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The key to override; null = the member is adding a brand-new personal key. */
  row: SecretRow | null;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
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
      toast.success(`Saved your ${(fixedName ?? name).trim().toUpperCase()}`);
      onSaved();
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    if (!fixedName && !name.trim()) return;
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!save.isPending && !next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? `Your value for ${row.name}` : 'Add your own secret'}</DialogTitle>
          <DialogDescription>
            A private value only you can use. It overrides the shared value in your own sessions and is never visible to other members.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input type="password" name="password" autoComplete="new-password" className="hidden" tabIndex={-1} aria-hidden="true" />
          <div className="space-y-1.5">
            <Label htmlFor="personal-secret-name">Name</Label>
            <Input
              id="personal-secret-name"
              value={fixedName ?? name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="KEY_NAME"
              className="font-mono"
              autoFocus={!fixedName}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              disabled={!!fixedName || save.isPending}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="personal-secret-value">{row?.mine ? 'New value' : 'Value'}</Label>
            <Input
              id="personal-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="••••••••"
              className="font-mono"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              autoFocus={!!fixedName}
              disabled={save.isPending}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={(!fixedName && !name.trim()) || !value.trim() || save.isPending}
              className="gap-1.5"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Use mine
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManifestStatusBanner({
  status,
  path,
  error,
  envCount,
}: {
  status?: 'loaded' | 'missing' | 'error';
  path?: string;
  error?: string;
  envCount: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  if (status === 'loaded') {
    // Manifest loaded and DECLARED envs — keep the banner subtle.
    if (envCount > 0) {
      return (
        <InfoBanner tone="success" icon={Check}>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line675JsxTextManifestLoadedFrom')}{' '}
          <code className="rounded bg-background px-1 py-0.5 font-mono">{path}</code> ·{' '}
          {envCount} env {envCount === 1 ? 'key' : 'keys'} declared
        </InfoBanner>
      );
    }
    // Manifest loaded but no envs — tell the user where to add them.
    return (
      <InfoBanner
        tone="neutral"
        icon={FileWarning}
        title={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line686JsxAttrTitleManifestLoadedButNoEnvKeysDeclared')}
      >{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line688JsxTextAddA')}<code className="rounded bg-background px-1 py-0.5 font-mono">[env]</code>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line688JsxTextSectionTo')}{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono">{path}</code> with{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono">required</code> /{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono">optional</code>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line692JsxTextStringArrays')}</InfoBanner>
    );
  }

  if (status === 'missing') {
    return (
      <InfoBanner tone="neutral" icon={FileWarning} title={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line699JsxAttrTitleNoManifestFound')}>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line700JsxTextCommitA')}<code className="rounded bg-background px-1 py-0.5 font-mono">{path ?? 'kortix.toml'}</code>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line700JsxTextToThisProjectToDeclareRequiredOptionalEnv')}</InfoBanner>
    );
  }

  if (status === 'error') {
    return (
      <InfoBanner
        tone="warning"
        icon={AlertTriangle}
        title={
          <>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line713JsxTextCouldnTRead')}{' '}
            <code className="rounded bg-background px-1 py-0.5 font-mono">{path ?? 'kortix.toml'}</code>
          </>
        }
      >
        {error && <p className="opacity-80 break-all">{error}</p>}
        <p className="opacity-80">{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line720JsxTextCheckTheRepoIsReachableAndLinkedThrough')}</p>
      </InfoBanner>
    );
  }

  // Old API build that doesn't return manifest_status. Tell the user — most
  // likely they just need to restart their API dev server.
  return (
    <InfoBanner tone="warning" icon={AlertTriangle} title={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line729JsxAttrTitleManifestStatusUnavailable')}>
      <p className="opacity-80">{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line731JsxTextTheApiIsnTReturningManifestInfoRestart')}<code className="rounded bg-background px-1 py-0.5 font-mono">apps/api</code>{tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line732JsxTextToPickUpRequiredOptionalKeysFromYour')}<code className="rounded bg-background px-1 py-0.5 font-mono">kortix.toml</code>.
      </p>
    </InfoBanner>
  );
}

function SecretsSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="border-b border-border/60 px-6 py-4">
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="divide-y divide-border/60">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 px-6 py-3">
            <Skeleton className="h-4 w-[200px]" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </Card>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <InfoBanner
      tone="destructive"
      title={tHardcodedUi.raw('appProjectsIdCustomizeSecretsPage.line773JsxAttrTitleFailedToLoadSecrets')}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </InfoBanner>
  );
}
