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
import { ArrowLeft, Plus, Settings } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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

export function ProjectShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const projectId = String(params.id);
  const activeSessionId = params.sessionId ? String(params.sessionId) : null;
  const router = useRouter();
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => kortix.project(projectId).get(),
  });
  const sessions = useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: () => kortix.project(projectId).sessions.list(),
    refetchInterval: 5_000,
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
