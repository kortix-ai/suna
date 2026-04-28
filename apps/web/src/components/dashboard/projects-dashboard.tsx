'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ,
  ArrowUpRight,
  Clock4,
  FolderGit2,
  LayoutGrid,
  ListIcon,
  MessageSquarePlus,
  Plus,
  Search as SearchIcon,
  Sparkles,
  X,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useKortixProjects,
  type KortixProject,
} from '@/hooks/kortix/use-kortix-projects';
import { ProjectIcon } from '@/components/kortix/project-icon';
import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';

type SortKey = 'recent' | 'name' | 'created';
type ViewMode = 'list' | 'grid';

const VIEW_STORAGE_KEY = 'kortix-projects-view';

const SORTS: { key: SortKey; label: string; icon: typeof Clock4 }[] = [
  { key: 'recent', label: 'Last activity', icon: Clock4 },
  { key: 'created', label: 'Recently created', icon: Sparkles },
  { key: 'name', label: 'Name', icon: ArrowDownAZ },
];

function relativeWhen(input?: number | string | null): string | null {
  if (input == null) return null;
  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(ms)) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function projectUpdatedMs(p: KortixProject): number {
  if (p.time?.updated) return p.time.updated;
  const c = Date.parse(p.created_at || '');
  return Number.isFinite(c) ? c : 0;
}

function projectCreatedMs(p: KortixProject): number {
  if (p.time?.created) return p.time.created;
  const c = Date.parse(p.created_at || '');
  return Number.isFinite(c) ? c : 0;
}

function isActive(p: KortixProject, withinDays = 7): boolean {
  const updated = projectUpdatedMs(p);
  if (!updated) return false;
  return Date.now() - updated < withinDays * 86_400_000;
}

export function ProjectsDashboard() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [view, setView] = useState<ViewMode>('list');
  const searchRef = useRef<HTMLInputElement>(null);

  // Persist view preference across reloads
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === 'list' || stored === 'grid') setView(stored);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* private mode */ }
  }, [view]);

  const { data: projects, isLoading, error, refetch } = useKortixProjects();
  const createSession = useCreateOpenCodeSession();

  const items = useMemo<KortixProject[]>(() => {
    if (!projects) return [];
    const filtered = search.trim()
      ? projects.filter((p) => {
          const q = search.toLowerCase();
          return (
            p.name.toLowerCase().includes(q) ||
            (p.description?.toLowerCase().includes(q) ?? false) ||
            (p.path?.toLowerCase().includes(q) ?? false)
          );
        })
      : [...projects];

    filtered.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'created') return projectCreatedMs(b) - projectCreatedMs(a);
      return projectUpdatedMs(b) - projectUpdatedMs(a);
    });
    return filtered;
  }, [projects, search, sort]);

  const stats = useMemo(() => {
    const list = projects ?? [];
    const active = list.filter((p) => isActive(p)).length;
    const totalSessions = list.reduce((sum, p) => sum + (p.sessionCount ?? 0), 0);
    return { total: list.length, active, totalSessions };
  }, [projects]);

  const openProject = useCallback((p: KortixProject) => {
    openTabAndNavigate({
      id: `project:${p.id}`,
      title: p.name,
      type: 'project',
      href: `/projects/${encodeURIComponent(p.id)}`,
      serverId: useServerStore.getState().activeServerId,
    });
  }, []);

  const startNewProject = useCallback(async () => {
    try {
      const session = await createSession.mutateAsync({ title: 'New project' });
      sessionStorage.setItem(
        `opencode_pending_prompt:${session.id}`,
        "HEY let's set up a new project. Ask for the name and purpose, then create it in the right workspace location with a clean starting structure.",
      );
      openTabAndNavigate({
        id: session.id,
        title: 'New project',
        type: 'session',
        href: `/sessions/${session.id}`,
        serverId: useServerStore.getState().activeServerId,
      });
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('focus-session-textarea')),
      );
    } catch {
      toast.error('Failed to start session');
    }
  }, [createSession]);

  const startNewChat = useCallback(async () => {
    try {
      const session = await createSession.mutateAsync({ title: 'New session' });
      openTabAndNavigate({
        id: session.id,
        title: 'New session',
        type: 'session',
        href: `/sessions/${session.id}`,
        serverId: useServerStore.getState().activeServerId,
      });
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('focus-session-textarea')),
      );
    } catch {
      toast.error('Failed to start session');
    }
  }, [createSession]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (target as HTMLElement | null)?.isContentEditable;
      if (inField) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        startNewProject();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startNewProject]);

  const hasProjects = (projects?.length ?? 0) > 0;
  const showSkeleton = isLoading && !projects;
  const currentSort = SORTS.find((s) => s.key === sort) ?? SORTS[0];

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
        }}
        className="mx-auto w-full max-w-3xl px-6 pt-12 pb-24"
      >
        <Section>
          <header>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  Projects
                </h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  Pick one to dive into its board, files, agents, and sessions.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={startNewChat}
                  disabled={createSession.isPending}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MessageSquarePlus />
                  New chat
                </Button>
                <Button
                  size="sm"
                  onClick={startNewProject}
                  disabled={createSession.isPending}
                >
                  <Plus />
                  New project
                </Button>
              </div>
            </div>
          </header>
        </Section>

        {hasProjects && (
          <Section delay>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <StatPill label={stats.total === 1 ? 'project' : 'projects'} value={stats.total} dot="bg-blue-500" />
              <StatPill label="active" value={stats.active} dot="bg-emerald-500" />
              <StatPill
                label={stats.totalSessions === 1 ? 'session' : 'sessions'}
                value={stats.totalSessions}
                dot="bg-violet-500"
              />
            </div>
          </Section>
        )}

        <Section delay>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 sm:max-w-sm">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/45" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects"
                className={cn(
                  'h-8 w-full rounded-full bg-muted/40 pl-8 pr-10 text-sm outline-none transition-colors',
                  'placeholder:text-muted-foreground/45',
                  'hover:bg-muted/60 focus:bg-muted/70 focus:ring-2 focus:ring-ring/20',
                )}
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground/55 hover:bg-muted hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-3" />
                </button>
              ) : (
                <Kbd className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent text-muted-foreground/55">
                  /
                </Kbd>
              )}
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <currentSort.icon />
                    <span className="hidden sm:inline">{currentSort.label}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground/70">
                    Sort by
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={sort}
                    onValueChange={(v) => setSort(v as SortKey)}
                  >
                    {SORTS.map((s) => (
                      <DropdownMenuRadioItem key={s.key} value={s.key} className="text-sm">
                        <s.icon className="mr-2 size-3.5 text-muted-foreground" />
                        {s.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <ViewToggle view={view} onChange={setView} />
            </div>
          </div>
        </Section>

        <Section delay>
          {showSkeleton ? (
            view === 'list' ? <ListSkeleton /> : <GridSkeleton />
          ) : error ? (
            <ErrorBlock onRetry={() => refetch()} />
          ) : !hasProjects ? (
            <EmptyHero onNew={startNewProject} />
          ) : items.length === 0 ? (
            <NoMatchBlock onClear={() => setSearch('')} query={search} />
          ) : view === 'list' ? (
            <div className="overflow-hidden rounded-2xl bg-muted/30">
              {items.map((p, i) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  onOpen={openProject}
                  isLast={i === items.length - 1}
                />
              ))}
              <NewProjectRow onClick={startNewProject} />
            </div>
          ) : (
            <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={openProject} />
              ))}
              <NewProjectCard onClick={startNewProject} />
            </div>
          )}
        </Section>

        {hasProjects && !showSkeleton && items.length > 0 && (
          <Section delay>
            <div className="flex items-center justify-between text-xs text-muted-foreground/60">
              <span className="tabular-nums">
                Showing {items.length} of {projects?.length ?? 0}
              </span>
              <span className="hidden sm:inline">
                Press <Kbd className="bg-transparent">/</Kbd> to search,{' '}
                <Kbd className="bg-transparent">N</Kbd> for new project
              </span>
            </div>
          </Section>
        )}
      </motion.div>
    </div>
  );
}

function Section({ children, delay }: { children: React.ReactNode; delay?: boolean }) {
  return (
    <motion.section
      variants={{
        hidden: { opacity: 0, y: 6 },
        show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
      }}
      className={cn(delay && 'mt-6')}
    >
      {children}
    </motion.section>
  );
}

function StatPill({
  label,
  value,
  dot,
}: {
  label: string;
  value: number;
  dot: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', dot)} />
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function ProjectRow({
  project,
  onOpen,
  isLast,
}: {
  project: KortixProject;
  onOpen: (p: KortixProject) => void;
  isLast: boolean;
}) {
  const updated = relativeWhen(project.time?.updated ?? project.created_at);
  const active = isActive(project);
  const isV2 = project.structure_version === 2;
  const cleanPath =
    project.path && project.path !== '/' && project.path !== '/workspace'
      ? project.path
      : null;
  const sessions = project.sessionCount ?? 0;
  const description = project.description?.trim();

  return (
    <button
      type="button"
      onClick={() => onOpen(project)}
      className={cn(
        'group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60',
        !isLast && 'border-b border-border/40',
      )}
    >
      <ProjectIcon project={project} size="sm" />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">{project.name}</h3>
          {active && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
          {isV2 && (
            <span className="hidden shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 sm:inline">
              v2
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground/65">
          {cleanPath && <span className="truncate">~{cleanPath}</span>}
          {description && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="truncate">{description}</span>
            </>
          )}
        </div>
      </div>

      <div className="hidden items-center gap-3 text-xs tabular-nums text-muted-foreground/65 sm:flex">
        {sessions > 0 && (
          <span>
            <span className="font-medium text-foreground/80">{sessions}</span>{' '}
            {sessions === 1 ? 'session' : 'sessions'}
          </span>
        )}
        {updated && <span>{updated}</span>}
      </div>

      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

function NewProjectRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 border-t border-border/40 px-4 py-3 text-left transition-colors hover:bg-muted/60"
    >
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted/60 text-muted-foreground/70 transition-colors group-hover:bg-muted group-hover:text-foreground">
        <Plus className="size-3.5" />
      </span>
      <span className="text-sm font-medium text-muted-foreground/80 group-hover:text-foreground">
        New project
      </span>
      <Kbd className="ml-auto bg-transparent text-muted-foreground/55">N</Kbd>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl bg-muted/30">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center gap-3 px-4 py-3',
            i !== 4 && 'border-b border-border/40',
          )}
        >
          <Skeleton className="size-7 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="hidden h-3 w-20 sm:block" />
          <Skeleton className="hidden h-3 w-12 sm:block" />
        </div>
      ))}
    </div>
  );
}

function ErrorBlock({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl bg-muted/30 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">Couldn&apos;t load projects</p>
      <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground/70">
        Check your sandbox connection and try again.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function NoMatchBlock({ onClear, query }: { onClear: () => void; query: string }) {
  return (
    <div className="rounded-2xl bg-muted/30 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">
        Nothing matched &quot;{query}&quot;
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground/70">
        Try a different search, or clear it to see every project.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Clear search
      </Button>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="inline-flex h-8 items-center rounded-full bg-muted/40 p-0.5">
      <button
        type="button"
        onClick={() => onChange('list')}
        aria-label="List view"
        title="List view"
        className={cn(
          'flex size-7 items-center justify-center rounded-full transition-colors',
          view === 'list'
            ? 'bg-background text-foreground'
            : 'text-muted-foreground/65 hover:text-foreground',
        )}
      >
        <ListIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onChange('grid')}
        aria-label="Grid view"
        title="Grid view"
        className={cn(
          'flex size-7 items-center justify-center rounded-full transition-colors',
          view === 'grid'
            ? 'bg-background text-foreground'
            : 'text-muted-foreground/65 hover:text-foreground',
        )}
      >
        <LayoutGrid className="size-3.5" />
      </button>
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: KortixProject;
  onOpen: (p: KortixProject) => void;
}) {
  const updated = relativeWhen(project.time?.updated ?? project.created_at);
  const active = isActive(project);
  const isV2 = project.structure_version === 2;
  const cleanPath =
    project.path && project.path !== '/' && project.path !== '/workspace'
      ? project.path
      : null;
  const sessions = project.sessionCount ?? 0;
  const description = project.description?.trim();

  return (
    <button
      type="button"
      onClick={() => onOpen(project)}
      className={cn(
        'group relative flex h-full flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-left transition-colors',
        'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <ProjectIcon project={project} size="md" />
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">{project.name}</h3>
          {active && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
          {isV2 && (
            <span className="ml-auto shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              v2
            </span>
          )}
        </div>
        {cleanPath && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/65">~{cleanPath}</p>
        )}
      </div>

      <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground/75">
        {description ?? (
          <span className="italic text-muted-foreground/40">No description</span>
        )}
      </p>

      <div className="mt-auto flex items-center gap-2 text-xs tabular-nums text-muted-foreground/60">
        {sessions > 0 && (
          <>
            <span>
              <span className="font-medium text-foreground/80">{sessions}</span>{' '}
              {sessions === 1 ? 'session' : 'sessions'}
            </span>
            {updated && <span className="text-muted-foreground/30">·</span>}
          </>
        )}
        {updated && <span>{updated}</span>}
      </div>
    </button>
  );
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex h-full flex-col items-start justify-between gap-3 rounded-2xl border border-dashed border-border/60 bg-transparent p-4 text-left transition-colors',
        'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
      )}
    >
      <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted/40 text-muted-foreground/70 transition-colors group-hover:bg-muted group-hover:text-foreground">
        <Plus className="size-4" />
      </span>
      <div>
        <h3 className="text-sm font-medium text-foreground">New project</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
          Suna asks what you want to build, then sets up files, agents, and a board for you.
        </p>
      </div>
      <Kbd className="ml-auto bg-transparent text-muted-foreground/55">N</Kbd>
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
          <div className="flex items-start justify-between">
            <Skeleton className="size-9 rounded-xl" />
            <Skeleton className="size-3.5 rounded" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <div className="mt-auto">
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyHero({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-2xl bg-muted/30 px-6 py-16 text-center">
      <div className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-muted/60">
        <FolderGit2 className="size-4 text-muted-foreground/70" />
      </div>
      <h2 className="mt-3 text-sm font-medium text-foreground">
        Spin up your first project
      </h2>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground/70">
        Projects group files, boards, agents, and sessions. Start one and the rest
        of the workspace fills in around it.
      </p>
      <div className="mt-4 inline-flex items-center gap-2">
        <Button onClick={onNew} size="sm">
          <Plus />
          New project
        </Button>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/65">
          or press <Kbd className="bg-transparent">N</Kbd>
        </span>
      </div>
    </div>
  );
}
