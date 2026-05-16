'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Loader2, MoreHorizontal, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  createProjectSession,
  deleteProjectSession,
  listProjectSessions,
  type ProjectSession,
  type ProjectSessionStatus,
} from '@/lib/projects-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectShell } from '@/components/projects/project-shell';

function relativeTime(input: string) {
  const seconds = Math.floor((Date.now() - new Date(input).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const STATUS_TONE: Record<ProjectSessionStatus, string> = {
  queued: 'bg-muted text-muted-foreground border-border',
  branching: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  provisioning: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  running: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  stopped: 'bg-muted text-muted-foreground border-border',
  failed: 'bg-destructive/10 text-destructive border-destructive/20',
  completed: 'bg-muted text-muted-foreground border-border',
};

function SessionRow({
  session,
  onOpen,
  onDelete,
  deleting,
}: {
  session: ProjectSession;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const shortId = session.session_id.slice(0, 8);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-4 py-3 transition-colors hover:border-foreground/30">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs font-medium text-foreground">
            {shortId}
          </span>
          <Badge
            variant="outline"
            className={`rounded-md px-1.5 py-0 text-[10px] font-medium ${STATUS_TONE[session.status]}`}
          >
            {session.status}
          </Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate font-mono">{session.branch_name}</span>
          <span>·</span>
          <span>{relativeTime(session.created_at)}</span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={onOpen} className="gap-2">
            <Play className="h-3.5 w-3.5" />
            Open
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onDelete}
            disabled={deleting}
            className="gap-2 text-destructive focus:text-destructive"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function ProjectSessionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: () => createProjectSession(projectId),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      toast.success('Session created');
      // Stay inside the project shell — open the session as a sub-route.
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create session');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteProjectSession(projectId, sessionId),
    onMutate: (sessionId) => setDeletingId(sessionId),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      toast.success('Session deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete session');
    },
  });

  const sessions = sessionsQuery.data ?? [];

  return (
    <ProjectShell projectId={projectId}>
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
        <h1 className="text-sm font-semibold text-foreground">Sessions</h1>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          New session
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-2 px-4 py-6">
          {sessionsQuery.isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          )}

          {sessionsQuery.isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">Failed to load sessions</p>
              <p className="mt-1 text-xs text-destructive/80">
                {(sessionsQuery.error as Error).message}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => sessionsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          )}

          {!sessionsQuery.isLoading && !sessionsQuery.isError && sessions.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-12 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-border/70 bg-card">
                <GitBranch className="h-5 w-5 text-muted-foreground" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">No sessions yet</h2>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
                Start one to spin up an isolated sandbox + branch.
              </p>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
                className="mt-5 gap-1.5"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                New session
              </Button>
            </div>
          )}

          {sessions.map((session) => (
            <SessionRow
              key={session.session_id}
              session={session}
              onOpen={() => router.push(`/projects/${projectId}/sessions/${session.session_id}`)}
              onDelete={() => deleteMutation.mutate(session.session_id)}
              deleting={deletingId === session.session_id}
            />
          ))}
        </div>
      </div>
    </div>
    </ProjectShell>
  );
}
