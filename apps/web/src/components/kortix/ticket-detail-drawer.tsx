'use client';

/**
 * Ticket detail drawer — v2.
 *
 * Side panel (like the screenshot you shared): title, markdown body, and
 * right-side panel with status, assignees, custom fields. Below: activity
 * log with a comment composer.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, Send, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  useTicket,
  useTicketEvents,
  useUpdateTicket,
  useUpdateTicketStatus,
  useCommentTicket,
  useAssignTicket,
  useUnassignTicket,
  useUserHandle,
  parseCustomFields,
  type TicketColumn,
  type ProjectField,
  type ProjectAgent,
} from '@/hooks/kortix/use-kortix-tickets';

interface Props {
  ticketId: string | null;
  onClose: () => void;
  columns: TicketColumn[];
  fields: ProjectField[];
  agents: ProjectAgent[];
  pollingEnabled?: boolean;
}

export function TicketDetailDrawer({ ticketId, onClose, columns, fields, agents, pollingEnabled }: Props) {
  const { data: ticket } = useTicket(ticketId ?? undefined, { pollingEnabled });
  const { data: events } = useTicketEvents(ticketId ?? undefined, { pollingEnabled });
  const updateTicket = useUpdateTicket();
  const updateStatus = useUpdateTicketStatus();
  const commentTicket = useCommentTicket();
  const assign = useAssignTicket();
  const unassign = useUnassignTicket();
  const userHandle = useUserHandle();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (ticket) {
      setTitle(ticket.title);
      setBody(ticket.body_md);
    }
  }, [ticket?.id]);

  const customFieldValues = useMemo(() => parseCustomFields(ticket?.custom_fields_json), [ticket?.custom_fields_json]);
  const agentById = useMemo(() => { const m = new Map<string, ProjectAgent>(); for (const a of agents) m.set(a.id, a); return m; }, [agents]);

  if (!ticketId) return null;

  const saveTitle = () => {
    if (ticket && title !== ticket.title) updateTicket.mutate({ id: ticket.id, title });
  };
  const saveBody = () => {
    if (ticket && body !== ticket.body_md) updateTicket.mutate({ id: ticket.id, body_md: body });
  };
  const onChangeField = (key: string, value: unknown) => {
    if (!ticket) return;
    const next = { ...customFieldValues, [key]: value };
    updateTicket.mutate({ id: ticket.id, custom_fields: next });
  };
  const postComment = () => {
    if (!ticket || !comment.trim()) return;
    commentTicket.mutate({ id: ticket.id, body: comment.trim() }, {
      onSuccess: () => setComment(''),
    });
  };

  return (
    <Dialog open={!!ticketId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-5xl h-[85vh] p-0 flex flex-col overflow-hidden">
        <DialogTitle className="sr-only">{ticket?.title || 'Ticket'}</DialogTitle>
        <DialogDescription className="sr-only">Ticket detail</DialogDescription>

        {!ticket ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading ticket…</div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-border/50">
              <span className="font-mono text-[11px] text-muted-foreground/60 tabular-nums">#{ticket.number}</span>
              <span className="text-[11px] text-muted-foreground/40">·</span>
              <span className="text-[11px] text-muted-foreground/60">{ticket.column?.label ?? ticket.status}</span>
              <Button variant="ghost" size="sm" className="ml-auto h-7 w-7 p-0" onClick={onClose}><X className="h-4 w-4" /></Button>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-[1fr_280px] overflow-hidden">
              {/* Main column */}
              <div className="overflow-y-auto border-r border-border/50">
                <div className="px-6 py-5">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                    className="w-full text-xl font-semibold tracking-tight bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/40"
                    placeholder="Ticket title"
                  />
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onBlur={saveBody}
                    rows={Math.max(6, body.split('\n').length + 1)}
                    className="mt-4 w-full text-[13px] leading-relaxed bg-transparent border-0 outline-none focus:ring-0 resize-none font-mono placeholder:text-muted-foreground/40 whitespace-pre-wrap"
                    placeholder="Describe the work. Markdown supported. Reference agents as @slug."
                  />
                </div>

                {/* Activity */}
                <div className="px-6 py-4 border-t border-border/40">
                  <h3 className="text-[11px] uppercase font-medium tracking-wider text-muted-foreground/50 mb-3">Activity</h3>
                  <div className="space-y-3">
                    {(events ?? []).map((ev) => (
                      <EventRow key={ev.id} event={ev} agentById={agentById} userHandle={userHandle} />
                    ))}
                  </div>

                  {/* Comment composer */}
                  <div className="mt-4 rounded-xl border border-border/50 bg-background focus-within:border-border">
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
                      }}
                      placeholder="Comment. Use @slug to ping a team agent."
                      rows={3}
                      className="w-full text-[13px] bg-transparent border-0 outline-none focus:ring-0 resize-none px-3 pt-2.5 placeholder:text-muted-foreground/40"
                    />
                    <div className="flex items-center gap-2 px-2.5 pb-2">
                      <span className="text-[10px] text-muted-foreground/40 ml-1">⌘↵ to send</span>
                      <Button
                        size="sm"
                        className="ml-auto h-7 px-3 text-[12px]"
                        onClick={postComment}
                        disabled={!comment.trim() || commentTicket.isPending}
                      >
                        <Send className="h-3 w-3 mr-1.5" />
                        Comment
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right side panel */}
              <div className="overflow-y-auto p-4 space-y-4 bg-muted/10">
                <PanelRow label="Status">
                  <Select value={ticket.status} onValueChange={(v) => updateStatus.mutate({ id: ticket.id, status: v })}>
                    <SelectTrigger size="sm" className="h-7 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map((c) => (
                        <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </PanelRow>

                <PanelRow label="Assignees">
                  <div className="space-y-1.5">
                    {ticket.assignees.length === 0 && (
                      <span className="text-[12px] text-muted-foreground/50">No one</span>
                    )}
                    {ticket.assignees.map((a) => {
                      const label = a.assignee_type === 'agent'
                        ? `@${agentById.get(a.assignee_id)?.slug ?? 'agent'}`
                        : `@${a.assignee_id}`;
                      return (
                        <div key={`${a.assignee_type}:${a.assignee_id}`} className="flex items-center gap-2">
                          <span className="inline-flex items-center h-5 px-2 rounded-full text-[11px] font-mono bg-primary/10 text-primary">{label}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0 text-muted-foreground/40 hover:text-foreground"
                            onClick={() => unassign.mutate({ id: ticket.id, assignee_type: a.assignee_type, assignee_id: a.assignee_id })}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      );
                    })}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] gap-1 text-muted-foreground/60 hover:text-foreground">
                          <UserPlus className="h-3 w-3" />
                          Assign
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuLabel>Team</DropdownMenuLabel>
                        {agents.map((a) => (
                          <DropdownMenuItem key={a.id} onClick={() => assign.mutate({ id: ticket.id, assignee_type: 'agent', assignee_id: a.id })}>
                            @{a.slug}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => assign.mutate({ id: ticket.id, assignee_type: 'user', assignee_id: userHandle })}>
                          @{userHandle}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </PanelRow>

                {fields.map((f) => (
                  <PanelRow key={f.id} label={f.label}>
                    <CustomFieldInput
                      field={f}
                      value={customFieldValues[f.key]}
                      onChange={(v) => onChangeField(f.key, v)}
                    />
                  </PanelRow>
                ))}

                <PanelRow label="Created">
                  <span className="text-[11px] text-muted-foreground/60">{new Date(ticket.created_at).toLocaleString()}</span>
                </PanelRow>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PanelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground/50 pt-1">{label}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function EventRow({ event, agentById, userHandle }: { event: any; agentById: Map<string, ProjectAgent>; userHandle: string }) {
  const actor = event.actor_type === 'agent'
    ? `@${agentById.get(event.actor_id ?? '')?.slug ?? 'agent'}`
    : event.actor_type === 'system' ? 'system' : `@${event.actor_id || userHandle}`;

  let summary: React.ReactNode;
  if (event.type === 'comment') {
    summary = <span className="text-foreground/90 whitespace-pre-wrap">{event.message}</span>;
  } else if (event.type === 'status_changed') {
    const p = safeJson(event.payload_json);
    summary = <span className="text-muted-foreground/70">moved status <span className="font-mono">{p?.from}</span> → <span className="font-mono">{p?.to}</span></span>;
  } else if (event.type === 'assigned') {
    const p = safeJson(event.payload_json);
    const who = p?.assignee_type === 'agent' ? `@${agentById.get(p.assignee_id)?.slug ?? p.assignee_id}` : `@${p?.assignee_id}`;
    summary = <span className="text-muted-foreground/70">assigned {who}</span>;
  } else if (event.type === 'unassigned') {
    const p = safeJson(event.payload_json);
    const who = p?.assignee_type === 'agent' ? `@${agentById.get(p.assignee_id)?.slug ?? p.assignee_id}` : `@${p?.assignee_id}`;
    summary = <span className="text-muted-foreground/70">unassigned {who}</span>;
  } else if (event.type === 'mention') {
    summary = <span className="text-muted-foreground/70">mention fired</span>;
  } else if (event.type === 'created') {
    summary = <span className="text-muted-foreground/70">created the ticket</span>;
  } else if (event.type === 'field_changed') {
    summary = <span className="text-muted-foreground/70">updated fields</span>;
  } else {
    summary = <span className="text-muted-foreground/70">{event.type}{event.message ? ` — ${event.message}` : ''}</span>;
  }

  return (
    <div className="flex items-start gap-2 text-[12px]">
      <div className="flex-1 min-w-0">
        <div><span className="font-mono text-muted-foreground/60">{actor}</span> {summary}</div>
      </div>
      <div className="text-[10px] text-muted-foreground/40 tabular-nums shrink-0">
        {new Date(event.created_at).toLocaleTimeString()}
      </div>
    </div>
  );
}

function safeJson(s: string | null): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function CustomFieldInput({ field, value, onChange }: { field: ProjectField; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === 'select') {
    let options: string[] = [];
    try { options = field.options_json ? JSON.parse(field.options_json) : []; } catch {}
    const current = (value as string) ?? '';
    return (
      <Select value={current} onValueChange={(v) => onChange(v || null)}>
        <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue placeholder="Choose…" /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === 'date') {
    return <input type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} className="h-7 w-full text-[12px] bg-transparent border border-border/50 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20" />;
  }
  if (field.type === 'number') {
    return <input type="number" value={(value as number | string) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className="h-7 w-full text-[12px] bg-transparent border border-border/50 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20" placeholder="Enter number…" />;
  }
  return <input type="text" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} className="h-7 w-full text-[12px] bg-transparent border border-border/50 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20" placeholder="Enter text…" />;
}
