'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  ExternalLink,
  GitBranch,
  Github,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { ProjectCreateModal } from '@/components/projects/project-create-modal';
import {
  archiveProject,
  listAccounts,
  listProjectsForAccount,
  type KortixProject,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCurrentAccountStore } from '@/stores/current-account-store';

function repoSlug(repoUrl: string) {
  const cleaned = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  return cleaned.split(/[/:]/).filter(Boolean).slice(-2).join('/');
}

function relativeTime(input: string) {
  const date = new Date(input);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function repoAvatar(repoUrl: string) {
  const slug = repoSlug(repoUrl);
  const ch = slug.split('/').pop()?.[0]?.toUpperCase() || 'K';
  return ch;
}

function ProjectCard({
  project,
  onOpen,
  onArchive,
  archiving,
}: {
  project: KortixProject;
  onOpen: () => void;
  onArchive: () => void;
  archiving: boolean;
}) {
  const slug = repoSlug(project.repo_url);
  const updatedLabel = relativeTime(project.updated_at);
  const canManageProject = project.effective_project_role === 'manager' || !project.effective_project_role;

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-xl border border-border/70 bg-card transition-all',
        'hover:border-foreground/30 hover:shadow-sm',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-1 flex-col items-start gap-3 p-5 text-left focus-visible:outline-none"
      >
        <div className="flex w-full items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-sm font-semibold text-foreground">
            {repoAvatar(project.repo_url)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{project.name}</h3>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Github className="h-3 w-3" />
              <span className="truncate font-mono">{slug}</span>
            </div>
          </div>
        </div>
      </button>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono truncate">{project.default_branch}</span>
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {updatedLabel}
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={onOpen}>
              Open project
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                if (typeof window !== 'undefined') {
                  const url = project.repo_url
                    .replace(/\.git$/, '')
                    .replace(/^git@github\.com:/, 'https://github.com/');
                  window.open(url, '_blank', 'noopener,noreferrer');
                }
              }}
              className="gap-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View on GitHub
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onArchive}
              disabled={archiving || !canManageProject}
              className="gap-2 text-destructive focus:text-destructive"
            >
              {archiving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const [query, setQuery] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // Project selector elsewhere in the app can deep-link to "open the new
  // project modal" via ?new=1. Consume it once on mount, then strip the
  // query so reloads don't keep popping the modal.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModalOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      window.history.replaceState(null, '', url.toString());
    }
  }, [searchParams]);

  const projectsQuery = useQuery({
    queryKey: ['projects', selectedAccountId],
    queryFn: () => listProjectsForAccount(selectedAccountId || undefined),
    enabled: !!user && !!selectedAccountId,
    staleTime: 20_000,
  });

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

  const selectedAccount = accountsQuery.data?.find((account) => account.account_id === selectedAccountId);
  const canCreateProjects =
    selectedAccount?.account_role === 'owner' || selectedAccount?.account_role === 'admin';

  const archiveMutation = useMutation({
    mutationFn: archiveProject,
    onMutate: (projectId) => setArchivingId(projectId),
    onSettled: () => setArchivingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project archived');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to archive project');
    },
  });

  const filtered = useMemo(() => {
    const items = projectsQuery.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((project) =>
      [project.name, project.repo_url, project.default_branch]
        .some((value) => value.toLowerCase().includes(q)),
    );
  }, [projectsQuery.data, query]);

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const total = projectsQuery.data?.length ?? 0;
  const showEmptyState = !projectsQuery.isLoading && !projectsQuery.isError && total === 0;
  const showNoResults = !projectsQuery.isLoading && !projectsQuery.isError && total > 0 && filtered.length === 0;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Projects</h1>
            <p className="text-sm text-muted-foreground">
              Every project is one Git repo. Sessions branch off it.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects..."
                className="pl-9"
              />
            </div>
            <Button
              onClick={() => setModalOpen(true)}
              disabled={!selectedAccountId || !canCreateProjects}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add new
            </Button>
          </div>

          {projectsQuery.isLoading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-36 rounded-xl" />
              ))}
            </div>
          )}

          {projectsQuery.isError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
              <p className="text-sm font-medium text-destructive">Failed to load projects</p>
              <p className="mt-1 text-xs text-destructive/80">
                {(projectsQuery.error as Error).message}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => projectsQuery.refetch()}>
                Retry
              </Button>
            </div>
          )}

          {showEmptyState && (
            <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-12 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-border/70 bg-card">
                <Github className="h-5 w-5 text-muted-foreground" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">No projects yet</h2>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
                Connect any Git repo as a Kortix project. The repo becomes the source of truth for
                agents, skills, triggers, and persistent files.
              </p>
              <Button
                onClick={() => setModalOpen(true)}
                disabled={!selectedAccountId || !canCreateProjects}
                className="mt-5 gap-1.5"
              >
                <Plus className="h-4 w-4" />
                Add new project
              </Button>
            </div>
          )}

          {showNoResults && (
            <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-10 text-center">
              <Search className="mx-auto h-5 w-5 text-muted-foreground" />
              <h2 className="mt-3 text-sm font-medium text-foreground">No matches for &ldquo;{query}&rdquo;</h2>
              <p className="mt-1 text-xs text-muted-foreground">Try a different search term.</p>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((project) => (
                <ProjectCard
                  key={project.project_id}
                  project={project}
                  onOpen={() => router.push(`/projects/${project.project_id}`)}
                  onArchive={() => archiveMutation.mutate(project.project_id)}
                  archiving={archivingId === project.project_id}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <ProjectCreateModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        accountId={selectedAccountId}
      />
    </div>
  );
}
