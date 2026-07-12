'use client';

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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import {
  ApiError,
  type AppSource,
  type DeploymentStatus,
  type ProjectApp,
  type ProjectAppLogsResponse,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppWindow,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

function isTransitional(status: DeploymentStatus | undefined): boolean {
  return status === 'pending' || status === 'building' || status === 'deploying';
}

/** The apps surface 404s when the project's experimental `apps` flag is off. */
function isFeatureDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function sourceSummary(source: AppSource): string {
  if (source.type === 'tar') return source.url;
  const repo = source.repo ?? 'git';
  return source.branch ? `${repo} #${source.branch}` : repo;
}

function formatLogs(res: ProjectAppLogsResponse | undefined): string {
  const data = res?.data;
  if (typeof data === 'string') return data;
  if (Array.isArray(data) && data.every((line) => typeof line === 'string')) return data.join('\n');
  return data == null ? '' : JSON.stringify(data, null, 2);
}

export function AppsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['apps', projectId] as const;
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const apps = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).apps.list(),
    refetchInterval: (query) =>
      (query.state.data?.apps ?? []).some((a) => isTransitional(a.latest_deployment?.status))
        ? 5000
        : false,
  });

  const deploy = useMutation({
    mutationFn: (slug: string) => kortix.project(projectId).apps.deploy(slug),
    onSuccess: (res) => {
      refresh();
      if (res.status === 'failed') {
        toast.error(res.deployment?.error ?? `Deployment of ${res.app_slug} failed`);
      } else {
        toast.success(`${res.app_slug} deployed`);
      }
    },
    onError: () => toast.error('Could not deploy app'),
  });

  const stop = useMutation({
    mutationFn: (slug: string) => kortix.project(projectId).apps.stop(slug),
    onSuccess: () => {
      refresh();
      toast.success('App stopped');
    },
    onError: () => toast.error('Could not stop app'),
  });

  const enableApps = useMutation({
    mutationFn: () => kortix.project(projectId).updateExperimentalFeature('apps', true),
    onSuccess: () => {
      refresh();
      toast.success('Apps enabled for this project');
    },
    onError: () => toast.error('Could not enable apps'),
  });

  const items: ProjectApp[] = apps.data?.apps ?? [];
  const parseErrors = apps.data?.errors ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <AppWindow className="size-4 text-muted-foreground" /> Apps
          </div>
          <p className="text-xs text-muted-foreground">
            Deployable apps for this project. Apps declared in kortix.yaml also show up here.
          </p>
        </div>
        <NewAppDialog projectId={projectId} onCreated={refresh} />
      </div>

      {parseErrors.length > 0 && (
        <Card className="border-destructive/50 bg-destructive/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert className="size-4" /> Manifest errors
          </div>
          <div className="mt-2 space-y-1 font-mono text-xs text-destructive">
            {parseErrors.map((e) => (
              <div key={`${e.slug}:${e.path}`}>
                {e.slug} ({e.path}): {e.error}
              </div>
            ))}
          </div>
        </Card>
      )}

      {apps.isLoading && (
        <Card className="space-y-2 p-5">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-72" />
        </Card>
      )}

      {apps.isError &&
        (isFeatureDisabled(apps.error) ? (
          <Card className="p-6 text-center">
            <p className="text-sm font-medium">Apps are off for this project</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              App deployments are experimental. Turn them on to declare apps in kortix.yaml and
              deploy them from here.
            </p>
            <Button
              size="sm"
              className="mt-4 gap-1.5"
              disabled={enableApps.isPending}
              onClick={() => enableApps.mutate()}
            >
              {enableApps.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Enable apps
            </Button>
          </Card>
        ) : (
          <Card className="flex items-center justify-between gap-3 p-5">
            <p className="text-sm text-destructive">Could not load apps.</p>
            <Button variant="outline" size="sm" onClick={() => apps.refetch()}>
              Retry
            </Button>
          </Card>
        ))}

      {apps.isSuccess && items.length === 0 && (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">No apps yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one here or declare it in kortix.yaml, then deploy.
          </p>
        </Card>
      )}

      {items.map((app) => {
        const dep = app.latest_deployment;
        const running = dep?.status === 'active';
        const deploying = deploy.isPending && deploy.variables === app.slug;
        const stopping = stop.isPending && stop.variables === app.slug;
        return (
          <Card key={app.slug} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{app.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{app.slug}</span>
                  <StatusBadge status={dep?.status} />
                  {!app.enabled && <Badge variant="outline">disabled</Badge>}
                  {app.drift && <Badge variant="outline">drift</Badge>}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {sourceSummary(app.source)}
                </div>
                {dep?.live_url && (
                  <a
                    href={dep.live_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-xs underline-offset-2 hover:underline"
                  >
                    <span className="truncate">{dep.live_url.replace(/^https?:\/\//, '')}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                )}
                <div className="text-xs text-muted-foreground tabular-nums">
                  {dep
                    ? `v${dep.version} · created ${relativeTime(dep.created_at)} · updated ${relativeTime(dep.updated_at)}`
                    : 'Never deployed'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-muted-foreground"
                  disabled={deploying || isTransitional(dep?.status)}
                  onClick={() => deploy.mutate(app.slug)}
                  aria-label={`Deploy ${app.slug}`}
                >
                  {deploying ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Rocket className="size-4" />
                  )}
                </Button>
                {running && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-muted-foreground"
                    disabled={stopping}
                    onClick={() => stop.mutate(app.slug)}
                    aria-label={`Stop ${app.slug}`}
                  >
                    {stopping ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Square className="size-4" />
                    )}
                  </Button>
                )}
                <LogsDialog projectId={projectId} slug={app.slug} />
                <DeleteAppDialog projectId={projectId} app={app} onDeleted={refresh} />
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: DeploymentStatus | undefined }) {
  if (!status) return <Badge variant="outline">not deployed</Badge>;
  if (isTransitional(status)) {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
        {status}
      </Badge>
    );
  }
  const variant = status === 'active' ? 'default' : status === 'failed' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}

function NewAppDialog({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [sourceType, setSourceType] = useState<'git' | 'tar'>('git');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [tarUrl, setTarUrl] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const source: AppSource =
        sourceType === 'git'
          ? { type: 'git', repo: repo.trim(), branch: branch.trim() || null, root_path: null }
          : { type: 'tar', url: tarUrl.trim() };
      return kortix.project(projectId).apps.create({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        source,
      });
    },
    onSuccess: () => {
      setName('');
      setSlug('');
      setRepo('');
      setBranch('');
      setTarUrl('');
      setOpen(false);
      onCreated();
      toast.success('App created');
    },
    onError: () => toast.error('Could not create app'),
  });

  const valid =
    name.trim().length > 0 &&
    (sourceType === 'git' ? repo.trim().length > 0 : tarUrl.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> New app
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New app</DialogTitle>
          <DialogDescription>
            Register a deployable app. Deploy it from the list once created.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input
                id="app-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Marketing site"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-slug">Slug (optional)</Label>
              <Input
                id="app-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="marketing-site"
                className="font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={sourceType} onValueChange={(v) => setSourceType(v as 'git' | 'tar')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="git">git</SelectItem>
                <SelectItem value="tar">tar</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {sourceType === 'git' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="app-repo">Repository URL</Label>
                <Input
                  id="app-repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="https://github.com/acme/site"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="app-branch">Branch (optional)</Label>
                <Input
                  id="app-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="font-mono"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="app-tar">Tarball URL</Label>
              <Input
                id="app-tar"
                value={tarUrl}
                onChange={(e) => setTarUrl(e.target.value)}
                placeholder="https://example.com/site.tar.gz"
                className="font-mono"
              />
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending && <Loader2 className="size-4 animate-spin" />}
              Create app
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LogsDialog({ projectId, slug }: { projectId: string; slug: string }) {
  const [open, setOpen] = useState(false);

  const logs = useQuery({
    queryKey: ['apps', projectId, 'logs', slug],
    queryFn: () => kortix.project(projectId).apps.logs(slug),
    enabled: open,
  });

  const failed = logs.isError || (logs.isSuccess && !logs.data.ok);
  const text = formatLogs(logs.data);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          Logs
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{slug}</DialogTitle>
          <DialogDescription>Deployment logs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-muted-foreground"
              disabled={logs.isFetching}
              onClick={() => logs.refetch()}
              aria-label={`Refresh logs for ${slug}`}
            >
              <RefreshCw className={logs.isFetching ? 'size-4 animate-spin' : 'size-4'} />
            </Button>
          </div>
          {logs.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : failed ? (
            <p className="text-sm text-destructive">
              {(logs.data && !logs.data.ok && logs.data.error) || 'Could not load logs.'}
            </p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-md border border-border bg-secondary/50 p-3 font-mono text-xs whitespace-pre-wrap">
              {text || 'No logs.'}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAppDialog({
  projectId,
  app,
  onDeleted,
}: {
  projectId: string;
  app: ProjectApp;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: () => kortix.project(projectId).apps.remove(app.slug),
    onSuccess: () => {
      setOpen(false);
      onDeleted();
      toast.success('App deleted');
    },
    onError: () => toast.error('Could not delete app'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          aria-label={`Delete ${app.slug}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {app.name}?</DialogTitle>
          <DialogDescription>
            This removes the app and its deployments. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
