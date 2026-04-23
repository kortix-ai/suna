'use client';

/**
 * v2 Ticket Board.
 *
 * Columns driven by project_columns, cards by tickets. Drag-and-drop between
 * columns using @dnd-kit; drops call onUpdateStatus which triggers the
 * column rule server-side (auto-assignee + agent triggers).
 *
 * A tiny search filter scopes cards by title/body/#number without changing
 * column membership.
 */

import { useMemo, useState } from 'react';
import {
  Circle,
  CircleDot,
  CheckCircle2,
  Inbox,
  Search,
  Plus,
  X,
  Trash2,
  MoreHorizontal,
  AlertCircle,
  Clock,
  Hourglass,
  Archive,
  PauseCircle,
  Zap,
  ExternalLink,
  Copy,
  type LucideIcon,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type {
  Ticket,
  TicketColumn,
  ProjectAgent,
} from '@/hooks/kortix/use-kortix-tickets';
import { AgentAvatar, UserAvatar, useCurrentUserAvatarProps } from '@/components/kortix/agent-avatar';
import { useTriggers, type Trigger } from '@/hooks/scheduled-tasks';
import { useMilestones, type Milestone } from '@/hooks/kortix/use-milestones';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Timer as TimerIcon, Webhook as WebhookIcon, Check } from 'lucide-react';

// Compact human form of a 6-field cron expression for tooltips.
function describeCron(expr: string): string {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 6) return expr;
    const [sec, min, hour, day, _mo, wd] = parts;
    if (sec === '0' && min.startsWith('*/') && hour === '*') {
      const n = min.slice(2);
      return `every ${n} min`;
    }
    if (sec === '0' && min === '0' && hour.startsWith('*/')) {
      return `every ${hour.slice(2)}h`;
    }
    if (sec === '0' && !min.includes('*') && !hour.includes('*') && day === '*') {
      const hh = hour.padStart(2, '0'), mm = min.padStart(2, '0');
      if (wd === '1-5') return `weekdays ${hh}:${mm}`;
      if (wd === '*') return `daily ${hh}:${mm}`;
      return `${hh}:${mm}`;
    }
    return expr;
  } catch {
    return expr;
  }
}

function formatRelative(ts: string | null): string {
  if (!ts) return 'never';
  const d = new Date(ts).getTime() - Date.now();
  const abs = Math.abs(d);
  if (abs < 60_000) return d > 0 ? 'in <1m' : 'just now';
  if (abs < 3_600_000) return d > 0 ? `in ${Math.round(abs / 60_000)}m` : `${Math.round(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return d > 0 ? `in ${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 3_600_000)}h ago`;
  return d > 0 ? `in ${Math.round(abs / 86_400_000)}d` : `${Math.round(abs / 86_400_000)}d ago`;
}

interface Props {
  tickets: Ticket[];
  columns: TicketColumn[];
  agents: ProjectAgent[];
  onOpenTicket: (t: Ticket) => void;
  onNewTicket: (status?: string) => void;
  onUpdateStatus: (id: string, status: string) => void;
  onDeleteTicket: (id: string) => void;
}

export function TicketBoard({ tickets, columns, agents, onOpenTicket, onNewTicket, onUpdateStatus, onDeleteTicket }: Props) {
  const [search, setSearch] = useState('');
  const [milestoneFilter, setMilestoneFilter] = useState<string>('all'); // 'all' | 'none' | <milestone_id>
  const [deleteTarget, setDeleteTarget] = useState<Ticket | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Project context — derived from the first ticket (they're all same project)
  // so we don't need to add a projectId prop just for this.
  const projectIdForMilestones = tickets[0]?.project_id;
  const { data: milestones = [] } = useMilestones(projectIdForMilestones, 'all');
  const milestoneById = useMemo(() => {
    const m = new Map<string, Milestone>();
    for (const x of milestones) m.set(x.id, x);
    return m;
  }, [milestones]);

  // 8px move threshold before drag starts — otherwise click-to-open on a card
  // would immediately fire a drag and swallow the click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const agentById = useMemo(() => {
    const m = new Map<string, ProjectAgent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const ticketById = useMemo(() => {
    const m = new Map<string, Ticket>();
    for (const t of tickets) m.set(t.id, t);
    return m;
  }, [tickets]);

  // Ticket → triggers pointing at it (ticket_id === <id>). One `useTriggers`
  // call for the whole board; each card gets its own slice via lookup.
  const { data: allTriggers = [] } = useTriggers();
  const triggersByTicket = useMemo(() => {
    const m = new Map<string, Trigger[]>();
    for (const t of allTriggers) {
      const tid = t.ticket_id ?? null;
      if (!tid) continue;
      const arr = m.get(tid) ?? [];
      arr.push(t);
      m.set(tid, arr);
    }
    return m;
  }, [allTriggers]);

  const filtered = useMemo(() => {
    let list = tickets;
    if (milestoneFilter !== 'all') {
      list = list.filter((t) => {
        if (milestoneFilter === 'none') return !t.milestone_id;
        return t.milestone_id === milestoneFilter;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      const num = q.replace(/^#/, '');
      list = list.filter((t) =>
        t.title.toLowerCase().includes(q)
        || t.body_md.toLowerCase().includes(q)
        || String(t.number) === num,
      );
    }
    return list;
  }, [tickets, search, milestoneFilter]);

  const byColumn = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const c of columns) map.set(c.key, []);
    for (const t of filtered) {
      const list = map.get(t.status);
      if (list) list.push(t);
      else map.set(t.status, [t]);
    }
    return map;
  }, [filtered, columns]);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const over = e.over?.id;
    if (!over) return;
    const ticket = ticketById.get(String(e.active.id));
    if (!ticket) return;
    const targetKey = String(over);
    if (targetKey === ticket.status) return;
    onUpdateStatus(ticket.id, targetKey);
  };

  if (tickets.length === 0 && !search) {
    return (
      <EmptyState
        icon={Inbox}
        title="No tickets yet"
        description={<>Press <kbd className="inline-flex items-center min-w-[20px] h-5 px-1 rounded border border-border bg-muted/50 text-[11px] font-mono">C</kbd> to create one.</>}
        action={
          <Button size="sm" onClick={() => onNewTicket()} className="h-8 px-4 text-[13px]">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Create ticket
          </Button>
        }
      />
    );
  }

  const activeTicket = activeId ? ticketById.get(activeId) ?? null : null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 bg-background border-b border-border/50">
        <div className="container mx-auto max-w-7xl px-3 sm:px-4 h-11 flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tickets or #number…"
              className="h-7 w-[220px] pl-7 pr-7 text-[12px] bg-transparent border border-border/50 rounded-full outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/35"
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
          {milestones.length > 0 && (
            <select
              value={milestoneFilter}
              onChange={(e) => setMilestoneFilter(e.target.value)}
              className="h-7 text-[12px] bg-transparent border border-border/50 rounded-full outline-none focus:ring-2 focus:ring-primary/20 px-2.5"
              title="Filter by milestone"
            >
              <option value="all">All milestones</option>
              <option value="none">— no milestone —</option>
              {milestones.filter((m) => m.status === 'open').map((m) => (
                <option key={m.id} value={m.id}>M{m.number} · {m.title}</option>
              ))}
              {milestones.some((m) => m.status !== 'open') && (
                <optgroup label="Closed / cancelled">
                  {milestones.filter((m) => m.status !== 'open').map((m) => (
                    <option key={m.id} value={m.id}>M{m.number} · {m.title} ({m.status})</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          <span className="text-[11px] text-muted-foreground/40 ml-2 hidden sm:inline">
            drag cards to move — or use the ⋯ menu
          </span>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
          <div className="h-full flex gap-4 px-4 sm:px-6 py-4 min-w-max">
            {columns.map((col) => {
              const rows = byColumn.get(col.key) ?? [];
              return (
                <Column
                  key={col.id}
                  column={col}
                  count={rows.length}
                  onAdd={() => onNewTicket(col.key)}
                  isActiveDrag={!!activeId}
                >
                  {rows.length === 0 ? (
                    <button
                      onClick={() => onNewTicket(col.key)}
                      className="w-full py-6 rounded-xl border border-dashed border-border/40 text-[12px] text-muted-foreground/30 hover:text-foreground hover:border-border hover:bg-muted/20 transition-all cursor-pointer"
                    >
                      + Add ticket
                    </button>
                  ) : (
                    rows.map((t) => (
                      <DraggableTicketCard
                        key={t.id}
                        ticket={t}
                        columns={columns}
                        agentById={agentById}
                        onSelect={() => onOpenTicket(t)}
                        onUpdateStatus={onUpdateStatus}
                        onDelete={() => setDeleteTarget(t)}
                        triggersOn={triggersByTicket.get(t.id)}
                        milestone={t.milestone_id ? milestoneById.get(t.milestone_id) : undefined}
                      />
                    ))
                  )}
                </Column>
              );
            })}
          </div>
        </div>

        <DragOverlay dropAnimation={{ duration: 160 }}>
          {activeTicket && (
            <div className="rotate-[1.5deg] opacity-95">
              <TicketCardInner
                ticket={activeTicket}
                agentById={agentById}
                dragging
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete ticket"
        description={<>Delete <span className="font-semibold">#{deleteTarget?.number} — {deleteTarget?.title}</span>? This can&apos;t be undone.</>}
        confirmLabel="Delete"
        onConfirm={() => { if (deleteTarget) { onDeleteTicket(deleteTarget.id); setDeleteTarget(null); } }}
      />
    </div>
  );
}

// ─── Column (drop target) ──────────────────────────────────────────────────

function Column({ column, count, onAdd, isActiveDrag, children }: {
  column: TicketColumn;
  count: number;
  onAdd: () => void;
  isActiveDrag: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  const Icon = iconForColumn(column);
  const tint = tintForColumn(column);
  return (
    <div className="flex flex-col w-[300px] shrink-0 h-full">
      <div className="flex items-center gap-2 mb-2 px-1 shrink-0">
        <Icon className={cn('h-4 w-4', tint)} />
        <span className="text-[13px] font-semibold text-foreground tracking-tight">{column.label}</span>
        <span className="text-[11px] text-muted-foreground/40 tabular-nums">{count}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 w-6 p-0 text-muted-foreground/40 hover:text-foreground"
          onClick={onAdd}
          title="Add ticket"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 pb-4 rounded-xl transition-colors',
          isActiveDrag && 'bg-muted/10',
          isOver && 'bg-primary/[0.04] ring-1 ring-inset ring-primary/30',
        )}
      >
        {children}
      </div>
    </div>
  );
}

// ─── Column icons ───────────────────────────────────────────────────────────
// A small curated set — user picks one per column in Settings → Columns.
// Named by a stable key so storage stays decoupled from the icon rendering.

export const COLUMN_ICONS: Record<string, { Icon: LucideIcon; tint: string; label: string }> = {
  backlog: { Icon: Circle, tint: 'text-muted-foreground/55', label: 'Backlog' },
  progress: { Icon: CircleDot, tint: 'text-blue-500/80', label: 'In progress' },
  review: { Icon: AlertCircle, tint: 'text-amber-500/70', label: 'Review' },
  done: { Icon: CheckCircle2, tint: 'text-emerald-500/70', label: 'Done' },
  waiting: { Icon: PauseCircle, tint: 'text-muted-foreground/55', label: 'Waiting' },
  queued: { Icon: Hourglass, tint: 'text-amber-500/60', label: 'Queued' },
  scheduled: { Icon: Clock, tint: 'text-sky-500/70', label: 'Scheduled' },
  priority: { Icon: Zap, tint: 'text-amber-400/80', label: 'Priority' },
  archive: { Icon: Archive, tint: 'text-muted-foreground/45', label: 'Archive' },
};

export const COLUMN_ICON_KEYS = Object.keys(COLUMN_ICONS);

/** Derive a default icon key from a column's key when the user hasn't picked one. */
export function defaultColumnIcon(key: string): string {
  const k = key.toLowerCase();
  if (k.includes('in_progress') || k.includes('progress') || k.includes('working')) return 'progress';
  if (k.includes('review') || k.includes('qa') || k.includes('test')) return 'review';
  if (k.includes('done') || k.includes('complete') || k.includes('closed') || k.includes('shipped')) return 'done';
  if (k.includes('wait') || k.includes('block')) return 'waiting';
  if (k.includes('queue')) return 'queued';
  if (k.includes('schedule')) return 'scheduled';
  if (k.includes('priority') || k.includes('urgent')) return 'priority';
  if (k.includes('archive')) return 'archive';
  return 'backlog';
}

function iconForColumn(column: TicketColumn): LucideIcon {
  const iconKey = (column as any).icon || defaultColumnIcon(column.key);
  return (COLUMN_ICONS[iconKey] ?? COLUMN_ICONS.backlog).Icon;
}

function tintForColumn(column: TicketColumn): string {
  const iconKey = (column as any).icon || defaultColumnIcon(column.key);
  return (COLUMN_ICONS[iconKey] ?? COLUMN_ICONS.backlog).tint;
}

// ─── Draggable card ─────────────────────────────────────────────────────────

function DraggableTicketCard({ ticket, columns, agentById, onSelect, onUpdateStatus, onDelete, triggersOn, milestone }: {
  ticket: Ticket;
  columns: TicketColumn[];
  agentById: Map<string, ProjectAgent>;
  onSelect: () => void;
  onUpdateStatus: (id: string, status: string) => void;
  onDelete: () => void;
  triggersOn?: Trigger[];
  milestone?: Milestone;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: ticket.id });

  // Whole card is draggable. The 8px activation distance on the sensor keeps
  // click-to-open working for quick taps; longer motion engages DnD.
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.35 : 1 }}
      className="touch-none"
    >
      <TicketCardInner
        ticket={ticket}
        agentById={agentById}
        onSelect={onSelect}
        onUpdateStatus={onUpdateStatus}
        onDelete={onDelete}
        columns={columns}
        triggersOn={triggersOn}
        milestone={milestone}
      />
    </div>
  );
}

function TicketCardInner({
  ticket,
  agentById,
  onSelect,
  onUpdateStatus,
  onDelete,
  columns,
  dragging,
  triggersOn,
  milestone,
}: {
  ticket: Ticket;
  agentById: Map<string, ProjectAgent>;
  onSelect?: () => void;
  onUpdateStatus?: (id: string, status: string) => void;
  onDelete?: () => void;
  columns?: TicketColumn[];
  dragging?: boolean;
  triggersOn?: Trigger[];
  milestone?: Milestone;
}) {
  const { handle: currentHandle, avatarUrl: currentAvatarUrl } = useCurrentUserAvatarProps();

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group rounded-xl border border-border/50 bg-card p-3 cursor-pointer select-none',
        'transition-colors hover:border-border/80 hover:bg-muted/20',
        dragging && 'shadow-xl border-primary/40',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="text-[10px] font-mono tabular-nums text-muted-foreground/40 leading-none">
              #{ticket.number}
            </div>
            {milestone && <MilestoneBadge milestone={milestone} />}
            {triggersOn && triggersOn.length > 0 && (
              <TriggersOnBadge triggers={triggersOn} />
            )}
          </div>
          <p className="text-[13.5px] font-medium leading-snug line-clamp-3 tracking-tight text-foreground/90">
            {ticket.title}
          </p>
        </div>

        {columns && onUpdateStatus && onDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground/50 hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
                aria-label="Ticket actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 z-[10000]" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onSelect?.(); }} className="gap-2 cursor-pointer">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/60" />
                Open ticket
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(`#${ticket.number} ${ticket.title}`); }}
                className="gap-2 cursor-pointer"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground/60" />
                Copy reference
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
                Move to
              </DropdownMenuLabel>
              {columns.filter((c) => c.key !== ticket.status).map((c) => {
                const Ic = iconForColumn(c);
                const tint = tintForColumn(c);
                return (
                  <DropdownMenuItem
                    key={c.key}
                    onClick={(e) => { e.stopPropagation(); onUpdateStatus(ticket.id, c.key); }}
                    className="gap-2 cursor-pointer"
                  >
                    <Ic className={cn('h-3.5 w-3.5', tint)} />
                    <span className="flex-1 truncate">{c.label}</span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="gap-2 cursor-pointer text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete ticket
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2.5 text-[10px] text-muted-foreground/40">
        <span className="tabular-nums">{new Date(ticket.updated_at).toLocaleDateString()}</span>

        {ticket.assignees.length > 0 && (
          <div className="ml-auto flex items-center -space-x-1.5">
            {ticket.assignees.slice(0, 4).map((a, i) => {
              if (a.assignee_type === 'agent') {
                const ag = agentById.get(a.assignee_id);
                if (!ag) return null;
                return (
                  <span key={`a:${a.assignee_id}`} style={{ zIndex: 10 - i }} className="ring-2 ring-card rounded-full">
                    <AgentAvatar hue={ag.color_hue} icon={ag.icon} slug={ag.slug} name={ag.name} size="sm" />
                  </span>
                );
              }
              const isMe = a.assignee_id === currentHandle;
              return (
                <span key={`u:${a.assignee_id}`} style={{ zIndex: 10 - i }} className="ring-2 ring-card rounded-full">
                  <UserAvatar handle={a.assignee_id} avatarUrl={isMe ? currentAvatarUrl : null} size="sm" />
                </span>
              );
            })}
            {ticket.assignees.length > 4 && (
              <span
                className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted/60 text-[9px] font-semibold text-muted-foreground/80 ring-2 ring-card"
                style={{ zIndex: 6 }}
              >
                +{ticket.assignees.length - 4}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── "Ongoing" badge — triggers pointing at this ticket ─────────────────────

// ─── Milestone badge on ticket card ─────────────────────────────────────────

function MilestoneBadge({ milestone }: { milestone: Milestone }) {
  const hue = milestone.color_hue ?? 210;
  const isClosed = milestone.status !== 'open';
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex items-center gap-1 h-4 px-1.5 rounded-full border',
              'text-[9.5px] font-medium leading-none tracking-[0.04em]',
              isClosed
                ? 'border-border/30 bg-muted/20 text-muted-foreground/60 line-through decoration-[0.5px] decoration-muted-foreground/40'
                : 'border-border/40 bg-muted/30',
            )}
            style={isClosed ? undefined : { color: `hsl(${hue} 70% 60%)` }}
          >
            {isClosed ? (
              <Check className="h-[8.5px] w-[8.5px] text-muted-foreground/60" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `hsl(${hue} 70% 55%)` }} />
            )}
            M{milestone.number}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="p-2 max-w-[260px] bg-popover border border-border/60">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-foreground/95">{milestone.title}</span>
            <span className={cn(
              'text-[9px] uppercase tracking-[0.06em] font-semibold px-1 rounded',
              milestone.status === 'open' && 'bg-emerald-500/10 text-emerald-500/90',
              milestone.status === 'closed' && 'bg-muted/50 text-muted-foreground/80',
              milestone.status === 'cancelled' && 'bg-muted/30 text-muted-foreground/60',
            )}>
              {milestone.status}
            </span>
          </div>
          {milestone.acceptance_md && (
            <div className="mt-1 text-[10.5px] text-muted-foreground/70 font-mono line-clamp-3 whitespace-pre-wrap">
              {milestone.acceptance_md}
            </div>
          )}
          <div className="mt-1.5 text-[10px] text-muted-foreground/60">
            {milestone.progress.done}/{milestone.progress.total} done · {milestone.percent_complete}%
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TriggersOnBadge({ triggers }: { triggers: Trigger[] }) {
  const active = triggers.filter((t) => t.isActive);
  const hasAny = triggers.length > 0;
  const hasCron = triggers.some((t) => t.type === 'cron');
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex items-center gap-1 h-4 px-1.5 rounded-full border',
              'text-[9.5px] font-medium tabular-nums leading-none uppercase tracking-[0.06em]',
              active.length > 0
                ? 'border-emerald-400/35 bg-emerald-400/8 text-emerald-400/90'
                : 'border-muted/40 bg-muted/20 text-muted-foreground/55',
            )}
          >
            {hasCron
              ? <TimerIcon className="h-[9px] w-[9px]" />
              : <WebhookIcon className="h-[9px] w-[9px]" />}
            {active.length > 0 ? 'ongoing' : 'paused'}
            {triggers.length > 1 && <span className="opacity-60">·{triggers.length}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="p-2 max-w-[280px] bg-popover border border-border/60">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/60 font-semibold mb-1.5">
            {hasAny ? `${triggers.length} trigger${triggers.length > 1 ? 's' : ''} on this ticket` : 'No triggers'}
          </div>
          <ul className="space-y-1.5">
            {triggers.map((t) => (
              <li key={t.id} className="text-[11.5px] leading-tight">
                <div className="flex items-center gap-1.5">
                  {t.type === 'cron'
                    ? <TimerIcon className="h-3 w-3 text-muted-foreground/70" />
                    : <WebhookIcon className="h-3 w-3 text-muted-foreground/70" />}
                  <span className="font-medium text-foreground/95 truncate">{t.name}</span>
                  {!t.isActive && <span className="text-[9px] text-muted-foreground/55">(paused)</span>}
                </div>
                <div className="ml-4 mt-0.5 text-[10.5px] text-muted-foreground/70 font-mono">
                  {t.type === 'cron'
                    ? `${describeCron(t.cronExpr || '')} · ${t.timezone || 'UTC'} · next ${formatRelative(t.nextRunAt)}`
                    : `POST ${t.webhook?.path || ''}`}
                </div>
                {t.lastRunAt && (
                  <div className="ml-4 text-[10.5px] text-muted-foreground/55">
                    last ran {formatRelative(t.lastRunAt)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
