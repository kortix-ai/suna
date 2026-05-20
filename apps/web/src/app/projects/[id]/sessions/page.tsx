'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  GitPullRequest,
  MoreHorizontal,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  GitBranch,
  Input,
  Label,
  Loader2,
  Page,
  PageBody,
  PageHeader,
  Plus,
  Skeleton,
  springs,
  Textarea,
  useProximityHover,
  useRegisterProximityItem,
} from '@kortix/design-system';

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
import { DiffPreviewBanner } from '@/features/project-files/components/diff-preview-banner';
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

const STATUS_DOT: Record<ProjectSessionStatus, string> = {
  queued: 'bg-muted-foreground/40',
  branching: 'bg-amber-300',
  provisioning: 'bg-amber-300',
  running: 'bg-emerald-400',
  stopped: 'bg-muted-foreground/40',
  failed: 'bg-rose-400',
  completed: 'bg-muted-foreground/40',
};

const STATUS_TEXT: Record<ProjectSessionStatus, string> = {
  queued: 'text-muted-foreground',
  branching: 'text-amber-400',
  provisioning: 'text-amber-400',
  running: 'text-emerald-500',
  stopped: 'text-muted-foreground',
  failed: 'text-rose-400',
  completed: 'text-muted-foreground',
};

export default function ProjectSessionsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
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
  const projectName = projectQuery.data?.name ?? 'Project';

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
  const total = sessions.length;
  const runningCount = sessions.filter((s) => s.status === 'running').length;
  const failedCount = sessions.filter((s) => s.status === 'failed').length;

  const eyebrowTone =
    failedCount > 0 ? 'danger' : runningCount > 0 ? 'success' : 'muted';

  return (
    <ProjectShell projectId={projectId}>
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <Page size="md">
          <PageHeader
            className="[&_h1]:text-xl [&_h1]:tracking-[-0.015em] [&_p]:text-sm"
            eyebrow={projectName}
            eyebrowTone={eyebrowTone}
            title="Sessions"
            description="Branched workspaces. Each session spins up its own isolated sandbox."
            actions={
              <Button
                onClick={() => createMutation.mutate()}
                loading={createMutation.isPending}
                size="md"
              >
                <Plus />
                New session
              </Button>
            }
          />

          <PageBody>
            {sessionsQuery.isLoading ? (
              <SessionsSkeleton />
            ) : sessionsQuery.isError ? (
              <SessionsError
                message={(sessionsQuery.error as Error).message}
                onRetry={() => sessionsQuery.refetch()}
              />
            ) : total === 0 ? (
              <SessionsEmpty
                onCreate={() => createMutation.mutate()}
                isCreating={createMutation.isPending}
              />
            ) : (
              <section>
                <SectionRule
                  label="Sessions"
                  meta={
                    runningCount > 0
                      ? `${total} · ${runningCount} running`
                      : `${total} ${total === 1 ? 'session' : 'sessions'}`
                  }
                />
                <ColumnHeader />
                <ProximityRows
                  sessions={sessions}
                  onOpen={(id) => router.push(`/projects/${projectId}/sessions/${id}`)}
                  onRestart={(id) => restartMutation.mutate(id)}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onOpenChangeRequest={(session) => setCrSession(session)}
                  deletingId={deletingId}
                  restartingId={restartingId}
                />
              </section>
            )}
          </PageBody>
        </Page>
      </main>

      <OpenCrFromSessionDialog
        projectId={projectId}
        session={crSession}
        defaultBranch={defaultBranch}
        onClose={() => setCrSession(null)}
        onCreated={(crId) => {
          router.push(`/projects/${projectId}/files?cr=${crId}`);
        }}
      />
    </ProjectShell>
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
    <div className="mt-2.5 grid grid-cols-[1rem_minmax(0,1fr)_auto_4rem_1rem] items-center gap-x-4 px-2 pb-2 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-muted-foreground/60">
      <span />
      <span>session</span>
      <span className="hidden text-right md:inline">status</span>
      <span className="hidden text-right md:inline">age</span>
      <span />
    </div>
  );
}

function ProximityRows({
  sessions,
  onOpen,
  onRestart,
  onDelete,
  onOpenChangeRequest,
  deletingId,
  restartingId,
}: {
  sessions: ProjectSession[];
  onOpen: (id: string) => void;
  onRestart: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenChangeRequest: (session: ProjectSession) => void;
  deletingId: string | null;
  restartingId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, itemRects, sessionRef, handlers, registerItem, measureItems } =
    useProximityHover<HTMLDivElement>(containerRef, { axis: 'y' });

  useEffect(() => {
    measureItems();
  }, [sessions.length, measureItems]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => measureItems());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measureItems]);

  const hoverRect = activeIndex !== null ? itemRects[activeIndex] : null;

  return (
    <div ref={containerRef} className="relative" {...handlers}>
      <AnimatePresence>
        {hoverRect ? (
          <motion.div
            key={`hover-${sessionRef.current}`}
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 z-0 rounded-lg bg-muted-foreground/[0.05]"
            initial={{ top: hoverRect.top, height: hoverRect.height, opacity: 0 }}
            animate={{ top: hoverRect.top, height: hoverRect.height, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={springs.moderate}
          />
        ) : null}
      </AnimatePresence>

      {sessions.map((session, index) => (
        <SessionRow
          key={session.session_id}
          session={session}
          index={index}
          registerItem={registerItem}
          isHovered={index === activeIndex}
          onOpen={() => onOpen(session.session_id)}
          onRestart={() => onRestart(session.session_id)}
          onDelete={() => onDelete(session.session_id)}
          onOpenChangeRequest={() => onOpenChangeRequest(session)}
          deleting={deletingId === session.session_id}
          restarting={restartingId === session.session_id}
        />
      ))}
    </div>
  );
}

function SessionRow({
  session,
  index,
  registerItem,
  isHovered,
  onOpen,
  onRestart,
  onDelete,
  onOpenChangeRequest,
  deleting,
  restarting,
}: {
  session: ProjectSession;
  index: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  isHovered: boolean;
  onOpen: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onOpenChangeRequest: () => void;
  deleting: boolean;
  restarting: boolean;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useRegisterProximityItem(
    registerItem,
    index,
    rowRef as unknown as RefObject<HTMLElement | null>,
  );

  const shortId = session.session_id.slice(0, 8);
  const isBranchUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    session.branch_name,
  );
  const branchLabel = isBranchUuid ? `${session.branch_name.slice(0, 8)}…` : session.branch_name;
  const isPulsing = session.status === 'running';

  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onOpen}
      className={cn(
        'group/row relative z-10 grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_4rem_1rem] items-center rounded-none gap-x-4 border-t border-border/60 px-2 py-3 text-left outline-none',
        'transition-colors duration-150',
      )}
    >
      <span className="flex items-center justify-center">
        <span className="relative flex size-1.5">
          {isPulsing ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/60 opacity-70" />
          ) : null}
          <span
            className={cn(
              'relative inline-flex size-1.5 rounded-full',
              STATUS_DOT[session.status],
            )}
            aria-hidden
          />
        </span>
      </span>

      <div className="min-w-0">
        <h3 className="truncate font-mono text-[0.85rem] font-medium leading-tight tracking-[-0.005em] text-foreground">
          {shortId}
        </h3>
        <div className="mt-0.5 truncate font-mono text-[0.68rem] text-muted-foreground">
          <span>{branchLabel}</span>
          {session.name ? (
            <>
              <span className="px-1.5 text-muted-foreground/40">·</span>
              <span className="font-sans">{session.name}</span>
            </>
          ) : null}
        </div>
      </div>

      <span
        className={cn(
          'hidden font-mono text-[0.58rem] uppercase tracking-[0.16em] md:inline',
          STATUS_TEXT[session.status],
        )}
      >
        {session.status}
      </span>

      <span className="hidden text-right font-mono text-[0.68rem] tabular-nums text-muted-foreground md:inline">
        {relativeTime(session.created_at)}
      </span>

      <span className="relative flex items-center justify-end">
        <span
          aria-hidden
          className={cn(
            'pointer-events-none text-muted-foreground/40 transition-all duration-150',
            isHovered && 'translate-x-0.5 text-foreground',
          )}
        >
          →
        </span>
        <div
          className={cn(
            'absolute -right-1 top-1/2 -translate-y-1/2 transition-opacity duration-150',
            isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
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
                aria-label="Session actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onOpen}>
                <Play />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenChangeRequest}>
                <GitPullRequest />
                Open change request
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onRestart} disabled={restarting}>
                {restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                Restart
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onDelete}
                disabled={deleting}
                variant="destructive"
              >
                {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </span>
    </button>
  );
}

function SessionsSkeleton() {
  return (
    <section>
      <SectionRule label="Sessions" meta="loading" />
      <ColumnHeader />
      <div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1rem_minmax(0,1fr)_auto_4rem_1rem] items-center gap-x-4 border-t border-border/60 px-2 py-3"
          >
            <Skeleton className="h-1.5 w-1.5 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2.5 w-44" />
            </div>
            <Skeleton className="hidden h-2.5 w-14 md:block" />
            <Skeleton className="hidden h-2.5 w-10 md:block" />
            <span />
          </div>
        ))}
      </div>
    </section>
  );
}

function SessionsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section>
      <SectionRule label="Sessions" meta="failed" />
      <div className="mt-3 border-t border-border/60 px-3 py-8">
        <p className="font-sans text-sm font-medium text-rose-400">Failed to load sessions</p>
        <p className="mt-1 font-mono text-[0.72rem] text-muted-foreground">{message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </section>
  );
}

function SessionsEmpty({
  onCreate,
  isCreating,
}: {
  onCreate: () => void;
  isCreating: boolean;
}) {
  return (
    <section>
      <SectionRule label="Get started" meta="no sessions yet" />
      <div className="mt-3 grid gap-4 border-t border-border/60 px-3 py-10">
        <GitBranch className="size-5 text-muted-foreground/60" aria-hidden />
        <div className="space-y-1.5">
          <h2 className="font-sans text-lg font-medium tracking-[-0.01em] text-foreground">
            Spin your first session
          </h2>
          <p className="max-w-md font-sans text-sm text-muted-foreground">
            Each session gets its own branch and an isolated sandbox. Spin one, work in it,
            open a change request when you&apos;re done.
          </p>
        </div>
        <div>
          <Button onClick={onCreate} loading={isCreating} size="sm">
            <Plus />
            New session
          </Button>
        </div>
      </div>
    </section>
  );
}

interface OpenCrFromSessionDialogProps {
  projectId: string;
  session: ProjectSession | null;
  defaultBranch: string;
  onClose: () => void;
  onCreated: (crId: string) => void;
}

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

  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
    }
  }, [open, session?.session_id]);

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
      <DialogContent className="sm:max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            Open change request
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Propose merging this session&apos;s work into{' '}
            <span className="font-mono text-foreground">{defaultBranch || 'main'}</span>. The
            session needs to have committed and pushed for there to be a diff.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 pb-4">
          <div className="divide-y divide-border/40 rounded-md border border-border/60 text-xs">
            <div className="flex items-center gap-3 px-3 py-2">
              <span className="w-12 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                From
              </span>
              <div className="flex min-w-0 items-center gap-1.5">
                <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-foreground">{headShort}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <span className="w-12 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Into
              </span>
              <div className="flex min-w-0 items-center gap-1.5">
                <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-foreground">{defaultBranch}</span>
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
              className="resize-none text-sm"
            />
          </div>
        </div>

        <DialogFooter className="border-t border-border/40 bg-muted/30 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!title.trim() || diffQuery.isLoading || !hasChanges}
            loading={submitting}
            onClick={() => void handleSubmit()}
          >
            Open change request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
