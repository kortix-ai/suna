'use client';

import { Badge } from '../../primitives/badge';
import { CountBadge } from '../../primitives/count-badge';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { CheckIcon, CircleDashedIcon, CircleHalfIcon, LockSimpleIcon } from '@phosphor-icons/react';
import type { SessionTask, SessionTaskStatus } from '@kortix/sdk';

/**
 * A team's shared task list (flag `agent_teams`), Claude Code's Ctrl+T task
 * list: pending, in progress and completed, each task with its number, the
 * teammate that owns it and the tasks it waits for. A blocked task says so;
 * teammates do not claim it until those tasks complete.
 */

export const TASK_GROUPS: readonly SessionTaskStatus[] = ['pending', 'in_progress', 'completed'];

export function groupTasks(tasks: readonly SessionTask[]): Record<SessionTaskStatus, SessionTask[]> {
  const groups: Record<SessionTaskStatus, SessionTask[]> = { pending: [], in_progress: [], completed: [] };
  for (const task of tasks) groups[task.status]?.push(task);
  for (const list of Object.values(groups)) list.sort((a, b) => a.seq - b.seq);
  return groups;
}

function TaskGlyph({ task }: { task: SessionTask }) {
  if (task.status === 'completed') return <CheckIcon aria-hidden className="text-kortix-green size-3 shrink-0" />;
  if (task.status === 'in_progress') return <CircleHalfIcon aria-hidden className="text-foreground size-3 shrink-0" />;
  if (task.blocked) return <LockSimpleIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />;
  return <CircleDashedIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />;
}

function TaskRow({ task }: { task: SessionTask }) {
  const t = useTranslations('multiAgent.tasks');
  const done = task.status === 'completed';
  return (
    <li data-task-seq={task.seq} className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-xs">
      <TaskGlyph task={task} />
      <span className="text-muted-foreground shrink-0 tabular-nums">#{task.seq}</span>
      <span
        className={cn('min-w-0 flex-1 truncate', done ? 'text-muted-foreground line-through' : 'text-foreground')}
        title={task.description || task.subject}
      >
        {task.subject}
      </span>
      {task.blocked && !done && task.blocked_by.length > 0 && (
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {t('blockedBy', { tasks: task.blocked_by.map((seq) => `#${seq}`).join(', ') })}
        </span>
      )}
      {task.owner_handle ? (
        <Badge variant="outline" size="sm" className="max-w-32 shrink-0 truncate">
          @{task.owner_handle}
        </Badge>
      ) : (
        !done && (
          <Badge variant="muted" size="sm" className="shrink-0">
            {t('unowned')}
          </Badge>
        )
      )}
    </li>
  );
}

export function TasksPanel({ tasks, id }: { tasks: readonly SessionTask[]; id?: string }) {
  const t = useTranslations('multiAgent.tasks');
  const groups = groupTasks(tasks);
  return (
    <section id={id} aria-label={t('label')} className="space-y-1">
      {tasks.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1 text-xs">{t('empty')}</p>
      ) : (
        TASK_GROUPS.map((status) =>
          groups[status].length === 0 ? null : (
            <div key={status}>
              <div className="text-muted-foreground flex items-center gap-1.5 px-2 pt-1 text-xs font-medium">
                {t(`group.${status}`)}
                <CountBadge count={groups[status].length} />
              </div>
              <ul>
                {groups[status].map((task) => (
                  <TaskRow key={task.seq} task={task} />
                ))}
              </ul>
            </div>
          ),
        )
      )}
    </section>
  );
}
