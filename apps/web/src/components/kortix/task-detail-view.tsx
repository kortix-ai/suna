'use client';

/**
 * TaskDetailView — modal dialog.
 *
 * Layout:
 *   Header:  [Project › id]                [Primary action] [×]
 *   Title:   Big inline-editable title
 *   Meta:    [status pill] · updated time · live detail (if running)
 *   Body (scrollable):
 *     Description editor
 *     Verification editor
 *     Blocker card (if blocking_question)
 *     Result card (if result)
 *     Worker session card (if in_progress)
 *     Activity timeline (events)
 *   Footer:  [Delete] ————————————————————— [Close]
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  CircleDashed,
  Play,
  CheckCircle2,
  AlertOctagon,
  Trash2,
  ExternalLink,
  X,
  Activity,
  FlaskConical,
  XCircle,
  Package,
  Paperclip,
  Copy,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineTextEditor } from '@/components/ui/inline-text-editor';
import {
  useKortixTask,
  useKortixTaskEvents,
  useKortixTaskStatus,
  useUpdateKortixTask,
  useStartKortixTask,
  useApproveKortixTask,
  useDeleteKortixTask,
  type KortixTaskEvent,
} from '@/hooks/kortix/use-kortix-tasks';
import { useKortixProject } from '@/hooks/kortix/use-kortix-projects';
import { openTabAndNavigate } from '@/stores/tab-store';
import { StatusPill } from '@/components/kortix/task-pills';
import {
  shortTaskId,
  relativeTime,
  fullDate,
} from '@/lib/kortix/task-meta';
import type { KortixTaskStatus } from '@/hooks/kortix/use-kortix-tasks';

export interface TaskDetailViewProps {
  taskId: string | null;
  onClose: () => void;
  projectName?: string;
  pollingEnabled?: boolean;
}

export function TaskDetailView({
  taskId,
  onClose,
  projectName: projectNameOverride,
  pollingEnabled = true,
}: TaskDetailViewProps) {
  const { data: task, isLoading } = useKortixTask(taskId || '', {
    enabled: !!taskId && pollingEnabled,
    pollingEnabled: !!taskId && pollingEnabled,
  });
  const { data: events } = useKortixTaskEvents(taskId || '', {
    enabled: !!taskId && pollingEnabled,
    pollingEnabled: !!taskId && pollingEnabled,
  });
  const { data: liveStatus } = useKortixTaskStatus(taskId || '', {
    enabled: !!taskId && pollingEnabled,
    pollingEnabled: !!taskId && pollingEnabled,
  });
  const { data: project } = useKortixProject(task?.project_id || '');
  const updateTask = useUpdateKortixTask();
  const startTask = useStartKortixTask();
  const approveTask = useApproveKortixTask();
  const deleteTaskMutation = useDeleteKortixTask();

  const [titleVal, setTitleVal] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [descVal, setDescVal] = useState('');
  const [verVal, setVerVal] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (task) {
      setTitleVal(task.title);
      setDescVal(task.description || '');
      setVerVal(task.verification_condition || '');
    }
  }, [task?.id, task?.title, task?.description, task?.verification_condition]);

  const projectName = projectNameOverride || project?.name;
  const isRunning = task?.status === 'in_progress';

  // Sort events oldest → newest for timeline chronology
  const orderedEvents = useMemo(() => {
    if (!events) return [];
    return [...events].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [events]);

  const saveTitle = () => {
    if (!task) return;
    const v = titleVal.trim();
    if (v && v !== task.title) updateTask.mutate({ id: task.id, title: v });
    setEditingTitle(false);
  };
  const commitDesc = () => {
    if (!task) return;
    const v = descVal.trim();
    if (v !== (task.description || '')) updateTask.mutate({ id: task.id, description: v });
  };
  const commitVer = () => {
    if (!task) return;
    const v = verVal.trim();
    if (v !== (task.verification_condition || '')) updateTask.mutate({ id: task.id, verification_condition: v });
  };
  const copyId = () => {
    if (!task) return;
    navigator.clipboard.writeText(task.id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <>
      <Dialog open={!!taskId} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent
          hideCloseButton
          className="sm:max-w-[760px] max-h-[88vh] p-0 gap-0 rounded-2xl border-border shadow-2xl overflow-hidden flex flex-col"
        >
          <DialogTitle className="sr-only">{task?.title || 'Task'}</DialogTitle>
          <DialogDescription className="sr-only">Task detail</DialogDescription>

          {!task && isLoading ? (
            <div className="flex items-center justify-center py-20">
              <CircleDashed className="h-6 w-6 text-muted-foreground/20 animate-spin" />
            </div>
          ) : !task ? (
            <div className="flex items-center justify-center flex-col gap-3 py-16">
              <CircleDashed className="h-6 w-6 text-muted-foreground/10" />
              <p className="text-sm text-muted-foreground/40">Task not found</p>
            </div>
          ) : (
            <>
              {/* ── Header ─────────────────────────────────── */}
              <div className="shrink-0 flex items-center gap-2 px-5 h-12 border-b border-border/50">
                <div className="flex items-center gap-2 text-[13px] min-w-0">
                  <span className="font-semibold text-foreground tracking-tight truncate">
                    {projectName || 'KORTIX'}
                  </span>
                  <span className="text-muted-foreground/40 shrink-0">›</span>
                  <button
                    onClick={copyId}
                    className="text-muted-foreground/70 hover:text-foreground font-mono text-[12px] inline-flex items-center gap-1 transition-colors cursor-pointer"
                    title="Copy task ID"
                  >
                    {shortTaskId(task.id)}
                    {copied ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground/30" />
                    )}
                  </button>
                </div>
                <div className="ml-auto flex items-center gap-1.5">
                  {task.status === 'todo' && (
                    <Button
                      size="sm"
                      className="h-7 px-3 gap-1.5 text-[12px]"
                      onClick={() => startTask.mutate({ id: task.id })}
                      disabled={startTask.isPending}
                    >
                      <Play className="h-3 w-3" />
                      Start
                    </Button>
                  )}
                  {task.status === 'awaiting_review' && (
                    <Button
                      size="sm"
                      className="h-7 px-3 gap-1.5 text-[12px]"
                      onClick={() => approveTask.mutate(task.id)}
                      disabled={approveTask.isPending}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Approve
                    </Button>
                  )}
                  {isRunning && (
                    <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-[11px] text-blue-500 font-medium">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Running
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
                    onClick={onClose}
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* ── Title + meta ───────────────────────────── */}
              <div className="shrink-0 px-5 pt-4 pb-3">
                {editingTitle ? (
                  <input
                    autoFocus
                    value={titleVal}
                    onChange={(e) => setTitleVal(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setTitleVal(task.title); setEditingTitle(false); }
                      if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
                    }}
                    className="w-full text-[22px] font-semibold bg-transparent border-0 outline-none text-foreground tracking-tight leading-tight -mx-1 px-1"
                  />
                ) : (
                  <button
                    onClick={() => setEditingTitle(true)}
                    className="block w-full text-left text-[22px] font-semibold text-foreground tracking-tight leading-tight hover:bg-muted/30 rounded-md -mx-1 px-1 py-0.5 transition-colors cursor-text"
                  >
                    {task.title}
                  </button>
                )}

                <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                  <StatusPill
                    status={task.status}
                    onChange={(next) => updateTask.mutate({ id: task.id, status: next })}
                    variant="pill"
                  />
                  <span className="text-[11px] text-muted-foreground/50" title={fullDate(task.updated_at)}>
                    updated {relativeTime(task.updated_at)}
                  </span>
                  {isRunning && liveStatus?.detail && (
                    <span className="text-[11px] text-blue-500/70 truncate max-w-[260px]" title={liveStatus.detail}>
                      · {liveStatus.detail}
                    </span>
                  )}
                </div>
              </div>

              {/* ── Scrollable body ─────────────────────────── */}
              <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-1 pb-4 space-y-5">

                {/* Description */}
                <FieldBlock label="Description">
                  <InlineTextEditor
                    value={descVal}
                    onChange={setDescVal}
                    onCommit={commitDesc}
                    placeholder="What needs to be done? Be specific — what to build, where, what to read first, what success looks like…"
                  />
                </FieldBlock>

                {/* Verification condition — always visible to enforce the doctrine */}
                <FieldBlock label="Verification" subLabel="Deterministic. Runnable. Binary pass/fail.">
                  <InlineTextEditor
                    value={verVal}
                    onChange={setVerVal}
                    onCommit={commitVer}
                    placeholder="e.g. `bun test tests/auth.test.ts` exits 0 and the new signup test passes"
                  />
                </FieldBlock>

                {/* Blocker */}
                {task.blocking_question && (
                  <AccentCard
                    tone="amber"
                    icon={<AlertOctagon className="h-4 w-4" />}
                    label="Needs input"
                  >
                    <pre className="text-[13px] text-foreground/85 whitespace-pre-wrap leading-relaxed font-sans">
                      {task.blocking_question}
                    </pre>
                  </AccentCard>
                )}

                {/* Result */}
                {task.result && (
                  <AccentCard
                    tone="emerald"
                    icon={<CheckCircle2 className="h-4 w-4" />}
                    label="Result"
                  >
                    <pre className="text-[13px] text-foreground/85 whitespace-pre-wrap leading-relaxed font-sans">
                      {task.result}
                    </pre>
                    {task.verification_summary && (
                      <div className="mt-3 pt-3 border-t border-emerald-500/15">
                        <span className="block text-[10px] uppercase tracking-[0.08em] text-emerald-600/70 dark:text-emerald-400/70 font-semibold mb-1.5">
                          Verification summary
                        </span>
                        <pre className="text-[12px] text-foreground/70 whitespace-pre-wrap leading-relaxed font-sans">
                          {task.verification_summary}
                        </pre>
                      </div>
                    )}
                  </AccentCard>
                )}

                {/* Worker session link */}
                {task.owner_session_id && (
                  <button
                    onClick={() => {
                      openTabAndNavigate({
                        id: task.owner_session_id!,
                        title: task.title || 'Worker session',
                        type: 'session',
                        href: `/sessions/${task.owner_session_id}`,
                      });
                    }}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors cursor-pointer group text-left',
                      isRunning
                        ? 'border-blue-500/20 bg-blue-500/[0.03] hover:bg-blue-500/[0.06]'
                        : 'border-border/40 hover:border-border hover:bg-muted/30',
                    )}
                  >
                    {isRunning ? (
                      <span className="relative flex h-2.5 w-2.5 shrink-0">
                        <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-40" />
                        <span className="relative h-2.5 w-2.5 rounded-full bg-blue-500" />
                      </span>
                    ) : (
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-foreground/60 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className={cn(
                        'text-[13px] font-medium',
                        isRunning ? 'text-blue-500' : 'text-foreground/75 group-hover:text-foreground',
                      )}>
                        Worker session
                      </div>
                      <div className="text-[11px] font-mono text-muted-foreground/40 truncate">
                        {task.owner_session_id}
                      </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground/50 group-hover:text-foreground/70 shrink-0">
                      Open →
                    </span>
                  </button>
                )}

                {/* Activity timeline */}
                <FieldBlock label="Activity">
                  {orderedEvents.length > 0 ? (
                    <Timeline events={orderedEvents} />
                  ) : (
                    <p className="text-[12px] text-muted-foreground/40 italic">
                      {isRunning ? 'Worker starting…' : 'No activity yet.'}
                    </p>
                  )}
                </FieldBlock>
              </div>

              {/* ── Footer ─────────────────────────────────── */}
              <div className="shrink-0 border-t border-border px-5 h-12 flex items-center gap-3 bg-muted/[0.15] rounded-b-2xl">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 gap-1.5 text-[12px] text-muted-foreground/50 hover:text-rose-500 hover:bg-rose-500/10"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </Button>
                <div className="ml-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-3 text-[12px] text-muted-foreground/70 hover:text-foreground"
                    onClick={onClose}
                  >
                    Close
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {task && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete task"
          description={<>Are you sure you want to delete <span className="font-semibold text-foreground">&quot;{task.title}&quot;</span>?</>}
          confirmLabel="Delete"
          onConfirm={() => deleteTaskMutation.mutate(task.id, { onSuccess: () => { setDeleteOpen(false); onClose(); } })}
          isPending={deleteTaskMutation.isPending}
        />
      )}
    </>
  );
}

// ── Field block ──────────────────────────────────────────────────────────

function FieldBlock({
  label,
  subLabel,
  children,
}: {
  label: string;
  subLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
          {label}
        </span>
        {subLabel && (
          <span className="text-[10px] text-muted-foreground/35">{subLabel}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Accent card (blocker / result) ───────────────────────────────────────

function AccentCard({
  tone,
  icon,
  label,
  children,
}: {
  tone: 'amber' | 'emerald';
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const toneClass = tone === 'amber'
    ? 'border-amber-500/20 bg-amber-500/[0.04]'
    : 'border-emerald-500/20 bg-emerald-500/[0.03]';
  const labelClass = tone === 'amber'
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-emerald-600 dark:text-emerald-400';
  return (
    <div className={cn('rounded-xl border p-4', toneClass)}>
      <div className={cn('flex items-center gap-2 mb-2', labelClass)}>
        {icon}
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────

type EventMeta = {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  dotBg: string;
  label: string;
};

const EVENT_META: Record<KortixTaskEvent['type'], EventMeta> = {
  progress: {
    icon: Activity,
    color: 'text-blue-500',
    dotBg: 'bg-blue-500/15 border-blue-500/40',
    label: 'Progress',
  },
  evidence: {
    icon: Paperclip,
    color: 'text-slate-400',
    dotBg: 'bg-slate-400/15 border-slate-400/40',
    label: 'Evidence',
  },
  blocker: {
    icon: AlertOctagon,
    color: 'text-amber-500',
    dotBg: 'bg-amber-500/15 border-amber-500/40',
    label: 'Blocked',
  },
  verification_started: {
    icon: FlaskConical,
    color: 'text-amber-400',
    dotBg: 'bg-amber-400/15 border-amber-400/40',
    label: 'Verifying',
  },
  verification_passed: {
    icon: CheckCircle2,
    color: 'text-emerald-500',
    dotBg: 'bg-emerald-500/15 border-emerald-500/40',
    label: 'Verified',
  },
  verification_failed: {
    icon: XCircle,
    color: 'text-rose-500',
    dotBg: 'bg-rose-500/15 border-rose-500/40',
    label: 'Verification failed',
  },
  delivered: {
    icon: Package,
    color: 'text-emerald-500',
    dotBg: 'bg-emerald-500/15 border-emerald-500/40',
    label: 'Delivered',
  },
};

function Timeline({ events }: { events: KortixTaskEvent[] }) {
  return (
    <ol className="relative">
      {events.map((event, i) => {
        const meta = EVENT_META[event.type] || EVENT_META.progress;
        const Icon = meta.icon;
        const isLast = i === events.length - 1;
        return (
          <li key={event.id} className="relative pl-9 pb-4 last:pb-0">
            {/* Connector line */}
            {!isLast && (
              <span
                aria-hidden
                className="absolute left-[11px] top-6 bottom-0 w-px bg-border/50"
              />
            )}
            {/* Dot + icon */}
            <span
              className={cn(
                'absolute left-0 top-0 flex h-[22px] w-[22px] items-center justify-center rounded-full border',
                meta.dotBg,
              )}
            >
              <Icon className={cn('h-3 w-3', meta.color)} />
            </span>
            {/* Content */}
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={cn('text-[12px] font-semibold', meta.color)}>
                {meta.label}
              </span>
              <span className="text-[11px] text-muted-foreground/40" title={fullDate(event.created_at)}>
                {relativeTime(event.created_at)}
              </span>
            </div>
            {event.message && (
              <pre className="mt-1 text-[12px] text-foreground/75 whitespace-pre-wrap leading-relaxed font-sans">
                {event.message}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}
