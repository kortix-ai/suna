'use client';

import { use, useEffect, useState } from 'react';
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
  getVersionDiff,
  listProjectSessions,
  openChangeRequest,
  restartProjectSession,
  type ProjectSession,
  type ProjectSessionStatus,
  type VersionDiffPreview,
} from '@/lib/projects-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DiffPreviewBanner } from '@/features/project-files/components/diff-preview-banner';
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
  return (
    <ListRow
      onClick={onOpen}
      leading={<EntityAvatar icon={GitBranch} size="md" />}
      title={<span className="font-mono">{shortId}</span>}
      badges={
        <Badge variant={STATUS_VARIANT[session.status]} size="sm">
          {session.status}
        </Badge>
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
                className="gap-2 text-destructive focus:text-destructive"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}

interface OpenCrFromSessionDialogProps {
  projectId: string;
  session: ProjectSession | null;
  defaultBranch: string;
  onClose: () => void;
  onCreated: (crId: string) => void;
}

/**
 * Minimal new-CR dialog tailored to the "open from a session row" flow.
 * Head ref is the session's branch (UUID) and base is the project's default
 * branch — both are predetermined, so no branch picker. The user only fills
 * in title + optional description.
 */
function OpenCrFromSessionDialog({
  projectId,
  session,
  defaultBranch,
  onClose,
  onCreated,
}: OpenCrFromSessionDialogProps) {
  const open = session !== null;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever a new session opens the dialog so previous drafts
  // don't leak between sessions.
  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
    }
  }, [open, session?.session_id]);

  // Live diff between session branch and project default — gates submit.
  const diffQuery = useQuery<VersionDiffPreview>({
    queryKey: ['version-diff', projectId, session?.branch_name, defaultBranch],
    queryFn: () =>
      getVersionDiff(projectId, { from: session!.branch_name, into: defaultBranch }),
    enabled: open && Boolean(session?.branch_name) && Boolean(defaultBranch),
    staleTime: 10_000,
  });
  const preview = diffQuery.data;
  const hasChanges =
    Boolean(preview) &&
    !preview!.is_same_ref &&
    !preview!.is_up_to_date &&
    preview!.files_changed > 0;

  const handleSubmit = async () => {
    if (!session) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const cr = await openChangeRequest(projectId, {
        title: trimmed,
        description: description.trim() || undefined,
        head_ref: session.branch_name,
        base_ref: defaultBranch,
        session_id: session.session_id,
      });
      toast.success(`Opened change request #${cr.number}`);
      onCreated(cr.cr_id);
      setTitle('');
      setDescription('');
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const headShort = session?.branch_name
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.branch_name)
      ? `${session.branch_name.slice(0, 8)}… (session)`
      : session.branch_name
    : '';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 space-y-1">
          <DialogTitle className="text-base font-medium flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            Open change request
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Propose merging this session's work into{' '}
            <span className="font-mono text-foreground">{defaultBranch || 'main'}</span>.
            The session needs to have committed and pushed for there to be a diff.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-4 space-y-4">
          {/* Read-only branch summary so the user knows what they're merging. */}
          <div className="rounded-md border border-border/60 divide-y divide-border/40 text-xs">
            <div className="flex items-center gap-3 px-3 py-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground w-12 shrink-0">
                From
              </span>
              <div className="flex items-center gap-1.5 min-w-0">
                <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-mono text-foreground truncate">{headShort}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground w-12 shrink-0">
                Into
              </span>
              <div className="flex items-center gap-1.5 min-w-0">
                <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-mono text-foreground truncate">{defaultBranch}</span>
              </div>
            </div>
          </div>

          <DiffPreviewBanner
            loading={diffQuery.isLoading}
            error={diffQuery.error as Error | null}
            preview={preview}
          />

          <div className="space-y-1.5">
            <Label htmlFor="session-cr-title" className="text-xs font-medium text-foreground">
              Title
            </Label>
            <Input
              id="session-cr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={session?.name || 'What did this session change?'}
              autoFocus
              className="h-9"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="session-cr-description"
              className="text-xs font-medium text-foreground"
            >
              Description{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="session-cr-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What did the agent do? Why does it matter?"
              rows={3}
              className="text-sm resize-none"
            />
          </div>
        </div>

        <DialogFooter variant="bar">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={!title.trim() || submitting || diffQuery.isLoading || !hasChanges}
            onClick={() => void handleSubmit()}
          >
            {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Open change request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

      <OpenCrFromSessionDialog
        projectId={projectId}
        session={crSession}
        defaultBranch={defaultBranch}
        onClose={() => setCrSession(null)}
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
