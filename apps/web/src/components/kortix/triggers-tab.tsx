'use client';

/**
 * Project Triggers tab — filtered view of the global triggers pool.
 *
 * Reuses TaskListItem / TaskDetailPanel / TaskConfigDialog from scheduled-tasks
 * so the project view is identical to the workspace-global Triggers page,
 * just scoped via `project_id`. Creating here stamps project_id so the new
 * trigger surfaces in this tab.
 */

import React, { useMemo, useState } from 'react';
import { useTriggers, useDeleteTrigger, type Trigger } from '@/hooks/scheduled-tasks';
import { TaskConfigDialog } from '@/components/scheduled-tasks/task-config-dialog';
import { TaskDetailPanel } from '@/components/scheduled-tasks/task-detail-panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Plus, Timer, Webhook, Clock, CheckCircle2, Trash2, MessageSquare, Terminal, Globe, Calendar, Ticket as TicketIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTickets, type Ticket } from '@/hooks/kortix/use-kortix-tickets';

// ─── Helpers (same as ScheduledTasksPage) ───────────────────────────────────

function describeCron(expr: string): string {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 6) return expr;
    const [sec, min, hour, day, month, weekday] = parts;
    if (sec.startsWith('*/') && min === '*' && hour === '*') return `Every ${sec.slice(2)} seconds`;
    if (sec === '0' && min.startsWith('*/') && hour === '*') {
      const n = min.slice(2);
      return `Every ${n} minute${n === '1' ? '' : 's'}`;
    }
    if (sec === '0' && min === '0' && hour.startsWith('*/')) {
      const n = hour.slice(2);
      return `Every ${n} hour${n === '1' ? '' : 's'}`;
    }
    if (sec === '0' && !min.includes('*') && !hour.includes('*') && day === '*' && month === '*') {
      if (weekday === '*') return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      if (weekday === '1-5') return `Weekdays at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      return `At ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    return expr;
  } catch {
    return expr;
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiff = Math.abs(diffMs);
  if (absDiff < 60_000) return diffMs > 0 ? 'in <1m' : '<1m ago';
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    return diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
  }
  if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    return diffMs > 0 ? `in ${hrs}h` : `${hrs}h ago`;
  }
  const days = Math.round(absDiff / 86_400_000);
  return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
}

// ─── Row ────────────────────────────────────────────────────────────────────

function TriggerRow({
  trigger,
  selected,
  onClick,
  onDelete,
  deleting,
  boundTicket,
}: {
  trigger: Trigger;
  selected: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  deleting: boolean;
  boundTicket?: Ticket;
}) {
  const actionType = trigger.action_type ?? 'prompt';
  const actionIcon = actionType === 'command'
    ? <Terminal className="h-3 w-3" />
    : actionType === 'http'
      ? <Globe className="h-3 w-3" />
      : <MessageSquare className="h-3 w-3" />;

  return (
    <div
      onClick={onClick}
      className={cn(
        'group flex items-center justify-between p-4 cursor-pointer transition-colors',
        selected ? 'bg-muted/50' : 'hover:bg-muted/30',
      )}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-card border border-border/50 shrink-0">
          {trigger.type === 'cron'
            ? <Timer className="h-4 w-4 text-foreground" />
            : <Webhook className="h-4 w-4 text-foreground" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-[13px] font-medium text-foreground truncate">{trigger.name}</h3>
            <Badge variant={trigger.isActive ? 'highlight' : 'secondary'} className="text-[10px] px-1.5 py-0 h-4">
              {trigger.isActive ? 'Active' : 'Paused'}
            </Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 flex items-center gap-1">
              {actionIcon}
              <span className="capitalize">{actionType}</span>
            </Badge>
            {trigger.ticket_id && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 text-foreground/80">
                <TicketIcon className="h-3 w-3" />
                {boundTicket ? `#${boundTicket.number}` : 'ticket'}
              </Badge>
            )}
          </div>
          <p className="text-[12px] text-muted-foreground/70 truncate">
            {trigger.type === 'cron'
              ? `${describeCron(trigger.cronExpr || '')} · ${trigger.timezone}`
              : `POST ${trigger.webhook?.path || ''}`}
            {boundTicket ? ` · → ${boundTicket.title}` : ''}
          </p>
        </div>
      </div>
      <div className="ml-3 flex items-center gap-3 shrink-0">
        <div className="hidden sm:flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Clock className="h-3 w-3" />
            <span>
              {trigger.type === 'cron'
                ? `Next: ${trigger.isActive ? formatRelativeTime(trigger.nextRunAt) : '--'}`
                : 'On demand'}
            </span>
          </div>
          {trigger.lastRunAt && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              <span>Last: {formatRelativeTime(trigger.lastRunAt)}</span>
            </div>
          )}
        </div>
        <Button
          onClick={onDelete}
          disabled={deleting}
          variant="ghost"
          size="icon-sm"
          className={cn(
            'opacity-0 group-hover:opacity-100 focus:opacity-100 h-7 w-7',
            'text-muted-foreground hover:text-red-500 hover:bg-red-500/10',
            deleting && 'opacity-100 text-red-500',
          )}
          title="Delete trigger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  projectPath: string;
}

export function TriggersTab({ projectId }: Props) {
  const { data: allTriggers = [], isLoading } = useTriggers();
  const { data: projectTickets = [] } = useTickets(projectId);
  const deleteMutation = useDeleteTrigger();
  const [selected, setSelected] = useState<Trigger | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const triggers = useMemo(
    () => allTriggers
      .filter((t) => t.project_id === projectId)
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }),
    [allTriggers, projectId],
  );

  // id → ticket index so each row can resolve its bound ticket without
  // a separate per-row fetch.
  const ticketById = useMemo(() => {
    const m = new Map<string, Ticket>();
    for (const t of projectTickets) m.set(t.id, t);
    return m;
  }, [projectTickets]);

  // Keep selection in sync with refetched data
  React.useEffect(() => {
    if (!selected) return;
    const match = triggers.find((t) => t.id === selected.id);
    if (match) setSelected(match);
    else setSelected(null);
  }, [triggers, selected]);

  const handleDelete = async (e: React.MouseEvent, trigger: Trigger) => {
    e.stopPropagation();
    if (!trigger.id) return;
    if (!confirm(`Delete "${trigger.name}"? This cannot be undone.`)) return;
    try {
      await deleteMutation.mutateAsync(trigger.id);
      toast.success('Trigger deleted');
      if (selected?.id === trigger.id) setSelected(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  return (
    <div className="h-full overflow-hidden flex">
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto max-w-4xl px-4 sm:px-6 py-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Triggers</h2>
              <p className="text-[12px] text-muted-foreground/60 mt-0.5">
                Cron + webhook triggers scoped to this project.
              </p>
            </div>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              Add Trigger
            </Button>
          </div>

          <div className="rounded-xl border border-border/50 divide-y divide-border/40 overflow-hidden bg-card/40">
            {isLoading && (
              <div className="p-4 space-y-3">
                {[1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-xl" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isLoading && triggers.length === 0 && (
              <div className="py-12 px-6 text-center">
                <div className="mx-auto w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-[13px] font-medium mb-1">No triggers in this project</p>
                <p className="text-[12px] text-muted-foreground/60 mb-4">
                  Cron or webhook — runs a prompt, command, or HTTP call when it fires.
                </p>
                <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add trigger
                </Button>
              </div>
            )}
            {triggers.map((t) => (
              <TriggerRow
                key={t.id}
                trigger={t}
                selected={selected?.id === t.id}
                onClick={() => setSelected(selected?.id === t.id ? null : t)}
                onDelete={(e) => handleDelete(e, t)}
                deleting={deleteMutation.isPending}
                boundTicket={t.ticket_id ? ticketById.get(t.ticket_id) : undefined}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-[520px] shrink-0 border-l border-border/60 h-full overflow-y-auto bg-background">
          <TaskDetailPanel trigger={selected} onClose={() => setSelected(null)} />
        </div>
      )}

      {/* Create dialog — stamps project_id */}
      <TaskConfigDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => setShowCreate(false)}
        projectId={projectId}
      />
    </div>
  );
}
