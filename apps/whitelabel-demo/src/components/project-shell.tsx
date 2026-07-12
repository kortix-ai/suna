'use client';

/**
 * The per-project layout: a left rail (back, project name, new session, the live
 * session list, settings) + a main pane. Shared by the project home, the session
 * workbench, and project settings so navigation stays consistent.
 */

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { invalidateSessions, qk } from '@/lib/query-keys';
import { cn, relativeTime } from '@/lib/utils';
import { generateSessionId } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChartNoAxesColumn, FolderX, Inbox, Plus, Settings } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  provisioning: 'bg-amber-500 animate-pulse',
  branching: 'bg-amber-500 animate-pulse',
  queued: 'bg-amber-500 animate-pulse',
  completed: 'bg-muted-foreground/50',
  stopped: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

/** 403/404 from the API — access denied or the project doesn't exist here. */
function isAccessError(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | undefined;
  if (e?.status === 403 || e?.status === 404) return true;
  return /\b40[34]\b|forbidden|do not have access|not found/i.test(e?.message ?? '');
}

export function ProjectShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const projectId = String(params.id);
  const activeSessionId = params.sessionId ? String(params.sessionId) : null;
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => kortix.project(projectId).get(),
    // 403/404 never recovers on retry — fail fast instead of spamming.
    retry: (count, err) => !isAccessError(err) && count < 2,
  });
  const denied = project.isError && isAccessError(project.error);

  // Total pending-approval count across the project → the Review badge.
  const needsInput = useQuery({
    queryKey: ['approvals-needs-input', projectId],
    queryFn: () => kortix.project(projectId).approvals.sessionsNeedingInput({ showErrors: false }),
    refetchInterval: denied ? false : 30_000,
    enabled: !denied,
    retry: false,
  });
  const reviewBadge = needsInput.data?.total ?? 0;
  const sessions = useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: () => kortix.project(projectId).sessions.list(),
    refetchInterval: denied ? false : 5_000,
    enabled: !denied,
    retry: (count, err) => !isAccessError(err) && count < 2,
  });

  const newSession = useMutation({
    mutationFn: async () => {
      const sessionId = generateSessionId();
      await kortix.project(projectId).sessions.create({ session_id: sessionId });
      return sessionId;
    },
    onSuccess: (sessionId) => {
      invalidateSessions(qc, projectId);
      router.push(`/projects/${projectId}/sessions/${sessionId}`);
    },
    onError: () => toast.error('Could not start a session'),
  });

  const items = sessions.data ?? [];

  if (denied) return <AccessDenied />;

  return (
    <div className="flex h-dvh bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center gap-2 px-3 py-3">
          <Link href="/">
            <Button variant="ghost" size="icon" className="size-8" aria-label="All projects">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div className="min-w-0 flex-1">
            {project.isLoading ? (
              <Skeleton className="h-4 w-28" />
            ) : (
              <div className="truncate text-sm font-medium">{project.data?.name ?? 'Project'}</div>
            )}
          </div>
          <Link href={`/projects/${projectId}/settings`}>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Project settings">
              <Settings className="size-4" />
            </Button>
          </Link>
        </div>

        <div className="px-3 pb-2">
          <Button
            className="w-full justify-start gap-2"
            variant="secondary"
            disabled={newSession.isPending}
            onClick={() => newSession.mutate()}
          >
            <Plus className="size-4" /> New session
          </Button>
        </div>

        <nav className="space-y-0.5 px-2 pb-2">
          <RailLink
            href={`/projects/${projectId}/review`}
            active={pathname === `/projects/${projectId}/review`}
            icon={<Inbox className="size-4" />}
            label="Review"
            badge={reviewBadge}
          />
          <RailLink
            href={`/projects/${projectId}/usage`}
            active={pathname === `/projects/${projectId}/usage`}
            icon={<ChartNoAxesColumn className="size-4" />}
            label="Usage"
          />
        </nav>

        <div className="px-5 pb-1 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/70">
          Sessions
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

      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

function RailLink({
  href,
  active,
  icon,
  label,
  badge,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent text-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-amber-500/20 text-[0.65rem] font-medium tabular-nums text-amber-500">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  );
}

/** Shown when the API key can't see the project (403/404) — instead of a
 *  retry-spamming broken shell. */
function AccessDenied() {
  return (
    <div className="grid h-dvh place-items-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid size-12 place-items-center rounded-full border border-border bg-card">
          <FolderX className="size-5 text-muted-foreground" />
        </div>
        <h1 className="mt-4 text-lg font-medium">Project not available</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          This project doesn&apos;t exist, or your API key doesn&apos;t have access to it. Pick one
          from your projects to continue.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeft className="size-4" /> All projects
          </Link>
        </Button>
      </div>
    </div>
  );
}
