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
import { Badge } from '@/components/ui/badge';
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
import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';

type SortKey = 'recent' | 'name' | 'created';
type ViewMode = 'grid' | 'list';

const SORTS: { key: SortKey; label: string; icon: typeof Clock4 }[] = [
  { key: 'recent', label: 'Last activity', icon: Clock4 },
  { key: 'created', label: 'Recently created', icon: Sparkles },
  { key: 'name', label: 'Name', icon: ArrowDownAZ },
];

const ICON_HUES = [12, 30, 50, 90, 145, 195, 230, 265, 305, 340] as const;

function projectAccent(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = ICON_HUES[Math.abs(hash) % ICON_HUES.length];
  return `oklch(0.62 0.14 ${hue})`;
}

function projectInitial(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '').trim();
  return (cleaned[0] || '?').toUpperCase();
}

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

type IconSize = 'sm' | 'md';

const ICON_SIZE_CLASS: Record<IconSize, string> = {
  sm: 'size-7 text-xs',
  md: 'size-9 text-sm',
};

function ProjectIcon({
  project,
  size = 'md',
  className,
}: {
  project: KortixProject;
  size?: IconSize;
  className?: string;
}) {
  const accent = projectAccent(project.id);
  const initial = projectInitial(project.name);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-tight text-white ring-1 ring-inset ring-white/10',
        ICON_SIZE_CLASS[size],
        className,
      )}
      style={{ backgroundColor: accent }}
    >
      {initial}
    </div>
  );
}

function ActivityPulse({ active }: { active: boolean }) {
  if (!active) {
    return (
      <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
      </span>
    );
  }
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center">
      <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-emerald-500/40" />
      <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
    </span>
  );
}

const CARD_BASE = cn(
  'group relative flex h-full flex-col rounded-2xl border bg-card p-4 text-left',
  'transition-colors duration-150 hover:bg-muted/30',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
);

function CardHeader({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      {left}
      <span
        aria-hidden
        className="text-muted-foreground/30 transition-colors duration-150 group-hover:text-foreground"
      >
        {right}
      </span>
    </div>
  );
}

function CardTitle({
  title,
  pathLabel,
  pathMono = true,
}: {
  title: string;
  pathLabel: string;
  pathMono?: boolean;
}) {
  return (
    <div className="mt-3 min-w-0">
      <h3 className="truncate text-sm font-semibold leading-tight tracking-tight text-foreground">
        {title}
      </h3>
      <Badge
        variant="secondary"
        size="sm"
        className={cn(
          'mt-1.5 max-w-full rounded-md normal-case tracking-normal',
          pathMono && 'font-mono',
        )}
      >
        <span className="truncate">{pathLabel}</span>
      </Badge>
    </div>
  );
}

function CardBody({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-snug text-muted-foreground">
      {children}
    </p>
  );
}

function CardFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto flex items-center gap-1.5 pt-3">{children}</div>;
}

function ProjectCardGrid({
  project,
  index,
  onOpen,
}: {
  project: KortixProject;
  index: number;
  onOpen: (p: KortixProject) => void;
}) {
  const updated = relativeWhen(project.time?.updated ?? project.created_at);
  const active = isActive(project);
  const isV2 = project.structure_version === 2;
  const cleanPath =
    project.path && project.path !== '/' && project.path !== '/workspace'
      ? project.path
      : '/workspace';
  const sessions = project.sessionCount ?? 0;

  return (
    <motion.button
      type="button"
      onClick={() => onOpen(project)}
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, delay: Math.min(index * 0.01, 0.1), ease: 'easeOut' }}
      className={CARD_BASE}
    >
      <CardHeader
        left={<ProjectIcon project={project} size="md" />}
        right={
          <ArrowUpRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        }
      />
      <CardTitle title={project.name} pathLabel={`~${cleanPath}`} />
      <CardBody>
        {project.description?.trim() || (
          <span className="italic text-muted-foreground/40">No description</span>
        )}
      </CardBody>
      <CardFooter>
        <Badge
          variant={active ? 'success' : 'muted'}
          size="sm"
          className="gap-1.5 uppercase tracking-wider tabular-nums"
        >
          <ActivityPulse active={active} />
          {updated ?? 'idle'}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          {sessions > 0 && (
            <Badge
              variant="muted"
              size="sm"
              className="uppercase tracking-wider tabular-nums"
            >
              <span className="font-semibold text-foreground/80">{sessions}</span>
              sess
            </Badge>
          )}
          <Badge
            variant={isV2 ? 'highlight' : 'muted'}
            size="sm"
            className="font-semibold uppercase tracking-wider tabular-nums"
          >
            {isV2 ? 'v2' : 'v1'}
          </Badge>
        </div>
      </CardFooter>
    </motion.button>
  );
}

function ProjectRow({
  project,
  index,
  onOpen,
}: {
  project: KortixProject;
  index: number;
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

  return (
    <motion.button
      type="button"
      onClick={() => onOpen(project)}
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, delay: Math.min(index * 0.01, 0.1), ease: 'easeOut' }}
      className={cn(
        'group flex w-full items-center gap-4 border-b px-4 py-3 text-left',
        'transition-colors duration-150 hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:outline-none',
      )}
    >
      <ProjectIcon project={project} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">
            {project.name}
          </h3>
          {cleanPath && (
            <Badge
              variant="secondary"
              size="sm"
              className="hidden rounded-md font-mono normal-case tracking-normal sm:inline-flex"
            >
              {cleanPath}
            </Badge>
          )}
        </div>
        {project.description?.trim() && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {project.description}
          </p>
        )}
      </div>
      <div className="hidden items-center gap-1.5 sm:flex">
        {sessions > 0 && (
          <Badge variant="muted" size="sm" className="uppercase tracking-wider tabular-nums">
            <span className="font-semibold text-foreground/80">{sessions}</span>
            sess
          </Badge>
        )}
        <Badge
          variant={isV2 ? 'highlight' : 'muted'}
          size="sm"
          className="font-semibold uppercase tracking-wider tabular-nums"
        >
          {isV2 ? 'v2' : 'v1'}
        </Badge>
      </div>
      <div className="flex w-24 shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <ActivityPulse active={active} />
        <span className="truncate tabular-nums">{updated ?? '—'}</span>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/30 transition-colors duration-150 group-hover:text-foreground" />
    </motion.button>
  );
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(CARD_BASE, 'border-dashed bg-transparent')}
    >
      <CardHeader
        left={
          <span className="flex size-9 items-center justify-center rounded-lg border border-dashed text-muted-foreground transition-transform duration-200 group-hover:rotate-90 group-hover:text-foreground">
            <Plus className="size-4" />
          </span>
        }
        right={<ArrowUpRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />}
      />
      <CardTitle title="New project" pathLabel="scaffold" pathMono={false} />
      <CardBody>
        Suna asks what you want to build, then sets up files, agents, and a board for you.
      </CardBody>
      <CardFooter>
        <Badge variant="muted" size="sm" className="uppercase tracking-wider">
          Ready
        </Badge>
        <Kbd className="ml-auto bg-transparent">N</Kbd>
      </CardFooter>
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col rounded-2xl border bg-card p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="size-4 rounded" />
          </div>
          <div className="mt-3 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-4 w-1/2 rounded-md" />
          </div>
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <div className="mt-auto flex items-center justify-between pt-3">
            <Skeleton className="h-5 w-20 rounded-2xl" />
            <Skeleton className="h-5 w-10 rounded-2xl" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyHero({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed bg-card/40 px-6 py-12 text-center">
      <div className="mx-auto flex size-10 items-center justify-center rounded-lg border bg-card text-foreground">
        <FolderGit2 className="size-4" />
      </div>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
        Spin up your first project
      </h2>
      <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
        Projects group files, boards, agents, and sessions. Start one and the rest
        of the workspace fills in around it.
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        <Button onClick={onNew} size="sm">
          <Plus />
          New project
        </Button>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          or press <Kbd className="bg-transparent">N</Kbd>
        </span>
      </div>
    </div>
  );
}

export function ProjectsDashboard() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [view, setView] = useState<ViewMode>('grid');
  const searchRef = useRef<HTMLInputElement>(null);

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
    <div className="flex h-full w-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center rounded-lg bg-muted p-2 border">
                <FolderGit2 className="h-4 w-4" />
              </div>
              <h1 className="font-semibold leading-tight tracking-tight text-foreground text-2xl">
                Projects
              </h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick one to dive into its board, files, agents, and sessions.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={startNewChat}
              disabled={createSession.isPending}
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
        </header>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects"
              className={cn(
                'h-9 w-full rounded-lg border bg-card pl-9 pr-10 text-sm',
                'placeholder:text-muted-foreground/70',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:border-foreground/30',
                'transition-colors duration-150',
              )}
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            ) : (
              <Kbd className="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent text-muted-foreground/70">
                /
              </Kbd>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
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
                    <DropdownMenuRadioItem
                      key={s.key}
                      value={s.key}
                      className="text-sm"
                    >
                      <s.icon className="mr-2 size-3.5 text-muted-foreground" />
                      {s.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="inline-flex h-9 items-center rounded-lg border bg-card p-0.5">
              <button
                type="button"
                onClick={() => setView('grid')}
                aria-label="Grid view"
                className={cn(
                  'flex size-7 items-center justify-center rounded-md transition-colors',
                  view === 'grid'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutGrid className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setView('list')}
                aria-label="List view"
                className={cn(
                  'flex size-7 items-center justify-center rounded-md transition-colors',
                  view === 'list'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <ListIcon className="size-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5">
          {showSkeleton ? (
            <GridSkeleton />
          ) : error ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
              <p className="text-sm font-medium text-foreground">
                Couldn't load projects
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
                Check your sandbox connection and try again.
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : !hasProjects ? (
            <EmptyHero onNew={startNewProject} />
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
              <p className="text-sm font-medium text-foreground">
                Nothing matched "{search}"
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
                Try a different search, or clear it to see every project.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => setSearch('')}
              >
                Clear search
              </Button>
            </div>
          ) : view === 'grid' ? (
            <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((p, i) => (
                <ProjectCardGrid
                  key={p.id}
                  project={p}
                  index={i}
                  onOpen={openProject}
                />
              ))}
              <NewProjectCard onClick={startNewProject} />
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="flex items-center gap-4 border-b bg-muted/20 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span className="w-7" />
                <span className="flex-1">Project</span>
                <span className="hidden sm:inline">Meta</span>
                <span className="w-24 text-right">Activity</span>
                <span className="w-4" />
              </div>
              <div className="flex flex-col">
                {items.map((p, i) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    index={i}
                    onOpen={openProject}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={startNewProject}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
              >
                <span className="flex size-7 items-center justify-center rounded-lg border border-dashed">
                  <Plus className="size-3.5" />
                </span>
                <span>New project</span>
                <Kbd className="ml-auto bg-transparent">N</Kbd>
              </button>
            </div>
          )}
        </div>

        {hasProjects && !showSkeleton && items.length > 0 && (
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span className="tabular-nums">
              Showing {items.length} of {projects?.length ?? 0}
            </span>
            <span className="hidden sm:inline">
              Press <Kbd className="bg-transparent">/</Kbd> to search,{' '}
              <Kbd className="bg-transparent">N</Kbd> for new project
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
