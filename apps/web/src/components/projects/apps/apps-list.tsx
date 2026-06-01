'use client';

/**
 * Apps list — the default section of the Apps overlay.
 *
 * Shows one card per `[[apps]]` entry, with status, live URL, and per-app
 * actions (Deploy now, Stop, Logs, Edit, Remove). The empty state nudges
 * the user to ship their first app.
 */

import { useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from '@/lib/toast';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDelete,
  IconDeploy,
  IconEdit,
  IconExternal,
  IconLink,
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
            Point an app at a folder in your repo and Kortix handles the build
            and a free <code className="font-mono">*.style.dev</code> URL — no
            hosting setup. Or just ask your agent to build one and add it.
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
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {apps.length} {apps.length === 1 ? 'app' : 'apps'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Websites deployed from this project. Defined in{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">kortix.toml</code>
            {' '}— changes here commit to your repo.
          </p>
        </div>
        <Button size="sm" onClick={onAdd} className="shrink-0">
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
                    const url = res.deployment?.live_url;
                    toast.success(
                      `${app.name} is live`,
                      url ? { description: url.replace(/^https?:\/\//, '') } : undefined,
                    );
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

/** Human label for an app's source — "this project", a repo, or a tarball. */
function sourceLabel(app: ProjectApp): string {
  const src = app.source;
  if (src.type === 'tar') return 'tarball';
  // git
  const folder = src.root_path ? `/${src.root_path}` : '';
  if (!src.repo) return `this project${folder}`;
  const repo = src.repo.replace(/^https?:\/\//, '').replace(/\.git$/, '');
  const branch = src.branch ? `@${src.branch}` : '';
  return `${repo}${branch}${folder}`;
}

/** "deployed 3m ago" for the latest deployment, best-effort. */
function deployedAgo(dep: ProjectApp['latest_deployment']): string | null {
  if (!dep) return null;
  try {
    return formatDistanceToNowStrict(new Date(dep.updated_at || dep.created_at), { addSuffix: true });
  } catch {
    return null;
  }
}

/** Copy-to-clipboard chip with a brief check confirmation. */
function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Copy URL"
          onClick={() => {
            navigator.clipboard?.writeText(url).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              },
              () => toast.error('Could not copy'),
            );
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <IconCheck className="size-3.5 text-emerald-500" /> : <IconCopy className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{copied ? 'Copied' : 'Copy URL'}</TooltipContent>
    </Tooltip>
  );
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
  const isLive = dep?.status === 'active' && !!dep.live_url;
  const isDeploying = dep?.status === 'pending' || dep?.status === 'building' || dep?.status === 'deploying';
  // Where this app serves: the live URL once deployed, else where it WILL go.
  const liveUrl = dep?.live_url ?? null;
  const targetDomain = app.effective_domains?.[0] ?? app.domains?.[0] ?? null;
  const displayUrl = liveUrl ?? (targetDomain ? `https://${targetDomain}` : null);
  const ago = deployedAgo(dep);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-background px-4 py-3.5 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-medium text-foreground">{app.name}</h4>
            {statusBadge(app)}
            {!app.enabled && <Badge size="sm" variant="outline">Disabled</Badge>}
            {app.drift && app.enabled && dep && <Badge size="sm" variant="warning">Out of date</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{app.slug}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="inline-flex items-center gap-1" title="Source">
              <IconLink className="size-3" />
              {sourceLabel(app)}
            </span>
            {app.framework && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span>{app.framework}</span>
              </>
            )}
            {ago && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="inline-flex items-center gap-1">
                  <IconClock className="size-3" />
                  {ago}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isLive && (
            <Button size="sm" variant="outline" asChild>
              <a href={liveUrl!} target="_blank" rel="noopener noreferrer">
                <IconExternal className="size-3.5" />
                Open
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant={app.drift && app.enabled ? 'default' : 'outline'}
            onClick={onDeploy}
            disabled={busySlug === 'deploy' || isDeploying}
          >
            {busySlug === 'deploy' || isDeploying ? (
              <IconLoader className="size-3.5 animate-spin" />
            ) : (
              <IconDeploy className="size-3.5" />
            )}
            {isDeploying ? 'Deploying' : dep ? 'Redeploy' : 'Deploy'}
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

      {/* URL row — the address this app serves on, with a copy button. Muted
          (not a link) until it's actually live. */}
      {displayUrl && (
        <div className="flex items-center gap-1.5 rounded-lg bg-muted/40 px-2.5 py-1.5">
          {isLive ? (
            <a
              href={liveUrl!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-xs text-foreground/90 hover:text-foreground hover:underline"
            >
              {displayUrl.replace(/^https?:\/\//, '')}
              <IconExternal className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title="Deploys here">
              {displayUrl.replace(/^https?:\/\//, '')}
            </span>
          )}
          <CopyUrlButton url={displayUrl} />
        </div>
      )}

      {dep?.error && (
        <p className="rounded-md bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {dep.error}
        </p>
      )}
    </div>
  );
}
