'use client';

/**
 * Apps list — the default section of the Apps overlay.
 *
 * Shows one card per `[[apps]]` entry, with status, live URL, and per-app
 * actions (Deploy now, Stop, Logs, Edit, Remove). The empty state nudges
 * the user to ship their first app.
 */

import { useState } from 'react';
import { toast } from '@/lib/toast';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  IconAdd,
  IconApp,
  IconChevronDown,
  IconDelete,
  IconDeploy,
  IconEdit,
  IconExternal,
  IconLoader,
  IconStop,
  IconTerminal,
} from '@/components/ui/kortix-icons';

import {
  useDeleteProjectApp,
  useDeployProjectApp,
  useStopProjectApp,
} from '@/hooks/projects/use-project-apps';
import type {
  ListProjectAppsResponse,
  ProjectApp,
} from '@/lib/projects-apps-client';

interface AppsListProps {
  projectId: string;
  data: ListProjectAppsResponse | undefined;
  isLoading: boolean;
  onAdd: () => void;
  onEdit: (slug: string) => void;
  onLogs: (slug: string) => void;
}

export function AppsList({ projectId, data, isLoading, onAdd, onEdit, onLogs }: AppsListProps) {
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);

  const deployMut = useDeployProjectApp(projectId);
  const stopMut = useStopProjectApp(projectId);
  const deleteMut = useDeleteProjectApp(projectId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <IconLoader className="mr-2 size-4 animate-spin" />
        Loading apps…
      </div>
    );
  }

  const apps = data?.apps ?? [];
  const errors = data?.errors ?? [];

  if (apps.length === 0 && errors.length === 0) {
    return (
      <EmptyState
        icon={IconApp}
        title="Ship a website from this project"
        description={
          <>
            Add an app and we&apos;ll handle the build and a public URL — no
            hosting setup to do.
          </>
        }
        action={
          <Button onClick={onAdd}>
            <IconAdd className="size-3.5" />
            Add app
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {apps.length} {apps.length === 1 ? 'app' : 'apps'}
        </p>
        <Button size="sm" onClick={onAdd}>
          <IconAdd className="size-3.5" />
          Add app
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {errors.length > 0 && (
            <div className="flex flex-col gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
              <p className="font-medium">Some entries in kortix.toml couldn&apos;t be parsed:</p>
              <ul className="list-disc pl-4">
                {errors.map((err) => (
                  <li key={`${err.slug}-${err.error}`}>
                    <span className="font-mono">{err.slug}</span> — {err.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {apps.map((app) => (
            <AppCard
              key={app.slug}
              app={app}
              busySlug={
                (deployMut.isPending && deployMut.variables) === app.slug
                  ? 'deploy'
                  : (stopMut.isPending && stopMut.variables) === app.slug
                  ? 'stop'
                  : null
              }
              onDeploy={async () => {
                try {
                  const res = await deployMut.mutateAsync(app.slug);
                  if (res.status === 'active') {
                    toast.success(`Deploying ${app.slug}`);
                  } else {
                    toast.error(`Deploy failed: ${res.deployment?.error ?? 'unknown error'}`);
                  }
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Deploy failed');
                }
              }}
              onStop={async () => {
                try {
                  await stopMut.mutateAsync(app.slug);
                  toast.success(`Stopped ${app.slug}`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Stop failed');
                }
              }}
              onLogs={() => onLogs(app.slug)}
              onEdit={() => onEdit(app.slug)}
              onDelete={() => setConfirmSlug(app.slug)}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmSlug}
        onOpenChange={(open) => (open ? undefined : setConfirmSlug(null))}
        title={`Remove ${confirmSlug ?? ''}?`}
        description={
          <>
            This removes the entry from <code className="font-mono">kortix.toml</code>{' '}
            and stops auto-deploys for this app. Any live deployment keeps
            running until you stop it explicitly.
          </>
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!confirmSlug) return;
          try {
            await deleteMut.mutateAsync(confirmSlug);
            toast.success(`Removed ${confirmSlug}`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not remove');
          } finally {
            setConfirmSlug(null);
          }
        }}
      />
    </div>
  );
}

function statusBadge(app: ProjectApp): React.ReactNode {
  const dep = app.latest_deployment;
  if (!dep) {
    return (
      <Badge size="sm" variant="muted">
        Not deployed
      </Badge>
    );
  }
  switch (dep.status) {
    case 'active':
      return <Badge size="sm" variant="success">Live</Badge>;
    case 'pending':
    case 'building':
    case 'deploying':
      return <Badge size="sm" variant="info">Deploying</Badge>;
    case 'failed':
      return <Badge size="sm" variant="destructive">Failed</Badge>;
    case 'stopped':
      return <Badge size="sm" variant="muted">Stopped</Badge>;
  }
}

interface AppCardProps {
  app: ProjectApp;
  busySlug: 'deploy' | 'stop' | null;
  onDeploy: () => void;
  onStop: () => void;
  onLogs: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function AppCard({ app, busySlug, onDeploy, onStop, onLogs, onEdit, onDelete }: AppCardProps) {
  const dep = app.latest_deployment;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-background px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-medium text-foreground">{app.name}</h4>
            {statusBadge(app)}
            {!app.enabled && (
              <Badge size="sm" variant="outline">
                Disabled
              </Badge>
            )}
            {app.drift && app.enabled && (
              <Badge size="sm" variant="warning">
                Out of date
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{app.slug}</span>
            {app.framework && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span>{app.framework}</span>
              </>
            )}
            {dep?.live_url && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <a
                  href={dep.live_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground hover:underline"
                >
                  {dep.live_url.replace(/^https?:\/\//, '')}
                  <IconExternal className="size-3" />
                </a>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant={app.drift && app.enabled ? 'default' : 'outline'}
            onClick={onDeploy}
            disabled={busySlug === 'deploy'}
          >
            {busySlug === 'deploy' ? (
              <IconLoader className="size-3.5 animate-spin" />
            ) : (
              <IconDeploy className="size-3.5" />
            )}
            Deploy
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="More actions">
                <IconChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onLogs} disabled={!dep}>
                <IconTerminal className="size-3.5" />
                View logs
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>
                <IconEdit className="size-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onStop}
                disabled={!dep || dep.status === 'stopped' || busySlug === 'stop'}
              >
                <IconStop className="size-3.5" />
                Stop
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} variant="destructive">
                <IconDelete className="size-3.5" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {dep?.error && (
        <p className="rounded-md bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {dep.error}
        </p>
      )}
    </div>
  );
}
