'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  GitBranch,
  GitPullRequest,
  Loader2,
  Lock,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  createProjectSession,
  deleteProjectSession,
  getProject,
  listProjectSessions,
  restartProjectSession,
  type ProjectOpenCodeSession,
  type ProjectSession,
  type ProjectSessionStatus,
} from '@/lib/projects-client';
import { OpenChangeRequestDialog } from '@/features/project-files/components/open-change-request-dialog';
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
import { SectionCard } from '@/components/ui/section-card';
import { List, ListRow } from '@/components/ui/list';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { EmptyState } from '@/components/ui/empty-state';

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

const STATUS_VARIANT: Record<
  ProjectSessionStatus,
  'outline' | 'secondary' | 'success' | 'destructive'
> = {
  queued: 'outline',
  branching: 'secondary',
  provisioning: 'secondary',
  running: 'success',
  stopped: 'outline',
  failed: 'destructive',
  completed: 'outline',
};

function rootOpenCodeSession(session: ProjectSession): ProjectOpenCodeSession | null {
  const opencodeSessions = session.opencode_sessions ?? [];
  const rootId = session.opencode_session_id;
  if (rootId) return opencodeSessions.find((item) => item.id === rootId) ?? null;
  return opencodeSessions.find((item) => !item.parent_id) ?? null;
}

function directSubsessions(session: ProjectSession): ProjectOpenCodeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

function SessionRow({
  session,
  onOpen,
  onRestart,
  onDelete,
  onOpenChangeRequest,
  deleting,
  restarting,
}: {
  session: ProjectSession;
  onOpen: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onOpenChangeRequest: () => void;
  deleting: boolean;
  restarting: boolean;
}) {
  const shortId = session.session_id.slice(0, 8);
  const root = rootOpenCodeSession(session);
  const children = directSubsessions(session);
  const title = root?.title || session.name || shortId;
  return (
    <>
      <ListRow
        onClick={onOpen}
        leading={<EntityAvatar icon={GitBranch} size="md" />}
        title={<span>{title}</span>}
        badges={
          <>
            <Badge variant={STATUS_VARIANT[session.status]} size="sm">
              {session.status}
            </Badge>
            {children.length > 0 && (
              <Badge variant="secondary" size="sm">
                {children.length} sub
              </Badge>
            )}
          </>
        }
        subtitle={
          <InlineMeta>
            <span className="font-mono">{session.branch_name}</span>
            <span>{relativeTime(session.created_at)}</span>
          </InlineMeta>
        }
        trailing={
          <div onClick={(e) => e.stopPropagation()}>
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
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={onOpen} className="gap-2">
                  <Play className="h-3.5 w-3.5" />
                  Open
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onOpenChangeRequest} className="gap-2">
                  <GitPullRequest className="h-3.5 w-3.5" />
                  Open change request
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={onRestart}
                  disabled={restarting}
                  className="gap-2"
                >
                  {restarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Restart
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onDelete}
                  disabled={deleting}
                  className="gap-2 text-muted-foreground focus:text-foreground"
                >
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      {children.length > 0 && (
        <li className="ml-10 border-l border-border/60 py-1">
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                window.location.href = `/projects/${session.project_id}/sessions/${session.session_id}?oc=${encodeURIComponent(child.id)}`;
              }}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
              <span className="min-w-0 flex-1 truncate">{child.title || 'Sub-session'}</span>
              {child.updated_at && <span className="shrink-0 text-xs">{relativeTime(new Date(child.updated_at).toISOString())}</span>}
            </button>
          ))}
        </li>
      )}
    </>
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
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [crSession, setCrSession] = useState<ProjectSession | null>(null);

  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });
  const defaultBranch = projectQuery.data?.default_branch ?? 'main';

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

  const restartMutation = useMutation({
    mutationFn: (sessionId: string) => restartProjectSession(projectId, sessionId),
    onMutate: (sessionId) => setRestartingId(sessionId),
    onSettled: () => setRestartingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      toast.success('Restarting session…');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to restart session');
    },
  });

  const sessions = sessionsQuery.data ?? [];

  // The project meta call is the canonical gate — if it 403s the API has
  // told us this user can't see anything about this project. Short-circuit
  // to a friendly empty state instead of rendering a half-broken shell.
  const projectError = projectQuery.error as (Error & { status?: number }) | null;
  if (projectQuery.isError && projectError?.status === 403) {
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/30 text-muted-foreground">
          <Lock className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-foreground">No access to this project</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Your account doesn&apos;t have permission to view this project. Ask an
            administrator to grant you access or pick a different project.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => router.push('/projects')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to projects
        </Button>
      </div>
    );
  }

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
        <div className="mx-auto w-full max-w-4xl px-4 py-6">
          {sessionsQuery.isLoading && (
            <SectionCard title="Sessions" flush>
              <List>
                {Array.from({ length: 4 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-3 px-6 py-3">
                    <Skeleton className="size-8 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-24" />
                      <Skeleton className="h-3 w-40" />
                    </div>
                  </li>
                ))}
              </List>
            </SectionCard>
          )}

          {sessionsQuery.isError && (
            <SectionCard
              tone="destructive"
              title="Failed to load sessions"
              description={(sessionsQuery.error as Error).message}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => sessionsQuery.refetch()}
              >
                Retry
              </Button>
            </SectionCard>
          )}

          {!sessionsQuery.isLoading && !sessionsQuery.isError && sessions.length === 0 && (
            <SectionCard flush>
              <EmptyState
                icon={GitBranch}
                size="sm"
                title="No sessions yet"
                description="Start one to spin up an isolated sandbox + branch."
                action={
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending}
                    className="gap-1.5"
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    New session
                  </Button>
                }
              />
            </SectionCard>
          )}

          {!sessionsQuery.isLoading && !sessionsQuery.isError && sessions.length > 0 && (
            <SectionCard
              title="Sessions"
              count={sessions.length}
              flush
              action={
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
              }
            >
              <List>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.session_id}
                    session={session}
                    onOpen={() => router.push(`/projects/${projectId}/sessions/${session.session_id}`)}
                    onRestart={() => restartMutation.mutate(session.session_id)}
                    onDelete={() => deleteMutation.mutate(session.session_id)}
                    onOpenChangeRequest={() => setCrSession(session)}
                    deleting={deletingId === session.session_id}
                    restarting={restartingId === session.session_id}
                  />
                ))}
              </List>
            </SectionCard>
          )}
        </div>
      </div>

      <OpenChangeRequestDialog
        open={crSession !== null}
        onOpenChange={(v) => !v && setCrSession(null)}
        projectId={projectId}
        defaultBranch={defaultBranch}
        session={crSession}
        onCreated={(crId) => {
          // After the CR is opened, deep-link to /files so the user lands in
          // the CR detail view with the diff already loaded.
          router.push(`/projects/${projectId}/files?cr=${crId}`);
        }}
      />
    </div>
    </ProjectShell>
  );
}
