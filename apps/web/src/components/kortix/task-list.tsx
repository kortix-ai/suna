'use client';

/**
 * Task List — compact rows grouped by status section.
 *
 * Single vertical scroll. Scroll-down to reach Done.
 * Groups: Planning · Running · Review/Input · Done
 */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Play, CheckCircle2, Plus, Trash2, Copy, Loader2, ExternalLink } from 'lucide-react';
import {
  STATUS_META,
  shortTaskId,
  relativeTime,
} from '@/lib/kortix/task-meta';
import { openTabAndNavigate } from '@/stores/tab-store';
import type {
  KortixTask,
  KortixTaskStatus,
} from '@/hooks/kortix/use-kortix-tasks';

interface TaskListProps {
  tasks: KortixTask[];
  onStartTask: (taskId: string) => void;
  onApproveTask: (taskId: string) => void;
  onOpenTask: (task: KortixTask) => void;
  onNewTask: (status?: KortixTaskStatus) => void;
  onDeleteTask: (taskId: string) => void;
}

export function TaskList({
  tasks,
  onStartTask,
  onApproveTask,
  onOpenTask,
  onNewTask,
  onDeleteTask,
}: TaskListProps) {
  const [deleteTarget, setDeleteTarget] = useState<KortixTask | null>(null);

  const planning = useMemo(() => tasks.filter((t) => t.status === 'todo'), [tasks]);
  const running = useMemo(() => tasks.filter((t) => t.status === 'in_progress'), [tasks]);
  const review = useMemo(() => tasks.filter((t) => t.status === 'input_needed' || t.status === 'awaiting_review'), [tasks]);
  const done = useMemo(() => tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled'), [tasks]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-6">

        {/* ─── Planning ─────────────────────────────────── */}
        <Section
          icon={<STATUS_META.todo.icon className="h-4 w-4 text-muted-foreground/60" />}
          label="Planning"
          count={planning.length}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px] gap-1.5 text-muted-foreground/50 hover:text-foreground"
              onClick={() => onNewTask('todo')}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          }
          emptyText="No planned tasks"
          emptyAction={
            <button
              onClick={() => onNewTask('todo')}
              className="w-full py-6 rounded-xl border border-dashed border-border/50 text-[13px] text-muted-foreground/30 hover:text-foreground hover:border-border hover:bg-muted/20 transition-all cursor-pointer"
            >
              + Create your first task
            </button>
          }
          items={planning}
          renderRow={(task) => (
            <TaskRow
              key={task.id}
              task={task}
              onSelect={() => onOpenTask(task)}
              onDelete={() => setDeleteTarget(task)}
              action={(
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[12px] gap-1.5 shrink-0"
                  onClick={(e) => { e.stopPropagation(); onStartTask(task.id); }}
                >
                  <Play className="h-3 w-3" />
                  Start
                </Button>
              )}
            />
          )}
        />

        {/* ─── Running ────────────────────────────────────── */}
        <Section
          icon={<Loader2 className={`h-4 w-4 ${running.length > 0 ? 'text-blue-500 animate-spin' : 'text-muted-foreground/30'}`} />}
          label="Running"
          count={running.length}
          emptyText="No active workers"
          items={running}
          renderRow={(task) => (
            <TaskRow
              key={task.id}
              task={task}
              onSelect={() => onOpenTask(task)}
              onDelete={() => setDeleteTarget(task)}
              running
              action={task.owner_session_id ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openTabAndNavigate({
                      id: task.owner_session_id!,
                      title: task.title,
                      type: 'session',
                      href: `/sessions/${task.owner_session_id}`,
                    });
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-blue-500/70 hover:text-blue-500 transition-colors cursor-pointer shrink-0"
                >
                  <ExternalLink className="h-3 w-3" />
                  Session
                </button>
              ) : undefined}
            />
          )}
        />

        {/* ─── Review / Input ─────────────────────────────── */}
        <Section
          icon={<STATUS_META.awaiting_review.icon className="h-4 w-4 text-amber-500/50" />}
          label="Review / Input"
          count={review.length}
          emptyText="No tasks awaiting review or input"
          items={review}
          renderRow={(task) => (
            <TaskRow
              key={task.id}
              task={task}
              onSelect={() => onOpenTask(task)}
              onDelete={() => setDeleteTarget(task)}
              action={(
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[12px] gap-1.5 shrink-0"
                  onClick={(e) => { e.stopPropagation(); onApproveTask(task.id); }}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Approve
                </Button>
              )}
            />
          )}
        />

        {/* ─── Done ───────────────────────────────────────── */}
        <Section
          icon={<STATUS_META.completed.icon className="h-4 w-4 text-emerald-500/50" />}
          label="Done"
          count={done.length}
          emptyText="No completed tasks"
          items={done}
          renderRow={(task) => (
            <TaskRow
              key={task.id}
              task={task}
              onSelect={() => onOpenTask(task)}
              onDelete={() => setDeleteTarget(task)}
              dimmed
              badge={task.status === 'cancelled' ? 'Cancelled' : undefined}
            />
          )}
        />
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete task"
        description={<>Are you sure you want to delete <span className="font-semibold text-foreground">&quot;{deleteTarget?.title}&quot;</span>? This action cannot be undone.</>}
        confirmLabel="Delete"
        onConfirm={() => { if (deleteTarget) { onDeleteTask(deleteTarget.id); setDeleteTarget(null); } }}
      />
    </div>
  );
}

// ── Section ──────────────────────────────────────────────────────────────

function Section({
  icon,
  label,
  count,
  action,
  items,
  emptyText,
  emptyAction,
  renderRow,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  action?: React.ReactNode;
  items: KortixTask[];
  emptyText: string;
  emptyAction?: React.ReactNode;
  renderRow: (task: KortixTask) => React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2.5 mb-3">
        {icon}
        <span className="text-[14px] font-semibold text-foreground tracking-tight">{label}</span>
        <span className="text-[12px] text-muted-foreground/40 tabular-nums">{count}</span>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {items.length > 0 ? (
        <div className="rounded-xl border border-border/40 overflow-hidden divide-y divide-border/30 bg-card">
          {items.map(renderRow)}
        </div>
      ) : emptyAction ? (
        emptyAction
      ) : (
        <div className="py-4 text-center text-[12px] text-muted-foreground/25 rounded-xl border border-dashed border-border/30">
          {emptyText}
        </div>
      )}
    </section>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  onSelect,
  onDelete,
  action,
  badge,
  dimmed,
  running,
}: {
  task: KortixTask;
  onSelect: () => void;
  onDelete: () => void;
  action?: React.ReactNode;
  badge?: string;
  dimmed?: boolean;
  running?: boolean;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={onSelect}
          className={cn(
            'flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/30 group',
            dimmed && 'opacity-55',
          )}
        >
          {running ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-40" />
              <span className="relative h-2 w-2 rounded-full bg-blue-500" />
            </span>
          ) : (
            <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/20" />
          )}
          <p className={cn(
            'text-[13px] leading-snug truncate min-w-0 flex-1',
            dimmed ? 'text-muted-foreground/60 line-through decoration-muted-foreground/20' : 'text-foreground/90',
          )}>
            {task.title}
          </p>
          <span className="text-[10px] font-mono tabular-nums text-muted-foreground/35 shrink-0 hidden sm:inline">
            {shortTaskId(task.id)}
          </span>
          {badge && (
            <span className="text-[10px] text-muted-foreground/40 bg-muted/40 px-1.5 py-0.5 rounded shrink-0">
              {badge}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground/35 tabular-nums shrink-0 hidden sm:inline">
            {relativeTime(task.created_at)}
          </span>
          {action}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onSelect}>Open</ContextMenuItem>
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(task.id)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          Copy ID
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
