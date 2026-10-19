'use client';

/**
 * The per-project layout: a left rail (back, project name, new session, the live
 * session list, settings) + a main pane. Shared by the project home, the session
 * workbench, and project settings so navigation stays consistent.
 */

import { NewSessionDialog } from '@/components/new-session-dialog';
import { Button } from '@kortix/ui/button';
import { ScrollArea } from '@kortix/ui/scroll-area';
import { Skeleton } from '@kortix/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { relativeTime } from '@/lib/utils';
import { ApiError } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { cn } from '@kortix/ui/lib/utils';
import { ArrowLeftIcon, FolderDashedIcon, GearIcon, PlusIcon } from '@phosphor-icons/react';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-kortix-green',
  provisioning: 'bg-kortix-orange animate-pulse',
  branching: 'bg-kortix-orange animate-pulse',
  queued: 'bg-kortix-orange animate-pulse',
  completed: 'bg-muted-foreground/50',
  stopped: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

/** 403/404 from the API — access denied or the project doesn't exist here. */
function isAccessError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 404);
}

export function ProjectShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const projectId = String(params.id);
  const activeSessionId = params.sessionId ? String(params.sessionId) : null;

  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => kortix.project(projectId).get(),
    // 403/404 never recovers on retry — fail fast instead of spamming.
    retry: (count, err) => !isAccessError(err) && count < 2,
  });
  const denied = project.isError && isAccessError(project.error);
  const sessions = useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: () => kortix.project(projectId).sessions.list(),
    refetchInterval: denied ? false : 5_000,
    enabled: !denied,
    retry: (count, err) => !isAccessError(err) && count < 2,
  });

  const items = sessions.data ?? [];

  if (denied) return <AccessDenied />;

  return (
    <div className="flex h-dvh bg-background">
      {/* Below md the sidebar collapses into the top bar in <main>. */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="All projects">
            <Link href="/">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            {project.isLoading ? (
              <Skeleton className="h-4 w-28" />
            ) : (
              <div className="truncate text-sm font-medium">{project.data?.name ?? 'Project'}</div>
            )}
          </div>
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Project settings">
            <Link href={`/projects/${projectId}/settings`}>
              <GearIcon className="size-4" />
            </Link>
          </Button>
        </div>

        <div className="px-3 pb-2">
          {/* Every session used to be created with an id and nothing else. The
              overrides behind this dialog are create-only, so this is the only
              moment they can be chosen at all. */}
          <NewSessionDialog
            projectId={projectId}
            trigger={
              <Button className="w-full justify-start gap-2" variant="secondary">
                <PlusIcon className="size-4" /> New session
              </Button>
            }
          />
        </div>

        <ScrollArea className="flex-1 px-2">
          <div className="space-y-0.5 pb-3">
            {sessions.isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="mx-1 my-1 h-9 rounded-md" />
              ))}
            {sessions.isSuccess && items.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No sessions yet.
              </p>
            )}
            {items.map((s) => {
              const active = s.session_id === activeSessionId;
              const title = s.name || s.custom_name || s.branch_name || 'Untitled session';
              return (
                <Link
                  key={s.session_id}
                  href={`/projects/${projectId}/sessions/${s.session_id}`}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-sidebar-accent text-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      STATUS_DOT[s.status] ?? 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{title}</span>
                    <span className="block truncate text-xs text-muted-foreground/70">
                      {relativeTime(s.updated_at)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="All projects">
            <Link href="/">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <Link href={`/projects/${projectId}`} className="min-w-0 flex-1 truncate text-sm font-medium">
            {project.data?.name ?? 'Project'}
          </Link>
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Project settings">
            <Link href={`/projects/${projectId}/settings`}>
              <GearIcon className="size-4" />
            </Link>
          </Button>
        </div>
        {children}
      </main>
    </div>
  );
}

/** Shown when the API key can't see the project (403/404) — instead of a
 *  retry-spamming broken shell. */
function AccessDenied() {
  return (
    <div className="grid h-dvh place-items-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid size-12 place-items-center rounded-full border border-border bg-card">
          <FolderDashedIcon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="mt-4 text-lg font-medium">Project not available</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          This project doesn&apos;t exist, or your API key doesn&apos;t have access to it. Pick one
          from your projects to continue.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeftIcon className="size-4" /> All projects
          </Link>
        </Button>
      </div>
    </div>
  );
}
