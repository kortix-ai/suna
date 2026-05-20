'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Page,
  PageBody,
  PageHeader,
  Skeleton,
} from '@kortix/design-system';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { ProjectCreateModal } from '@/components/projects/project-create-modal';
import { UserAvatar } from '@/components/ui/user-avatar';
import {
  archiveProject,
  listAccounts,
  listProjectsForAccount,
  type KortixProject,
} from '@/lib/projects-client';
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

  const selectedAccount = accountsQuery.data?.find(
    (account) => account.account_id === selectedAccountId,
  );
  const canCreateProjects =
    selectedAccount?.account_role === 'owner' ||
    selectedAccount?.account_role === 'admin';
  const accountName =
    selectedAccount?.name ||
    (selectedAccount?.personal_account ? 'Personal' : 'Workspace');

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
      [project.name, project.repo_url, project.default_branch].some((value) =>
        value.toLowerCase().includes(q),
      ),
    );
  }, [projectsQuery.data, query]);

  if (authLoading || !user) {
    return (
      <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />
    );
  }

  const total = projectsQuery.data?.length ?? 0;
  const showEmptyState =
    !projectsQuery.isLoading && !projectsQuery.isError && total === 0;
  const showNoResults =
    !projectsQuery.isLoading &&
    !projectsQuery.isError &&
    total > 0 &&
    filtered.length === 0;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1">
        <Page size="md">
          <PageHeader
            className="[&_h1]:text-xl [&_h1]:tracking-[-0.015em] [&_p]:text-sm"
            eyebrow={accountName}
            eyebrowTone={total > 0 ? 'success' : 'muted'}
            title="Projects"
            description="Your workspaces, one place. Pick up where you left off."
            meta={
              <div className="relative max-w-sm">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects…"
                  className="pl-9"
                />
              </div>
            }
            actions={
              <Button
                onClick={() => setModalOpen(true)}
                disabled={!selectedAccountId || !canCreateProjects}
                size="md"
              >
                <Plus />
                New project
              </Button>
            }
          />

          <PageBody>
            {projectsQuery.isLoading ? (
              <ProjectListSkeleton />
            ) : projectsQuery.isError ? (
              <ProjectListError
                message={(projectsQuery.error as Error).message}
                onRetry={() => projectsQuery.refetch()}
              />
            ) : showEmptyState ? (
              <ProjectsEmpty
                onCreate={() => setModalOpen(true)}
                disabled={!selectedAccountId || !canCreateProjects}
              />
            ) : showNoResults ? (
              <NoResults query={query} />
            ) : (
              <section>
                <SectionRule
                  label="Projects"
                  meta={
                    query.trim()
                      ? `${filtered.length} of ${total}`
                      : `${total} ${total === 1 ? 'project' : 'projects'}`
                  }
                />
                <ColumnHeader />
                <div>
                  {filtered.map((project) => (
                    <ProjectRow
                      key={project.project_id}
                      project={project}
                      onArchive={() => archiveMutation.mutate(project.project_id)}
                      onOpen={() => router.push(`/projects/${project.project_id}`)}
                      archiving={archivingId === project.project_id}
                    />
                  ))}
                </div>
              </section>
            )}
          </PageBody>
        </Page>
      </main>

      <ProjectCreateModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        accountId={selectedAccountId}
      />
    </div>
  );
}

function SectionRule({ label, meta }: { label: string; meta?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-muted-foreground/80">
        {label}
      </span>
      {meta ? (
        <span className="font-mono text-[0.62rem] tracking-[0.04em] text-muted-foreground/70">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function ColumnHeader() {
  return (
    <div className="mt-2.5 grid grid-cols-[1.75rem_minmax(0,1fr)_auto_1rem] items-center gap-x-4 px-2 pb-2 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-muted-foreground/60">
      <span />
      <span>project</span>
      <span className="hidden text-right md:inline">role</span>
      <span />
    </div>
  );
}

function ProjectListSkeleton() {
  return (
    <section>
      <SectionRule label="Projects" meta="loading" />
      <ColumnHeader />
      <div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto_1rem] items-center gap-x-4 border-t border-border/60 px-2 py-3"
          >
            <Skeleton className="h-6 w-6 rounded-md" />
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-36" />
              <Skeleton className="h-2.5 w-24" />
            </div>
            <Skeleton className="hidden h-2.5 w-14 md:block" />
            <span />
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section>
      <SectionRule label="Projects" meta="failed" />
      <div className="mt-3 border-t border-border/60 px-3 py-8">
        <p className="font-sans text-sm font-medium text-rose-400">
          Failed to load projects
        </p>
        <p className="mt-1 font-mono text-[0.72rem] text-muted-foreground">
          {message}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    </section>
  );
}

function ProjectsEmpty({
  onCreate,
  disabled,
}: {
  onCreate: () => void;
  disabled: boolean;
}) {
  return (
    <section>
      <SectionRule label="Get started" meta="no projects yet" />
      <div className="mt-3 grid gap-4 border-t border-border/60 px-3 py-10">
        <div className="flex size-10 items-center justify-center rounded-md border border-border/70 bg-muted/40 font-mono text-[0.78rem] font-semibold text-foreground">
          K
        </div>
        <div className="space-y-1.5">
          <h2 className="font-sans text-lg font-medium tracking-[-0.01em] text-foreground">
            Create your first project
          </h2>
          <p className="max-w-md font-sans text-sm text-muted-foreground">
            A project is a workspace for one company or idea. We&apos;ll set it
            up in seconds — no Git account required.
          </p>
        </div>
        <div>
          <Button
            onClick={onCreate}
            disabled={disabled}
            size="sm"
          >
            <Plus />
            New project
          </Button>
        </div>
      </div>
    </section>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <section>
      <SectionRule label="Search" meta="no matches" />
      <div className="mt-3 border-t border-border/60 px-3 py-10">
        <p className="font-sans text-sm font-medium text-foreground">
          No matches for <span className="font-mono">&ldquo;{query}&rdquo;</span>
        </p>
        <p className="mt-1 font-mono text-[0.72rem] text-muted-foreground">
          Try a different search term.
        </p>
      </div>
    </section>
  );
}

function ProjectRow({
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
  const canManage =
    project.effective_project_role === 'manager' || !project.effective_project_role;
  const role = (project.effective_project_role || 'manager').toString();
  const updated = relativeTime(project.updated_at);

  return (
    <Link
      href={`/projects/${project.project_id}`}
      className="group/row block outline-none"
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto_1rem] items-center gap-x-4 border-t border-border/60 px-2 py-3">
        <UserAvatar email={project.project_id} size="sm" />

        <div className="min-w-0">
          <h3 className="truncate font-sans text-[0.85rem] font-medium leading-tight tracking-[-0.005em] text-foreground">
            {project.name}
          </h3>
          <div className="mt-0.5 truncate font-mono text-[0.68rem] text-muted-foreground">
            <span>updated {updated}</span>
            {project.default_branch ? (
              <>
                <span className="px-1.5 text-muted-foreground/40">·</span>
                <span>{project.default_branch}</span>
              </>
            ) : null}
            {project.repo_url ? (
              <>
                <span className="px-1.5 text-muted-foreground/40">·</span>
                <span className="truncate">{stripRepoOrigin(project.repo_url)}</span>
              </>
            ) : null}
          </div>
        </div>

        <span className="hidden font-mono text-[0.58rem] uppercase tracking-[0.16em] text-muted-foreground/60 md:inline">
          {role}
        </span>

        <span className="relative flex items-center justify-end">
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground/40 transition-all duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-foreground"
            aria-hidden
          />
          <div
            className="absolute -right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Project actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onOpen}>Open project</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onArchive}
                  disabled={archiving || !canManage}
                  variant="destructive"
                >
                  {archiving ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </span>
      </div>
    </Link>
  );
}

function stripRepoOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\.git$/, '').replace(/\/$/, '');
  } catch {
    return url;
  }
}
