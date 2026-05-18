'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Github,
  Globe,
  Loader2,
  Lock,
  Plus,
  Search,
} from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { createProject, createProjectRepo } from '@/lib/projects-client';

interface ProjectCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
}

interface GitHubRepoMin {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  clone_url: string;
  updated_at: string;
}

export function ProjectCreateModal({ open, onOpenChange, accountId }: ProjectCreateModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Create form
  const [newName, setNewName] = useState('');
  const [newPrivate, setNewPrivate] = useState(true);

  // Import section
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState('');

  // GitHub OAuth state — provider_token lives only in component state. If the
  // modal closes, the user re-connects on next open. Persistence is future
  // work (would need encrypted token storage + refresh on the backend).
  const [ghToken, setGhToken] = useState<string | null>(null);
  const [ghLogin, setGhLogin] = useState<string | null>(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepoMin[] | null>(null);
  const [repoQuery, setRepoQuery] = useState('');

  function resetAndClose() {
    setNewName('');
    setNewPrivate(true);
    setImportOpen(false);
    setImportUrl('');
    setGhToken(null);
    setGhLogin(null);
    setGhError(null);
    setRepos(null);
    setRepoQuery('');
    setGhLoading(false);
    onOpenChange(false);
  }

  // Receive provider_token from the /auth/github-connect popup, then fetch
  // the user's repos directly from GitHub.
  useEffect(() => {
    if (!open) return;
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; provider_token?: string; github_login?: string; message?: string };
      if (!data || typeof data !== 'object') return;

      if (data.type === 'github-connect-success' && typeof data.provider_token === 'string') {
        const token = data.provider_token;
        setGhToken(token);
        setGhLogin(data.github_login ?? null);
        setGhError(null);
        setGhLoading(true);
        try {
          const res = await fetch(
            'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator',
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
              },
            },
          );
          if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
          const list = (await res.json()) as GitHubRepoMin[];
          setRepos(list);
        } catch (err) {
          setGhError((err as Error).message || 'Failed to load GitHub repos');
        } finally {
          setGhLoading(false);
        }
      } else if (data.type === 'github-connect-error') {
        setGhError(typeof data.message === 'string' ? data.message : 'Failed to connect GitHub');
        setGhLoading(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open]);

  const createRepoMutation = useMutation({
    mutationFn: createProjectRepo,
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

  const importMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project imported');
      resetAndClose();
      router.push(`/projects/${project.project_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to import repository');
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const name = newName.trim();
    if (!name) return toast.error('Project name is required');
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return toast.error('Use letters, numbers, hyphens, underscores, or dots only');
    }
    createRepoMutation.mutate({ account_id: accountId, name, private: newPrivate });
  }

  function handleImportUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId) return toast.error('Select an account first');
    const url = importUrl.trim();
    if (!url) return toast.error('Add a Git repo URL');
    importMutation.mutate({ account_id: accountId, repo_url: url });
  }

  function handleImportRepo(repo: GitHubRepoMin) {
    if (!accountId) return toast.error('Select an account first');
    importMutation.mutate({
      account_id: accountId,
      name: repo.name,
      repo_url: repo.clone_url,
      default_branch: repo.default_branch,
    });
  }

  function openGitHubPopup() {
    setGhError(null);
    setRepos(null);
    setGhLoading(true);
    const w = 540;
    const h = 720;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(
      '/auth/github-connect',
      'github-connect',
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,resizable=yes`,
    );
    if (!popup) {
      setGhError('Pop-up blocked. Allow pop-ups for this site and try again.');
      setGhLoading(false);
    }
  }

  const submitting = createRepoMutation.isPending || importMutation.isPending;

  const filteredRepos = useMemo(() => {
    if (!repos) return null;
    const q = repoQuery.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [repos, repoQuery]);

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">New project</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            A fresh workspace on Kortix — ready in seconds.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="px-6 pb-4 space-y-4">
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

          <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card px-3 py-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              {newPrivate ? (
                <Lock className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <Globe className="h-3.5 w-3.5 text-emerald-600" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground leading-tight">
                  {newPrivate ? 'Private' : 'Public'}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {newPrivate ? 'Only you and collaborators can see this' : 'Anyone with the link can view'}
                </p>
              </div>
            </div>
            <Switch checked={!newPrivate} onCheckedChange={(v) => setNewPrivate(!v)} />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={resetAndClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" className="gap-1.5" disabled={submitting || !accountId}>
              {createRepoMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create project
            </Button>
          </div>
        </form>

        <div className="border-t border-border/60 bg-muted/30">
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            className="flex w-full items-center justify-between px-6 py-3 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>Or import an existing Git repo</span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', importOpen && 'rotate-180')}
            />
          </button>

          {importOpen && (
            <div className="space-y-4 border-t border-border/60 px-6 py-4">
              {!ghToken ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Connect your GitHub account to pick a repository.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={openGitHubPopup}
                    disabled={ghLoading}
                    className="w-full gap-2"
                  >
                    {ghLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Github className="h-4 w-4" />
                    )}
                    Connect GitHub
                  </Button>
                  {ghError && <p className="text-xs text-destructive">{ghError}</p>}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Connected{ghLogin ? ` as ${ghLogin}` : ''}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setGhToken(null);
                        setGhLogin(null);
                        setRepos(null);
                        setRepoQuery('');
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Disconnect
                    </button>
                  </div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={repoQuery}
                      onChange={(e) => setRepoQuery(e.target.value)}
                      placeholder="Search your repos"
                      className="h-9 pl-8 text-sm"
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60 bg-background">
                    {filteredRepos === null ? (
                      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading repositories…
                      </div>
                    ) : filteredRepos.length === 0 ? (
                      <div className="p-3 text-xs text-muted-foreground">No matches.</div>
                    ) : (
                      <ul className="divide-y divide-border/60">
                        {filteredRepos.map((repo) => (
                          <li key={repo.id}>
                            <button
                              type="button"
                              onClick={() => handleImportRepo(repo)}
                              disabled={importMutation.isPending}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-50"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-foreground">
                                  {repo.full_name}
                                </p>
                                {repo.description && (
                                  <p className="truncate text-xs text-muted-foreground">
                                    {repo.description}
                                  </p>
                                )}
                              </div>
                              {repo.private && (
                                <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              <form onSubmit={handleImportUrl} className="space-y-2 border-t border-border/60 pt-3">
                <Label htmlFor="import-url" className="text-xs font-medium text-muted-foreground">
                  Or paste a Git URL
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="import-url"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    className="font-mono text-xs h-9"
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={submitting || !accountId}
                  >
                    {importMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      'Import'
                    )}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
