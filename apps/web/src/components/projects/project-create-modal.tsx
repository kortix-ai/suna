'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Github, Loader2, Plus } from 'lucide-react';
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
import {
  getGitHubInstallation,
  linkRepository,
  listGitHubRepositories,
  provisionProject,
} from '@/lib/projects-client';

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
}

/**
 * New project defaults to a managed Kortix git repo, with an explicit GitHub
 * import path backed by the GitHub App installation.
 */
export function ProjectCreateModal({ open, onOpenChange, accountId }: ProjectCreateModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'managed' | 'github'>('managed');
  const [newName, setNewName] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [fallbackRepoUrl, setFallbackRepoUrl] = useState('');

  function resetAndClose() {
    setMode('managed');
    setNewName('');
    setSelectedRepo('');
    setFallbackRepoUrl('');
    onOpenChange(false);
  }

  const createMutation = useMutation({
    mutationFn: provisionProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project created');
      resetAndClose();
      router.push(`/projects/${project.project_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create project');
    },
  });

  const githubInstallationQuery = useQuery({
    queryKey: ['github-installation', accountId],
    queryFn: () => getGitHubInstallation(accountId!),
    enabled: open && mode === 'github' && !!accountId,
    staleTime: 30_000,
  });

  const githubReposQuery = useQuery({
    queryKey: ['github-repositories', accountId],
    queryFn: () => listGitHubRepositories(accountId!),
    enabled: open && mode === 'github' && !!accountId && githubInstallationQuery.data?.installed === true,
    staleTime: 30_000,
  });

  const linkMutation = useMutation({
    mutationFn: linkRepository,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Repository linked');
      resetAndClose();
      router.push(`/projects/${result.project.project_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to link repository');
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const name = newName.trim();
    if (!name) return toast.error('Project name is required');
    if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
      return toast.error('Use letters, numbers, spaces, hyphens, underscores, or dots only');
    }
    createMutation.mutate({ account_id: accountId, name });
  }

  function handleLinkGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const repoFullName = selectedRepo.trim();
    const repoUrl = fallbackRepoUrl.trim();
    if (!repoFullName && !repoUrl) return toast.error('Select a GitHub repository');
    linkMutation.mutate({
      account_id: accountId,
      ...(repoFullName ? { repo_full_name: repoFullName } : { repo_url: repoUrl }),
      ...(newName.trim() ? { name: newName.trim() } : {}),
    });
  }

  const submitting = createMutation.isPending || linkMutation.isPending;
  const installUrl = githubInstallationQuery.data?.install_url;
  const repos = githubReposQuery.data?.repositories ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">New project</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Create a managed repo or import one from GitHub.
          </DialogDescription>
        </DialogHeader>

        <div className="mx-6 mb-4 grid grid-cols-2 rounded-md border border-border/70 bg-muted/30 p-1">
          <Button
            type="button"
            variant={mode === 'managed' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setMode('managed')}
          >
            <Plus className="h-3.5 w-3.5" />
            Managed
          </Button>
          <Button
            type="button"
            variant={mode === 'github' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setMode('github')}
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
          </Button>
        </div>

        {mode === 'managed' ? (
          <form onSubmit={handleCreate} className="px-6 pb-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-name" className="text-xs font-medium text-muted-foreground">
                Project name
              </Label>
              <Input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-agi-company"
                autoCapitalize="none"
                autoCorrect="off"
                className="font-mono text-sm h-10"
                autoFocus
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={resetAndClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" className="gap-1.5" disabled={submitting || !accountId}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create project
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleLinkGitHub} className="px-6 pb-6 space-y-4">
            {githubInstallationQuery.isLoading ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading GitHub
              </div>
            ) : !githubInstallationQuery.data?.installed ? (
              <div className="space-y-3 rounded-md border border-border/70 p-4">
                <p className="text-sm text-muted-foreground">
                  Connect the Kortix GitHub App to import private repositories.
                </p>
                <Button
                  type="button"
                  className="gap-1.5"
                  disabled={!installUrl}
                  onClick={() => {
                    if (installUrl) window.location.href = installUrl;
                  }}
                >
                  <Github className="h-4 w-4" />
                  Connect GitHub
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="github-repo" className="text-xs font-medium text-muted-foreground">
                    Repository
                  </Label>
                  <select
                    id="github-repo"
                    value={selectedRepo}
                    onChange={(event) => setSelectedRepo(event.target.value)}
                    disabled={githubReposQuery.isLoading || submitting}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">
                      {githubReposQuery.isLoading ? 'Loading repositories...' : 'Select a repository'}
                    </option>
                    {repos.map((repo) => (
                      <option key={repo.id} value={repo.full_name}>
                        {repo.full_name}{repo.private ? ' (private)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {repos.length === 0 && !githubReposQuery.isLoading ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="github-url" className="text-xs font-medium text-muted-foreground">
                      Repository URL
                    </Label>
                    <Input
                      id="github-url"
                      value={fallbackRepoUrl}
                      onChange={(e) => setFallbackRepoUrl(e.target.value)}
                      placeholder="https://github.com/acme/repo"
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="font-mono text-sm h-10"
                    />
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor="github-project-name" className="text-xs font-medium text-muted-foreground">
                    Project name
                  </Label>
                  <Input
                    id="github-project-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Use repository name"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="text-sm h-10"
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={resetAndClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="gap-1.5"
                disabled={
                  submitting ||
                  !accountId ||
                  !githubInstallationQuery.data?.installed ||
                  (!selectedRepo && !fallbackRepoUrl.trim())
                }
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
                Import repo
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
