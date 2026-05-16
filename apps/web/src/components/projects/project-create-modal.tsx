'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ExternalLink, Github, Globe, Loader2, Lock, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  createProject,
  createProjectRepo,
  getGitHubInstallation,
  type GitHubInstallationStatus,
} from '@/lib/projects-client';

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
}

export function ProjectCreateModal({ open, onOpenChange, accountId }: ProjectCreateModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'create' | 'import'>('create');

  // Create-new state
  const [newName, setNewName] = useState('');
  const [newPrivate, setNewPrivate] = useState(true);

  // Import state
  const [repoUrl, setRepoUrl] = useState('');
  const [importName, setImportName] = useState('');
  const [importBranch, setImportBranch] = useState('main');

  function resetAndClose() {
    setNewName('');
    setNewPrivate(true);
    setRepoUrl('');
    setImportName('');
    setImportBranch('main');
    onOpenChange(false);
  }

  const createRepoMutation = useMutation({
    mutationFn: createProjectRepo,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Repository created');
      resetAndClose();
      router.push(`/projects/${project.project_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create repository');
    },
  });

  const importMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project connected');
      resetAndClose();
      router.push(`/projects/${project.project_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to import repository');
    },
  });

  const githubInstallationQuery = useQuery({
    queryKey: ['github-installation', accountId],
    queryFn: () => getGitHubInstallation(accountId!),
    enabled: open && tab === 'create' && Boolean(accountId),
    staleTime: 30_000,
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const name = newName.trim();
    if (!name) return toast.error('Project name is required');
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return toast.error('Use letters, numbers, hyphens, underscores, or dots only');
    }
    createRepoMutation.mutate({
      account_id: accountId,
      name,
      private: newPrivate,
    });
  }

  function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const url = repoUrl.trim();
    if (!url) return toast.error('Add a Git repo URL');
    importMutation.mutate({
      account_id: accountId,
      name: importName.trim() || undefined,
      repo_url: url,
      default_branch: importBranch.trim() || 'main',
    });
  }

  const submitting = createRepoMutation.isPending || importMutation.isPending;
  const createBlockedByGitHub =
    githubInstallationQuery.isLoading || (githubInstallationQuery.data?.requires_installation ?? false);

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-lg font-semibold tracking-tight">New project</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Every project is one Git repo. Create a fresh one or import existing.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'create' | 'import')} className="px-6 pt-4 gap-0">
          <TabsList className="w-full">
            <TabsTrigger value="create" className="text-xs">
              <Sparkles className="h-3.5 w-3.5" />
              Create new
            </TabsTrigger>
            <TabsTrigger value="import" className="text-xs">
              <Github className="h-3.5 w-3.5" />
              Import Git repo
            </TabsTrigger>
          </TabsList>

          <TabsContent value="create" className="mt-4 mb-2 focus-visible:outline-none">
            <form onSubmit={handleCreate} className="space-y-4">
              {accountId ? (
                <GitHubInstallationPanel
                  status={githubInstallationQuery.data}
                  loading={githubInstallationQuery.isLoading}
                  error={githubInstallationQuery.error as Error | null}
                />
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="new-name">Repository name</Label>
                <Input
                  id="new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="my-agi-company"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="font-mono text-sm"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  We&apos;ll create a fresh GitHub repository with the Kortix starter.
                </p>
              </div>

              <div className="rounded-lg border border-border/70 bg-card p-3 flex items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={cn(
                    'mt-0.5 flex h-7 w-7 items-center justify-center rounded-md border',
                    newPrivate
                      ? 'border-foreground/20 bg-foreground/5 text-foreground'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
                  )}>
                    {newPrivate ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {newPrivate ? 'Private repository' : 'Public repository'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {newPrivate
                        ? 'Only collaborators can see code and config.'
                        : 'Anyone on the internet can see this repo.'}
                    </p>
                  </div>
                </div>
                <Switch checked={!newPrivate} onCheckedChange={(v) => setNewPrivate(!v)} />
              </div>

              <DialogFooterRow>
                <Button type="button" variant="ghost" onClick={resetAndClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="gap-1.5"
                  disabled={submitting || !accountId || createBlockedByGitHub}
                >
                  {createRepoMutation.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Plus className="h-4 w-4" />}
                  Create project
                </Button>
              </DialogFooterRow>
            </form>
          </TabsContent>

          <TabsContent value="import" className="mt-4 mb-2 focus-visible:outline-none">
            <form onSubmit={handleImport} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="import-url">Git repository URL</Label>
                <Input
                  id="import-url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="font-mono text-xs"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Public repos work out of the box. Private repos need our token to have access.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="import-name">Project name</Label>
                  <Input
                    id="import-name"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="Auto from repo"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="import-branch">Base branch</Label>
                  <Input
                    id="import-branch"
                    value={importBranch}
                    onChange={(e) => setImportBranch(e.target.value)}
                    placeholder="main"
                    className="font-mono text-xs"
                  />
                </div>
              </div>

              <DialogFooterRow>
                <Button type="button" variant="ghost" onClick={resetAndClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="submit" className="gap-1.5" disabled={submitting || !accountId}>
                  {importMutation.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Github className="h-4 w-4" />}
                  Connect repository
                </Button>
              </DialogFooterRow>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function GitHubInstallationPanel({
  status,
  loading,
  error,
}: {
  status: GitHubInstallationStatus | undefined;
  loading: boolean;
  error: Error | null;
}) {
  if (loading) {
    return (
      <div className="rounded-lg border border-border/70 bg-muted/30 p-3 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Checking GitHub account connection...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">GitHub connection unavailable</p>
          <p className="text-xs text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!status) return null;

  if (status.installed) {
    return (
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 flex items-center gap-3">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">GitHub connected</p>
          <p className="text-xs text-muted-foreground truncate">
            Repositories will be created under {status.owner_login}.
          </p>
        </div>
      </div>
    );
  }

  if (!status.requires_installation) return null;

  return (
    <div className="rounded-lg border border-border/70 bg-card p-3 flex items-center justify-between gap-3">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md border border-foreground/10 bg-foreground/5">
          <Github className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Connect GitHub</p>
          <p className="text-xs text-muted-foreground">
            This account needs the Kortix GitHub App before it can create repos.
          </p>
        </div>
      </div>
      {status.install_url ? (
        <Button asChild size="sm" variant="outline" className="gap-1.5 shrink-0">
          <a href={status.install_url} target="_blank" rel="noreferrer">
            Install
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground shrink-0">Not configured</span>
      )}
    </div>
  );
}

function DialogFooterRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-6 mt-4 flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
      {children}
    </div>
  );
}
