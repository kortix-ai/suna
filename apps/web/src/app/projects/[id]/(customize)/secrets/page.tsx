'use client';

import { FormEvent, use, useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  FileWarning,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  X,
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
  deleteProjectSecret,
  listProjectSecrets,
  upsertProjectSecret,
  type ProjectSecret,
  type ProjectSecretsResponse,
} from '@/lib/projects-client';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;

type Requirement = 'required' | 'optional' | null;

/** Merged view-model row: stored secret, manifest-required, or manifest-optional. */
interface SecretRow {
  name: string;
  secretId: string | null;
  isSet: boolean;
  requirement: Requirement;
  updatedAt: string | null;
  system: boolean;
  readonly: boolean;
  purpose: string | null;
  canRotate: boolean;
  managedBy: string | null;
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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Secrets</h1>
      </div>
      <ProjectSecretsBody projectId={projectId} />
    </div>
  );
}

function ProjectSecretsBody({ projectId }: { projectId: string }) {
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
  });

  const isForbidden =
    secretsQuery.isError &&
    /403|forbidden|owner or admin/i.test((secretsQuery.error as Error)?.message ?? '');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
        <header className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Project secrets</h2>
          <p className="text-xs text-muted-foreground">
            Key-value pairs injected as environment variables into every new session
            sandbox for this project. Required keys come from your{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">kortix.toml</code>
            {' '}manifest. Values are encrypted at rest.
          </p>
        </header>

        {secretsQuery.isLoading ? (
          <SecretsSkeleton />
        ) : isForbidden ? (
          <ForbiddenNotice />
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

  // Manifest entries first (required, then optional), so the "must-set" rows
  // dominate the visual hierarchy regardless of whether they're set yet.
  for (const [name, requirement] of requirementByName) {
    const stored = storedByName.get(name);
    rows.push({
      name,
      secretId: stored?.secret_id ?? null,
      isSet: stored ? stored.configured ?? true : false,
      requirement,
      updatedAt: stored?.updated_at ?? null,
      system: Boolean(stored?.system),
      readonly: Boolean(stored?.readonly),
      purpose: stored?.purpose ?? null,
      canRotate: Boolean(stored?.can_rotate),
      managedBy: stored?.managed_by ?? null,
    });
    seen.add(name);
  }

  // Anything stored that the manifest doesn't mention.
  for (const item of data.items) {
    if (seen.has(item.name)) continue;
    rows.push({
      name: item.name,
      secretId: item.secret_id,
      isSet: item.configured ?? true,
      requirement: null,
      updatedAt: item.updated_at,
      system: Boolean(item.system),
      readonly: Boolean(item.readonly),
      purpose: item.purpose ?? null,
      canRotate: Boolean(item.can_rotate),
      managedBy: item.managed_by ?? null,
    });
  }

  return rows;
}

function SecretsCard({
  projectId,
  data,
}: {
  projectId: string;
  data: ProjectSecretsResponse | ProjectSecret[] | null | undefined;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['project-secrets', projectId];

  const normalized = useMemo(() => normalizeResponse(data), [data]);
  const allRows = useMemo(() => buildRows(normalized), [normalized]);

  const missingRequired = allRows.filter((r) => r.requirement === 'required' && !r.isSet);

  const [search, setSearch] = useState('');
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);

  // The add/edit dialog. `dialogRow` is the row being edited; null `name`
  // (via the "Add" button) means "create new".
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogRow, setDialogRow] = useState<SecretRow | null>(null);


  const remove = useMutation({
    mutationFn: ({ name }: { name: string }) => deleteProjectSecret(projectId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const filtered = useMemo(() => {
    if (!search) return allRows;
    const q = search.toLowerCase();
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [allRows, search]);

  const openCreate = () => {
    setDialogRow(null);
    setDialogOpen(true);
    setConfirmDeleteName(null);
  };

  const openEdit = (row: SecretRow) => {
    setDialogRow(row);
    setDialogOpen(true);
    setConfirmDeleteName(null);
  };

  const handleDelete = useCallback(
    async (row: SecretRow) => {
      setConfirmDeleteName(null);
      if (!row.isSet) return;
      try {
        await remove.mutateAsync({ name: row.name });
        toast.success(`Removed ${row.name}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove');
      }
    },
    [remove],
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
          title={`${missingRequired.length} required ${missingRequired.length === 1 ? 'secret' : 'secrets'} not set`}
        >
          Sessions can still start, but the agent will likely fail until these are set.
        </InfoBanner>
      )}

      <ProjectProviderModal
        projectId={projectId}
        open={providerModalOpen}
        onOpenChange={setProviderModalOpen}
      />

      <SectionCard
        title="Secrets"
        description="Key-value pairs injected into every new session sandbox."
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
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setProviderModalOpen(true)}
            >
              <Plug className="h-3.5 w-3.5" />
              Connect provider
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={openCreate}
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
            {filtered.map((row) => {
              const isConfirmingDelete = confirmDeleteName === row.name;

              return (
                <ListRow
                  key={row.name}
                  className={cn(
                    !row.isSet && row.requirement === 'required' && 'bg-amber-500/[0.02]',
                  )}
                  leading={<EntityAvatar icon={KeyRound} size="sm" />}
                  title={
                    <code className="truncate font-mono text-xs text-foreground">
                      {row.name}
                    </code>
                  }
                  badges={
                    <>
                      {row.requirement === 'required' && (
                        <Badge variant="warning" size="sm">
                          Required
                        </Badge>
                      )}
                      {row.requirement === 'optional' && (
                        <Badge variant="outline" size="sm">
                          Optional
                        </Badge>
                      )}
                      {row.system && (
                        <Badge variant="outline" size="sm">
                          Managed
                        </Badge>
                      )}
                    </>
                  }
                  subtitle={
                    isConfirmingDelete ? (
                      <span className="text-xs text-muted-foreground">Remove this secret?</span>
                    ) : row.system && row.purpose === 'git_auth' ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {row.isSet
                          ? row.canRotate
                            ? 'Git clone credential stored for this project'
                            : 'Git clone credential managed by Kortix'
                          : 'Add a private git clone credential for this project'}
                      </span>
                    ) : row.isSet ? (
                      <code className="truncate font-mono text-xs text-muted-foreground">
                        ••••••••
                      </code>
                    ) : (
                      <span
                        className={cn(
                          'text-xs italic',
                          row.requirement === 'required'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-muted-foreground/60',
                        )}
                      >
                        Not set
                      </span>
                    )
                  }
                  trailing={
                    <>
                      <div className="flex w-[88px] flex-shrink-0 items-center justify-end gap-0.5">
                        {isConfirmingDelete ? (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => void handleDelete(row)}
                              disabled={remove.isPending}
                            >
                              {remove.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => setConfirmDeleteName(null)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : row.system && row.purpose === 'git_auth' && row.canRotate ? (
                          row.isSet ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={() => openEdit(row)}
                              aria-label="Rotate git credential"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() => openEdit(row)}
                            >
                              Set
                            </Button>
                          )
                        ) : row.isSet && row.readonly ? (
                          <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : row.isSet ? (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={() => openEdit(row)}
                              aria-label="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                              onClick={() => setConfirmDeleteName(row.name)}
                              aria-label="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant={row.requirement === 'required' ? 'default' : 'outline'}
                            className="h-7 px-2 text-xs"
                            onClick={() => openEdit(row)}
                          >
                            Set
                          </Button>
                        )}
                      </div>
                    </>
                  }
                />
              );
            })}
          </List>
        )}
      </SectionCard>

      <SecretDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        row={dialogRow}
        onSaved={() => queryClient.invalidateQueries({ queryKey })}
      />
    </div>
  );
}

// ─── Add / Set / rotate secret dialog ───────────────────────────────────────

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
  /** null = create a brand-new secret; otherwise set/rotate this row. */
  row: SecretRow | null;
  onSaved: () => void;
}) {
  // For a manifest-declared row the name is fixed; only free-form adds let the
  // user type it.
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
      if (!value.trim()) {
        throw new Error('Value is required.');
      }
      if (finalName.startsWith('KORTIX_')) {
        throw new Error('KORTIX_* names are reserved for platform variables');
      }
      return upsertProjectSecret(projectId, {
        name: finalName,
        value,
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

  const title = !row ? 'Add secret' : row.isSet ? `Edit ${row.name}` : `Set ${row.name}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Runtime environment variable for new session sandboxes.
          </DialogDescription>
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
              onChange={(e) =>
                setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
              }
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
              {row?.isSet ? (
                <>
                  New value{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    (replaces current value)
                  </span>
                </>
              ) : (
                'Value'
              )}
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
          </div>


          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={(!fixedName && !name.trim()) || !value.trim() || save.isPending}
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
  if (status === 'loaded') {
    // Manifest loaded and DECLARED envs — keep the banner subtle.
    if (envCount > 0) {
      return (
        <InfoBanner tone="success" icon={Check}>
          Manifest loaded from{' '}
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
        title="Manifest loaded but no env keys declared"
      >
        Add a <code className="rounded bg-background px-1 py-0.5 font-mono">[env]</code> section
        to{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono">{path}</code> with{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono">required</code> /{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono">optional</code> string arrays.
      </InfoBanner>
    );
  }

  if (status === 'missing') {
    return (
      <InfoBanner tone="neutral" icon={FileWarning} title="No manifest found">
        Commit a <code className="rounded bg-background px-1 py-0.5 font-mono">{path ?? 'kortix.toml'}</code> to
        this project to declare required/optional env keys.
      </InfoBanner>
    );
  }

  if (status === 'error') {
    return (
      <InfoBanner
        tone="warning"
        icon={AlertTriangle}
        title={
          <>
            Couldn't read{' '}
            <code className="rounded bg-background px-1 py-0.5 font-mono">{path ?? 'kortix.toml'}</code>
          </>
        }
      >
        {error && <p className="opacity-80 break-all">{error}</p>}
        <p className="opacity-80">
          Check the repo is reachable and linked through Project settings.
        </p>
      </InfoBanner>
    );
  }

  // Old API build that doesn't return manifest_status. Tell the user — most
  // likely they just need to restart their API dev server.
  return (
    <InfoBanner tone="warning" icon={AlertTriangle} title="Manifest status unavailable">
      <p className="opacity-80">
        The API isn't returning manifest info — restart the API server
        (<code className="rounded bg-background px-1 py-0.5 font-mono">apps/api</code>) to pick up
        required/optional keys from your <code className="rounded bg-background px-1 py-0.5 font-mono">kortix.toml</code>.
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

function ForbiddenNotice() {
  return (
    <InfoBanner
      tone="warning"
      icon={ShieldAlert}
      title="Owner or admin access required"
    >
      Only account owners and admins can view or manage project secrets.
    </InfoBanner>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <InfoBanner
      tone="destructive"
      title="Failed to load secrets"
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
