'use client';

import { use, useCallback, useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
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
}

export default function ProjectSecretsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);

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
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">kortix.toml</code>
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
      isSet: Boolean(stored),
      requirement,
      updatedAt: stored?.updated_at ?? null,
    });
    seen.add(name);
  }

  // Anything stored that the manifest doesn't mention.
  for (const item of data.items) {
    if (seen.has(item.name)) continue;
    rows.push({
      name: item.name,
      secretId: item.secret_id,
      isSet: true,
      requirement: null,
      updatedAt: item.updated_at,
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
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);

  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [providerModalOpen, setProviderModalOpen] = useState(false);

  const upsert = useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      upsertProjectSecret(projectId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const filtered = useMemo(() => {
    if (!search) return allRows;
    const q = search.toLowerCase();
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [allRows, search]);

  const resetNew = () => {
    setAddingNew(false);
    setNewName('');
    setNewValue('');
  };

  const handleAdd = useCallback(async () => {
    const name = newName.trim().toUpperCase();
    if (!name) return;
    if (!SECRET_NAME_REGEX.test(name)) {
      toast.error('Invalid name', {
        description: 'Use A-Z, 0-9, _ only. Must start with a letter or _. Max 64 chars.',
      });
      return;
    }
    if (name.startsWith('KORTIX_')) {
      toast.error('KORTIX_* names are reserved for platform variables');
      return;
    }
    try {
      await upsert.mutateAsync({ name, value: newValue });
      toast.success(`Saved ${name}`);
      resetNew();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save secret');
    }
  }, [newName, newValue, upsert]);

  const handleSave = useCallback(
    async (name: string) => {
      try {
        await upsert.mutateAsync({ name, value: editValue });
        toast.success(`Saved ${name}`);
        setEditingName(null);
        setEditValue('');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save');
      }
    },
    [editValue, upsert],
  );

  const handleDelete = useCallback(
    async (name: string) => {
      setConfirmDeleteName(null);
      try {
        await remove.mutateAsync(name);
        toast.success(`Removed ${name}`);
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
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="space-y-0.5 text-sm">
            <p className="font-medium text-foreground">
              {missingRequired.length} required {missingRequired.length === 1 ? 'secret' : 'secrets'} not set
            </p>
            <p className="text-xs text-muted-foreground">
              Sessions can still start, but the agent will likely fail until these are set.
            </p>
          </div>
        </div>
      )}

      <ProjectProviderModal
        projectId={projectId}
        open={providerModalOpen}
        onOpenChange={setProviderModalOpen}
      />

      <section className="rounded-xl border border-border/70 bg-card">
        <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="relative flex-1">
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
            onClick={() => {
              setAddingNew(true);
              setEditingName(null);
              setConfirmDeleteName(null);
            }}
            disabled={addingNew}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </header>

        {addingNew && (
          <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-4 py-2.5">
            <Input
              type="text"
              value={newName}
              onChange={(e) =>
                setNewName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
              }
              placeholder="KEY_NAME"
              className="h-8 w-[240px] font-mono text-xs shadow-none"
              autoFocus
            />
            <Input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              className="h-8 flex-1 font-mono text-xs shadow-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd();
                if (e.key === 'Escape') resetNew();
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => void handleAdd()}
              disabled={!newName.trim() || upsert.isPending}
            >
              {upsert.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={resetNew}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className="divide-y divide-border/40">
          {filtered.map((row) => {
            const isEditing = editingName === row.name;
            const isConfirmingDelete = confirmDeleteName === row.name;

            return (
              <div
                key={row.name}
                className={cn(
                  'group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30',
                  !row.isSet && row.requirement === 'required' && 'bg-amber-500/[0.02]',
                )}
              >
                <div className="flex w-[260px] flex-shrink-0 items-center gap-2">
                  <code className="truncate font-mono text-xs text-foreground">
                    {row.name}
                  </code>
                  {row.requirement === 'required' && (
                    <Badge
                      variant="outline"
                      className="h-4 flex-shrink-0 rounded-md border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-700 dark:text-amber-400"
                    >
                      Required
                    </Badge>
                  )}
                  {row.requirement === 'optional' && (
                    <Badge
                      variant="outline"
                      className="h-4 flex-shrink-0 rounded-md px-1 text-[9px] font-normal text-muted-foreground"
                    >
                      Optional
                    </Badge>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <Input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder="New value"
                      className="h-8 font-mono text-xs shadow-none"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSave(row.name);
                        if (e.key === 'Escape') {
                          setEditingName(null);
                          setEditValue('');
                        }
                      }}
                    />
                  ) : isConfirmingDelete ? (
                    <span className="text-xs text-muted-foreground">Remove this secret?</span>
                  ) : row.isSet ? (
                    <code className="truncate font-mono text-xs text-muted-foreground">
                      ••••••••
                    </code>
                  ) : (
                    <span
                      className={cn(
                        'text-xs italic',
                        row.requirement === 'required'
                          ? 'text-amber-700 dark:text-amber-500'
                          : 'text-muted-foreground/60',
                      )}
                    >
                      Not set
                    </span>
                  )}
                </div>

                <div className="flex w-[88px] flex-shrink-0 items-center justify-end gap-0.5">
                  {isEditing ? (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => void handleSave(row.name)}
                        disabled={upsert.isPending}
                      >
                        {upsert.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => {
                          setEditingName(null);
                          setEditValue('');
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : isConfirmingDelete ? (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => void handleDelete(row.name)}
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
                  ) : row.isSet ? (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => {
                          setEditingName(row.name);
                          setEditValue('');
                          setConfirmDeleteName(null);
                        }}
                        aria-label="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                        onClick={() => {
                          setConfirmDeleteName(row.name);
                          setEditingName(null);
                        }}
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
                      onClick={() => {
                        setEditingName(row.name);
                        setEditValue('');
                        setConfirmDeleteName(null);
                      }}
                    >
                      Set
                    </Button>
                  )}
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && !addingNew && (
            <div className="px-4 py-12 text-center">
              <KeyRound className="mx-auto h-6 w-6 text-muted-foreground/40" />
              <p className="mt-2 text-xs text-muted-foreground">
                {search ? 'No matches.' : 'No secrets yet. Add one to inject it into every new session.'}
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
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
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          <span>
            Manifest loaded from{' '}
            <code className="rounded bg-background px-1 py-0.5 font-mono">{path}</code> ·{' '}
            {envCount} env {envCount === 1 ? 'key' : 'keys'} declared
          </span>
        </div>
      );
    }
    // Manifest loaded but no envs — tell the user where to add them.
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <FileWarning className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="space-y-0.5">
          <p className="font-medium text-foreground">
            Manifest loaded but no env keys declared
          </p>
          <p>
            Add a <code className="rounded bg-background px-1 py-0.5 font-mono">[env]</code> section
            to{' '}
            <code className="rounded bg-background px-1 py-0.5 font-mono">{path}</code> with{' '}
            <code className="rounded bg-background px-1 py-0.5 font-mono">required</code> /{' '}
            <code className="rounded bg-background px-1 py-0.5 font-mono">optional</code> string arrays.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'missing') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <FileWarning className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <p className="font-medium text-foreground">No manifest found</p>
          <p>
            Commit a <code className="rounded bg-background px-1 py-0.5 font-mono">{path ?? 'kortix.toml'}</code> to
            this project to declare required/optional env keys.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="space-y-0.5">
          <p className="font-medium">
            Couldn't read{' '}
            <code className="rounded bg-amber-500/10 px-1 py-0.5 font-mono">{path ?? 'kortix.toml'}</code>
          </p>
          {error && <p className="opacity-80 break-all">{error}</p>}
          <p className="opacity-80">
            Check the repo is reachable and the server has{' '}
            <code className="rounded bg-amber-500/10 px-1 py-0.5 font-mono">KORTIX_GITHUB_TOKEN</code>{' '}
            set if it's private.
          </p>
        </div>
      </div>
    );
  }

  // Old API build that doesn't return manifest_status. Tell the user — most
  // likely they just need to restart their API dev server.
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="space-y-0.5">
        <p className="font-medium">Manifest status unavailable</p>
        <p className="opacity-80">
          The API isn't returning manifest info — restart the API server
          (<code className="rounded bg-amber-500/10 px-1 py-0.5 font-mono">apps/api</code>) to pick up
          required/optional keys from your <code className="rounded bg-amber-500/10 px-1 py-0.5 font-mono">kortix.toml</code>.
        </p>
      </div>
    </div>
  );
}

function SecretsSkeleton() {
  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <div className="border-b border-border/60 px-4 py-3">
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="divide-y divide-border/40">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-4 w-[200px]" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </section>
  );
}

function ForbiddenNotice() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200/60 bg-amber-50/50 px-4 py-3 text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="space-y-0.5 text-sm">
        <p className="font-medium">Owner or admin access required</p>
        <p className="text-xs opacity-80">
          Only account owners and admins can view or manage project secrets.
        </p>
      </div>
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
      <p className="text-sm font-medium text-destructive">Failed to load secrets</p>
      <p className="mt-1 text-xs text-destructive/80">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
