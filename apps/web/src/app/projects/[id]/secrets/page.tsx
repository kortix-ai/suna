'use client';

import { use, useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';

import { ProjectShell } from '@/components/projects/project-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast';
import {
  deleteProjectSecret,
  listProjectSecrets,
  upsertProjectSecret,
  type ProjectSecret,
} from '@/lib/projects-client';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;

export default function ProjectSecretsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);

  return (
    <ProjectShell projectId={projectId}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold text-foreground">Secrets</h1>
        </div>
        <ProjectSecretsBody projectId={projectId} />
      </div>
    </ProjectShell>
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
            sandbox for this project. Values are encrypted at rest.
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
          <SecretsCard
            projectId={projectId}
            secrets={secretsQuery.data ?? []}
          />
        )}
      </div>
    </div>
  );
}

function SecretsCard({
  projectId,
  secrets,
}: {
  projectId: string;
  secrets: ProjectSecret[];
}) {
  const queryClient = useQueryClient();
  const queryKey = ['project-secrets', projectId];

  const [search, setSearch] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);

  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');

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
    if (!search) return secrets;
    const q = search.toLowerCase();
    return secrets.filter((s) => s.name.toLowerCase().includes(q));
  }, [secrets, search]);

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
        {filtered.map((secret) => {
          const isEditing = editingName === secret.name;
          const isConfirmingDelete = confirmDeleteName === secret.name;

          return (
            <div
              key={secret.secret_id}
              className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30"
            >
              <code className="w-[240px] flex-shrink-0 truncate font-mono text-xs text-foreground">
                {secret.name}
              </code>

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
                      if (e.key === 'Enter') void handleSave(secret.name);
                      if (e.key === 'Escape') {
                        setEditingName(null);
                        setEditValue('');
                      }
                    }}
                  />
                ) : isConfirmingDelete ? (
                  <span className="text-xs text-muted-foreground">Remove this secret?</span>
                ) : (
                  <code className="truncate font-mono text-xs text-muted-foreground">
                    ••••••••
                  </code>
                )}
              </div>

              <div className="flex w-[72px] flex-shrink-0 items-center justify-end gap-0.5">
                {isEditing ? (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => void handleSave(secret.name)}
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
                      onClick={() => void handleDelete(secret.name)}
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
                ) : (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => {
                        setEditingName(secret.name);
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
                        setConfirmDeleteName(secret.name);
                        setEditingName(null);
                      }}
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
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
