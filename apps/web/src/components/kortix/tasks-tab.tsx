'use client';

/**
 * Tasks tab — search + view toggle (kanban / list).
 *
 * View selection persists to localStorage.
 */

import { useEffect, useState } from 'react';
import {
  Search,
  Plus,
  X,
  LayoutList,
  Columns3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { IconInbox } from '@/components/ui/kortix-icons';
import { Button } from '@/components/ui/button';
import { TaskKanban } from '@/components/kortix/task-kanban';
import { TaskList } from '@/components/kortix/task-list';
import type {
  KortixTask,
  KortixTaskStatus,
} from '@/hooks/kortix/use-kortix-tasks';

type TasksView = 'list' | 'kanban';

const VIEW_STORAGE_KEY = 'kortix:tasks-view';

function readStoredView(): TasksView {
  if (typeof window === 'undefined') return 'kanban';
  const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'list' ? 'list' : 'kanban';
}

interface TasksTabProps {
  tasks: KortixTask[];
  filteredTasks: KortixTask[];
  search: string;
  setSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onStartTask: (id: string) => void;
  onApproveTask: (id: string) => void;
  onOpenTask: (task: KortixTask) => void;
  onNewTask: (status?: KortixTaskStatus) => void;
  onDeleteTask: (id: string) => void;
}

export function TasksTab({
  tasks,
  filteredTasks,
  search,
  setSearch,
  searchRef,
  onStartTask,
  onApproveTask,
  onOpenTask,
  onNewTask,
  onDeleteTask,
}: TasksTabProps) {
  const [view, setView] = useState<TasksView>('kanban');

  // Hydrate from localStorage after mount so SSR/CSR match.
  useEffect(() => {
    setView(readStoredView());
  }, []);

  const selectView = (next: TasksView) => {
    setView(next);
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, next); } catch {}
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* ─── Toolbar — search + view toggle ────────────────────── */}
      <div className="shrink-0 bg-background border-b border-border/50">
        <div className="container mx-auto max-w-7xl px-3 sm:px-4 h-11 flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40 pointer-events-none" />
            <input
              ref={searchRef as React.RefObject<HTMLInputElement>}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              data-slot="input"
              className="h-7 w-[160px] sm:w-[220px] pl-7 pr-7 text-[12px] bg-transparent border border-border/50 rounded-full outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/35 transition-[color,box-shadow]"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center text-muted-foreground/40 hover:text-foreground cursor-pointer rounded-full"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* View toggle */}
          <div className="ml-auto inline-flex items-center rounded-full border border-border/50 p-0.5 bg-background">
            <ViewToggleButton
              active={view === 'list'}
              onClick={() => selectView('list')}
              label="List"
              icon={<LayoutList className="h-3 w-3" />}
            />
            <ViewToggleButton
              active={view === 'kanban'}
              onClick={() => selectView('kanban')}
              label="Kanban"
              icon={<Columns3 className="h-3 w-3" />}
            />
          </div>
        </div>
      </div>

      {/* ─── Body ─────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {tasks.length === 0 ? (
          <EmptyState
            icon={IconInbox}
            title="No tasks yet"
            description={
              <>
                Tasks track work that needs doing. Press{' '}
                <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded border border-border bg-muted/50 text-[11px] font-mono text-foreground/70">C</kbd>{' '}
                any time to create one.
              </>
            }
            action={
              <Button size="sm" onClick={() => onNewTask()} className="h-8 px-4 text-[13px]">
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Create task
              </Button>
            }
          />
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            icon={IconInbox}
            size="sm"
            title="No matches"
            description="No tasks match your search."
            action={
              search ? (
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        ) : view === 'kanban' ? (
          <TaskKanban
            tasks={filteredTasks}
            onStartTask={onStartTask}
            onApproveTask={onApproveTask}
            onOpenTask={onOpenTask}
            onNewTask={onNewTask}
            onDeleteTask={onDeleteTask}
          />
        ) : (
          <TaskList
            tasks={filteredTasks}
            onStartTask={onStartTask}
            onApproveTask={onApproveTask}
            onOpenTask={onOpenTask}
            onNewTask={onNewTask}
            onDeleteTask={onDeleteTask}
          />
        )}
      </div>
    </div>
  );
}

function ViewToggleButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground/60 hover:text-foreground',
      )}
      aria-pressed={active}
      title={`${label} view`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
