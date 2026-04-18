'use client';

/**
 * Ticket detail drawer.
 *
 * Matches the visual language of Project About:
 *   - UnifiedMarkdown for body rendering
 *   - Edit-in-place textarea (auto-grows) with Save / Cancel
 *   - Section-label headers, rounded cards with border-border/40 bg-card
 *
 * Side panel holds status, assignees, custom fields, created-at — each row is
 * a compact key-value pair. The activity log sits below the body with a tidy
 * comment composer at the bottom.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Send,
  UserPlus,
  Pencil,
  Check,
  Loader2,
  UserCircle2,
  Bot,
  CircleDot,
  Activity,
  History,
  FileText,
} from 'lucide-react';
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
import { UnifiedMarkdown } from '@/components/markdown';
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
import { relativeTime, fullDate } from '@/lib/kortix/task-meta';

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

  const [editingBody, setEditingBody] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [comment, setComment] = useState('');

  const customFieldValues = useMemo(() => parseCustomFields(ticket?.custom_fields_json), [ticket?.custom_fields_json]);
  const agentById = useMemo(() => { const m = new Map<string, ProjectAgent>(); for (const a of agents) m.set(a.id, a); return m; }, [agents]);

  if (!ticketId) return null;

  const startBodyEdit = () => {
    if (!ticket) return;
    setBodyDraft(ticket.body_md);
    setEditingBody(true);
  };
  const saveBody = () => {
    if (!ticket) return;
    if (bodyDraft !== ticket.body_md) {
      updateTicket.mutate({ id: ticket.id, body_md: bodyDraft });
    }
    setEditingBody(false);
  };
  const cancelBody = () => { setEditingBody(false); setBodyDraft(''); };

  const startTitleEdit = () => {
    if (!ticket) return;
    setTitleDraft(ticket.title);
    setEditingTitle(true);
  };
  const saveTitle = () => {
    if (!ticket) return;
    if (titleDraft.trim() && titleDraft !== ticket.title) {
      updateTicket.mutate({ id: ticket.id, title: titleDraft.trim() });
    }
    setEditingTitle(false);
  };
  const cancelTitle = () => { setEditingTitle(false); setTitleDraft(''); };

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
      <DialogContent
        className="max-w-5xl h-[88vh] p-0 flex flex-col overflow-hidden bg-background gap-0 border-border/60"
        hideCloseButton
      >
        <DialogTitle className="sr-only">{ticket?.title || 'Ticket'}</DialogTitle>
        <DialogDescription className="sr-only">Ticket detail</DialogDescription>

        {!ticket ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading ticket…
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center gap-2 px-5 h-11 shrink-0 border-b border-border/40">
              <span className="font-mono text-[11px] text-muted-foreground/55 tabular-nums">#{ticket.number}</span>
              <span className="text-[11px] text-muted-foreground/30">·</span>
              <span className="text-[11px] text-muted-foreground/60">{ticket.column?.label ?? ticket.status}</span>
              <Button variant="ghost" size="sm" className="ml-auto h-7 w-7 p-0 text-muted-foreground/50 hover:text-foreground" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-[1fr_300px] overflow-hidden">
              {/* Main column */}
              <div className="overflow-y-auto border-r border-border/40">
                <div className="max-w-2xl mx-auto px-6 sm:px-10 py-8 space-y-8">

                  {/* Title */}
                  {editingTitle ? (
                    <TitleEditor
                      value={titleDraft}
                      onChange={setTitleDraft}
                      onSave={saveTitle}
                      onCancel={cancelTitle}
                    />
                  ) : (
                    <button
                      onClick={startTitleEdit}
                      className="text-left w-full group"
                    >
                      <h1 className="text-[28px] font-semibold tracking-tight leading-tight text-foreground group-hover:text-foreground/90 transition-colors">
                        {ticket.title}
                      </h1>
                    </button>
                  )}

                  {/* Body — UnifiedMarkdown render / textarea edit */}
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground/45" />
                      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Description</span>
                      <div className="ml-auto flex items-center gap-1">
                        {editingBody ? (
                          <>
                            <Button
                              variant="ghost" size="sm"
                              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={cancelBody}
                              disabled={updateTicket.isPending}
                            >Cancel</Button>
                            <Button
                              variant="ghost" size="sm"
                              className="h-6 px-2 text-[11px] text-emerald-500 hover:text-emerald-400 gap-1"
                              onClick={saveBody}
                              disabled={updateTicket.isPending}
                            >
                              {updateTicket.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              Save
                            </Button>
                          </>
                        ) : ticket.body_md ? (
                          <Button
                            variant="ghost" size="sm"
                            className="h-6 px-2 text-[11px] text-muted-foreground/50 hover:text-foreground gap-1"
                            onClick={startBodyEdit}
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {editingBody ? (
                      <BodyEditor
                        value={bodyDraft}
                        onChange={setBodyDraft}
                        onSave={saveBody}
                        onCancel={cancelBody}
                      />
                    ) : ticket.body_md ? (
                      <div className="rounded-xl border border-border/40 bg-card px-5 sm:px-6 py-5">
                        <article className="prose prose-sm dark:prose-invert max-w-none">
                          <UnifiedMarkdown content={ticket.body_md} />
                        </article>
                      </div>
                    ) : (
                      <button
                        onClick={startBodyEdit}
                        className="w-full rounded-xl border border-dashed border-border/50 p-8 text-center hover:border-border hover:bg-muted/20 transition-colors cursor-pointer"
                      >
                        <p className="text-[12.5px] text-muted-foreground/55">
                          Add a description — acceptance criteria, notes, anything durable.
                        </p>
                      </button>
                    )}
                  </section>

                  {/* Activity */}
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <History className="h-3.5 w-3.5 text-muted-foreground/45" />
                      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Activity</span>
                      <span className="text-[10px] text-muted-foreground/30 tabular-nums ml-auto">{events?.length ?? 0}</span>
                    </div>
                    <div className="rounded-xl border border-border/40 bg-card divide-y divide-border/30 overflow-hidden">
                      {(events ?? []).length === 0 ? (
                        <div className="text-[12px] text-muted-foreground/40 py-5 text-center">No activity yet.</div>
                      ) : (
                        (events ?? []).map((ev) => (
                          <EventRow key={ev.id} event={ev} agentById={agentById} userHandle={userHandle} />
                        ))
                      )}
                    </div>

                    {/* Comment composer */}
                    <div className="mt-3 rounded-xl border border-border/40 bg-card focus-within:border-border transition-colors">
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            postComment();
                          }
                        }}
                        placeholder="Comment. Use @slug to ping a team agent."
                        rows={3}
                        className="w-full text-[13px] leading-relaxed bg-transparent border-0 outline-none focus:ring-0 resize-none px-4 pt-3 placeholder:text-muted-foreground/35"
                      />
                      <div className="flex items-center gap-2 px-3 pb-2">
                        <span className="text-[10px] text-muted-foreground/40">⌘↵ to send</span>
                        <Button
                          size="sm" className="ml-auto h-7 px-3 text-[12px] gap-1"
                          onClick={postComment}
                          disabled={!comment.trim() || commentTicket.isPending}
                        >
                          <Send className="h-3 w-3" />
                          Comment
                        </Button>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

              {/* Side panel */}
              <aside className="overflow-y-auto p-5 space-y-5 bg-muted/[0.04]">
                <PanelSection label="Status">
                  <StatusPills
                    columns={columns}
                    value={ticket.status}
                    onChange={(v) => updateStatus.mutate({ id: ticket.id, status: v })}
                  />
                </PanelSection>

                <PanelSection label="Assignees">
                  <AssigneeList
                    ticket={ticket}
                    agents={agents}
                    agentById={agentById}
                    userHandle={userHandle}
                    onAssign={(type, id) => assign.mutate({ id: ticket.id, assignee_type: type, assignee_id: id })}
                    onUnassign={(type, id) => unassign.mutate({ id: ticket.id, assignee_type: type, assignee_id: id })}
                  />
                </PanelSection>

                {fields.length > 0 && (
                  <PanelSection label="Fields">
                    <div className="space-y-2.5">
                      {fields.map((f) => (
                        <FieldRow
                          key={f.id}
                          field={f}
                          value={customFieldValues[f.key]}
                          onChange={(v) => onChangeField(f.key, v)}
                        />
                      ))}
                    </div>
                  </PanelSection>
                )}

                <PanelSection label="Timeline">
                  <div className="space-y-1.5 text-[11.5px] text-muted-foreground/65">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground/45">Created</span>
                      <span title={fullDate(ticket.created_at)} className="tabular-nums">{relativeTime(ticket.created_at)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground/45">Updated</span>
                      <span title={fullDate(ticket.updated_at)} className="tabular-nums">{relativeTime(ticket.updated_at)}</span>
                    </div>
                  </div>
                </PanelSection>
              </aside>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Title editor ───────────────────────────────────────────────────────────

function TitleEditor({ value, onChange, onSave, onCancel }: {
  value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  useEffect(() => { setTimeout(() => ref.current?.focus(), 0); }, []);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={onSave}
      rows={1}
      className="w-full text-[28px] font-semibold tracking-tight leading-tight bg-transparent border-0 outline-none focus:ring-0 resize-none overflow-hidden"
    />
  );
}

// ─── Body editor (mirrors About view) ──────────────────────────────────────

function BodyEditor({ value, onChange, onSave, onCancel }: {
  value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(240, el.scrollHeight)}px`;
  }, [value]);
  useEffect(() => { setTimeout(() => ref.current?.focus(), 0); }, []);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); }
      }}
      spellCheck
      className={cn(
        'w-full resize-none overflow-hidden',
        'bg-card border border-border/40 rounded-xl outline-none',
        'text-[13px] text-foreground/85 leading-[1.7] font-mono',
        'placeholder:text-muted-foreground/30',
        'focus:border-primary/30 focus:ring-1 focus:ring-primary/20',
        'p-5 transition-colors',
      )}
      placeholder="Description, acceptance criteria, notes…"
    />
  );
}

// ─── Panel section ──────────────────────────────────────────────────────────

function PanelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-2">{label}</div>
      {children}
    </section>
  );
}

// ─── Status pills in the side panel ─────────────────────────────────────────

function StatusPills({ columns, value, onChange }: { columns: TicketColumn[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {columns.map((c) => {
        const active = c.key === value;
        return (
          <button
            key={c.key}
            onClick={() => onChange(c.key)}
            className={cn(
              'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11.5px] border transition-colors cursor-pointer',
              active
                ? 'bg-foreground text-background border-foreground'
                : 'text-muted-foreground/70 hover:text-foreground border-border/50 hover:border-border bg-transparent',
            )}
          >
            {active ? <Check className="h-3 w-3" /> : <CircleDot className="h-3 w-3 opacity-30" />}
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Assignee list ──────────────────────────────────────────────────────────

function AssigneeList({
  ticket, agents, agentById, userHandle, onAssign, onUnassign,
}: {
  ticket: any;
  agents: ProjectAgent[];
  agentById: Map<string, ProjectAgent>;
  userHandle: string;
  onAssign: (type: 'user' | 'agent', id: string) => void;
  onUnassign: (type: 'user' | 'agent', id: string) => void;
}) {
  const has = (type: 'user' | 'agent', id: string) => ticket.assignees.some((a: any) => a.assignee_type === type && a.assignee_id === id);
  return (
    <div className="space-y-1.5">
      {ticket.assignees.length === 0 && (
        <div className="text-[11.5px] text-muted-foreground/40">Unassigned.</div>
      )}
      {ticket.assignees.map((a: any) => {
        const label = a.assignee_type === 'agent'
          ? `@${agentById.get(a.assignee_id)?.slug ?? 'agent'}`
          : `@${a.assignee_id}`;
        return (
          <div key={`${a.assignee_type}:${a.assignee_id}`} className="flex items-center gap-2">
            <span className={cn(
              'inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11.5px] font-mono',
              a.assignee_type === 'user' ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-foreground/80',
            )}>
              {a.assignee_type === 'user'
                ? <UserCircle2 className="h-3 w-3" />
                : <Bot className="h-3 w-3 opacity-60" />}
              {label}
            </span>
            <button
              onClick={() => onUnassign(a.assignee_type, a.assignee_id)}
              className="h-5 w-5 inline-flex items-center justify-center rounded-full text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors"
              aria-label="Unassign"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-[11.5px] gap-1 text-muted-foreground/70 hover:text-foreground border border-dashed border-border/50 rounded-full mt-0.5"
          >
            <UserPlus className="h-3 w-3" />
            Add
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Assign to</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={has('user', userHandle)}
            onClick={() => onAssign('user', userHandle)}
          >
            <UserCircle2 className="mr-2 h-3.5 w-3.5 text-primary" />
            @{userHandle} <span className="ml-auto text-[10px] text-muted-foreground/40">you</span>
          </DropdownMenuItem>
          {agents.length > 0 && <DropdownMenuSeparator />}
          {agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              disabled={has('agent', a.id)}
              onClick={() => onAssign('agent', a.id)}
            >
              <Bot className="mr-2 h-3.5 w-3.5 text-muted-foreground/60" />
              @{a.slug}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Field row ──────────────────────────────────────────────────────────────

function FieldRow({ field, value, onChange }: { field: ProjectField; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/45 font-medium mb-1">
        {field.label}
      </div>
      <FieldInput field={field} value={value} onChange={onChange} />
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: ProjectField; value: unknown; onChange: (v: unknown) => void }) {
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
    return <input
      type="date" value={(value as string) ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-7 w-full text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
    />;
  }
  if (field.type === 'number') {
    return <input
      type="number" value={(value as number | string) ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      placeholder="Number…"
      className="h-7 w-full text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
    />;
  }
  return <input
    type="text" value={(value as string) ?? ''}
    onChange={(e) => onChange(e.target.value)}
    placeholder="Text…"
    className="h-7 w-full text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
  />;
}

// ─── Event row ──────────────────────────────────────────────────────────────

function EventRow({ event, agentById, userHandle }: { event: any; agentById: Map<string, ProjectAgent>; userHandle: string }) {
  const actorHandle = event.actor_type === 'agent'
    ? agentById.get(event.actor_id ?? '')?.slug ?? 'agent'
    : event.actor_type === 'system' ? 'system' : (event.actor_id || userHandle);

  const p = safeJson(event.payload_json);
  let summary: React.ReactNode;
  if (event.type === 'comment') {
    return (
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <ActorIcon type={event.actor_type} />
          <span className="font-mono text-[11.5px] text-foreground/80">@{actorHandle}</span>
          <span className="text-[10px] text-muted-foreground/40 tabular-nums ml-auto">{relativeTime(event.created_at)}</span>
        </div>
        <div className="text-[13px] text-foreground/85 whitespace-pre-wrap leading-relaxed">{event.message}</div>
      </div>
    );
  }
  if (event.type === 'status_changed') summary = <>moved <span className="font-mono text-muted-foreground/60">{p?.from}</span> → <span className="font-mono text-muted-foreground/90">{p?.to}</span></>;
  else if (event.type === 'assigned') {
    const who = p?.assignee_type === 'agent' ? `@${agentById.get(p.assignee_id)?.slug ?? p.assignee_id}` : `@${p?.assignee_id}`;
    summary = <>assigned {who}</>;
  } else if (event.type === 'unassigned') {
    const who = p?.assignee_type === 'agent' ? `@${agentById.get(p.assignee_id)?.slug ?? p.assignee_id}` : `@${p?.assignee_id}`;
    summary = <>unassigned {who}</>;
  } else if (event.type === 'mention') summary = <>@{agentById.get(p?.mentioned_agent_id)?.slug ?? p?.mentioned_agent_slug} mentioned</>;
  else if (event.type === 'created') summary = <>created the ticket</>;
  else if (event.type === 'field_changed') summary = <>updated fields</>;
  else summary = <>{event.type}{event.message ? ` — ${event.message}` : ''}</>;

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-[12px]">
      <ActorIcon type={event.actor_type} />
      <span className="font-mono text-[11px] text-muted-foreground/65">@{actorHandle}</span>
      <span className="text-muted-foreground/70">{summary}</span>
      <span className="ml-auto text-[10px] text-muted-foreground/35 tabular-nums">{relativeTime(event.created_at)}</span>
    </div>
  );
}

function ActorIcon({ type }: { type: string }) {
  if (type === 'agent') return <Bot className="h-3 w-3 text-muted-foreground/50" />;
  if (type === 'system') return <Activity className="h-3 w-3 text-muted-foreground/40" />;
  return <UserCircle2 className="h-3 w-3 text-primary/70" />;
}

function safeJson(s: string | null): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }
