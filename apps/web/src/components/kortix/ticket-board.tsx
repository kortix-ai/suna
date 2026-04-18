'use client';

/**
 * v2 Ticket Board — columns driven by project_columns, cards driven by tickets.
 *
 * Click a card → onOpenTicket (shows detail drawer).
 * Click "+ Add" in a column → onNewTicket(status).
 * Change status → the status rules fire server-side (auto-assignee + triggers).
 */

import { useMemo, useState } from 'react';
import {
  Circle,
  Loader2,
  UserCircle2,
  Inbox,
  Play,
  Search,
  Plus,
  X,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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

  const agentById = useMemo(() => {
    const m = new Map<string, ProjectAgent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const filtered = useMemo(() => {
    if (!search.trim()) return tickets;
    const q = search.toLowerCase();
    return tickets.filter((t) =>
      t.title.toLowerCase().includes(q)
      || t.body_md.toLowerCase().includes(q)
      || String(t.number) === q.replace(/^#/, ''),
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
        </div>
      </div>

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
              >
                {rows.length === 0 ? (
                  <button
                    onClick={() => onNewTicket(col.key)}
                    className="w-full py-6 rounded-xl border border-dashed border-border/50 text-[12px] text-muted-foreground/30 hover:text-foreground hover:border-border hover:bg-muted/20 transition-all cursor-pointer"
                  >
                    + Add
                  </button>
                ) : (
                  rows.map((t) => (
                    <TicketCard
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

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete ticket"
        description={<>Delete <span className="font-semibold">#{deleteTarget?.number} — {deleteTarget?.title}</span>? This can't be undone.</>}
        confirmLabel="Delete"
        onConfirm={() => { if (deleteTarget) { onDeleteTicket(deleteTarget.id); setDeleteTarget(null); } }}
      />
    </div>
  );
}

function Column({ column, count, onAdd, children }: { column: TicketColumn; count: number; onAdd: () => void; children: React.ReactNode }) {
  const Icon = column.is_terminal ? ColumnIcons.done : (column.key === 'in_progress' ? ColumnIcons.running : ColumnIcons.dot);
  return (
    <div className="flex flex-col w-[320px] shrink-0 h-full">
      <div className="flex items-center gap-2 mb-3 px-1 shrink-0">
        <Icon />
        <span className="text-[13px] font-semibold text-foreground tracking-tight">{column.label}</span>
        <span className="text-[11px] text-muted-foreground/40 tabular-nums">{count}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-1.5 text-[11px] gap-1 text-muted-foreground/50 hover:text-foreground"
          onClick={onAdd}
        >
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 pb-4">
        {children}
      </div>
    </div>
  );
}

function TicketCard({ ticket, columns, agentById, onSelect, onUpdateStatus, onDelete }: {
  ticket: Ticket;
  columns: TicketColumn[];
  agentById: Map<string, ProjectAgent>;
  onSelect: () => void;
  onUpdateStatus: (id: string, status: string) => void;
  onDelete: () => void;
}) {
  const fields = useMemo(() => parseCustomFields(ticket.custom_fields_json), [ticket.custom_fields_json]);
  const fieldEntries = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== '').slice(0, 3);

  const assigneeLabels = ticket.assignees.slice(0, 3).map((a) => {
    if (a.assignee_type === 'agent') {
      const ag = agentById.get(a.assignee_id);
      return ag ? `@${ag.slug}` : '@agent';
    }
    return a.assignee_id === 'user' ? '@user' : `@${a.assignee_id}`;
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={onSelect}
          className={cn(
            'rounded-xl border border-border/50 bg-card p-3 cursor-pointer transition-colors',
            'hover:border-border hover:bg-muted/30',
          )}
        >
          <div className="flex items-start gap-2">
            <p className="text-[13px] font-medium leading-snug line-clamp-3 tracking-tight flex-1 text-foreground/90">
              {ticket.title}
            </p>
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
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onSelect(); }}>Open</DropdownMenuItem>
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
          </div>

          {(fieldEntries.length > 0 || assigneeLabels.length > 0) && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {fieldEntries.map(([k, v]) => (
                <span key={k} className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-medium bg-muted/50 text-muted-foreground/80">
                  {k}: {String(v)}
                </span>
              ))}
              {assigneeLabels.map((l) => (
                <span key={l} className="inline-flex items-center h-4 px-1.5 rounded-full text-[10px] font-mono bg-primary/10 text-primary">
                  {l}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground/40">
            <span className="font-mono tabular-nums">#{ticket.number}</span>
            <span className="ml-auto tabular-nums">{new Date(ticket.updated_at).toLocaleDateString()}</span>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onSelect}>Open</ContextMenuItem>
        {columns.filter((c) => c.key !== ticket.status).map((c) => (
          <ContextMenuItem key={c.key} onClick={() => onUpdateStatus(ticket.id, c.key)}>
            Move → {c.label}
          </ContextMenuItem>
        ))}
        <ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const ColumnIcons = {
  dot: () => <Circle className="h-4 w-4 text-muted-foreground/40" />,
  running: () => <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
  done: () => <UserCircle2 className="h-4 w-4 text-emerald-500/50" />,
};
