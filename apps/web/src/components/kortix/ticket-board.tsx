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
  Loader2,
  CheckCircle2,
  Inbox,
  Search,
  Plus,
  X,
  Trash2,
  MoreHorizontal,
  GripVertical,
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
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type {
  Ticket,
  TicketColumn,
  ProjectAgent,
} from '@/hooks/kortix/use-kortix-tickets';
import { parseCustomFields } from '@/hooks/kortix/use-kortix-tickets';

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
  const [deleteTarget, setDeleteTarget] = useState<Ticket | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

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

  const filtered = useMemo(() => {
    if (!search.trim()) return tickets;
    const q = search.toLowerCase();
    const num = q.replace(/^#/, '');
    return tickets.filter((t) =>
      t.title.toLowerCase().includes(q)
      || t.body_md.toLowerCase().includes(q)
      || String(t.number) === num,
    );
  }, [tickets, search]);

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
  return (
    <div className="flex flex-col w-[300px] shrink-0 h-full">
      <div className="flex items-center gap-2 mb-2 px-1 shrink-0">
        <Icon />
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

function iconForColumn(column: TicketColumn) {
  if (column.is_terminal) return () => <CheckCircle2 className="h-4 w-4 text-emerald-500/60" />;
  if (column.key === 'in_progress') return () => <Loader2 className="h-4 w-4 text-blue-500/80 animate-spin" />;
  if (column.key === 'review') return () => <Circle className="h-4 w-4 text-amber-500/60" />;
  return () => <Circle className="h-4 w-4 text-muted-foreground/40" />;
}

// ─── Draggable card ─────────────────────────────────────────────────────────

function DraggableTicketCard({ ticket, columns, agentById, onSelect, onUpdateStatus, onDelete }: {
  ticket: Ticket;
  columns: TicketColumn[];
  agentById: Map<string, ProjectAgent>;
  onSelect: () => void;
  onUpdateStatus: (id: string, status: string) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: ticket.id });

  // The whole card is draggable — the 8px activation threshold on the sensor
  // keeps click-to-open working for quick taps. The grip icon is purely a
  // visual affordance so users know the card is movable.
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
        showGripAffordance
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
  showGripAffordance,
}: {
  ticket: Ticket;
  agentById: Map<string, ProjectAgent>;
  onSelect?: () => void;
  onUpdateStatus?: (id: string, status: string) => void;
  onDelete?: () => void;
  columns?: TicketColumn[];
  dragging?: boolean;
  showGripAffordance?: boolean;
}) {
  const fields = useMemo(() => parseCustomFields(ticket.custom_fields_json), [ticket.custom_fields_json]);
  const fieldEntries = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 3);

  const assigneeLabels = ticket.assignees.slice(0, 3).map((a) => {
    if (a.assignee_type === 'agent') {
      const ag = agentById.get(a.assignee_id);
      return ag ? `@${ag.slug}` : '@agent';
    }
    return `@${a.assignee_id}`;
  });

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
        {showGripAffordance && (
          <span
            aria-hidden
            className="mt-0.5 -ml-1 h-5 w-4 flex items-center justify-center text-muted-foreground/15 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        )}

        <p className="text-[13px] font-medium leading-snug line-clamp-3 tracking-tight flex-1 text-foreground/90">
          {ticket.title}
        </p>

        {columns && onUpdateStatus && onDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onSelect?.(); }}>Open</DropdownMenuItem>
              <DropdownMenuSeparator />
              {columns.filter((c) => c.key !== ticket.status).map((c) => (
                <DropdownMenuItem
                  key={c.key}
                  onClick={(e) => { e.stopPropagation(); onUpdateStatus(ticket.id, c.key); }}
                >
                  Move → {c.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {(fieldEntries.length > 0 || assigneeLabels.length > 0) && (
        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
          {fieldEntries.map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-medium bg-muted/50 text-muted-foreground/80"
            >
              {k}: {String(v)}
            </span>
          ))}
          {assigneeLabels.map((l) => (
            <span
              key={l}
              className="inline-flex items-center h-4 px-1.5 rounded-full text-[10px] font-mono bg-primary/10 text-primary"
            >
              {l}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-2.5 text-[10px] text-muted-foreground/40">
        <span className="font-mono tabular-nums">#{ticket.number}</span>
        <span className="ml-auto tabular-nums">{new Date(ticket.updated_at).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
