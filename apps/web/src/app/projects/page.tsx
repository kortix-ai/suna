'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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

function projectInitial(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return 'K';
  // First letter of each of the first two words, or first two letters.
  const words = trimmed.split(/[\s_\-./]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
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
  const updatedLabel = relativeTime(project.updated_at);
  const canManageProject = project.effective_project_role === 'manager' || !project.effective_project_role;

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-2xl border border-border/60 bg-card',
        'transition-all duration-150 hover:border-foreground/30 hover:bg-muted/30 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-1 cursor-pointer flex-col items-start gap-4 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-2xl"
      >
        <div className="flex w-full items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/40 text-sm font-semibold text-foreground">
            {projectInitial(project.name)}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold leading-tight text-foreground">
              {project.name}
            </h3>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              Updated {updatedLabel}
            </p>
          </div>
        </div>
      </button>

      <div className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md bg-background/80 backdrop-blur text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label="Project actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={onOpen}>Open project</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onArchive}
              disabled={archiving || !canManageProject}
              className="gap-2 text-destructive focus:text-destructive"
            >
              {archiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
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
      <main className="flex-1 px-4 py-10 sm:py-12">
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-1">
              <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
                Projects
              </h1>
              <p className="text-sm text-muted-foreground">
                Your workspaces, one place. Pick up where you left off.
              </p>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <div className="relative flex-1 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects..."
                  className="h-9 pl-9 text-sm"
                />
              </div>
              <Button
                onClick={() => setModalOpen(true)}
                disabled={!selectedAccountId || !canCreateProjects}
                size="sm"
                className="h-9 gap-1.5"
              >
                <Plus className="h-4 w-4" />
                New project
              </Button>
            </div>
          </div>

          {projectsQuery.isLoading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[92px] rounded-2xl" />
              ))}
            </div>
          )}

          {projectsQuery.isError && (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
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
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-muted/40 text-base font-semibold text-foreground">
                K
              </div>
              <h2 className="mt-5 text-base font-semibold text-foreground">
                Create your first project
              </h2>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
                A project is a workspace for one company or idea. We&apos;ll set it up in seconds — no
                Git account required.
              </p>
              <Button
                onClick={() => setModalOpen(true)}
                disabled={!selectedAccountId || !canCreateProjects}
                size="sm"
                className="mt-6 h-9 gap-1.5"
              >
                <Plus className="h-4 w-4" />
                New project
              </Button>
            </div>
          )}

          {showNoResults && (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 p-10 text-center">
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
