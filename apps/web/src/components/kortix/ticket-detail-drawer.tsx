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
  Circle,
  CheckCircle2,
  Activity,
  History,
  FileText,
  ChevronDown,
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
import { AgentAvatar, UserAvatar, useCurrentUserAvatarProps } from '@/components/kortix/agent-avatar';
import { MentionTextarea } from '@/components/kortix/mention-textarea';
import { MentionMarkdown } from '@/components/kortix/mention-markdown';
import { MarkdownField } from '@/components/kortix/markdown-field';
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
  /** Optional event id to scroll to + briefly highlight — used when opened
   *  from the notifications bell so the user lands on the right comment. */
  focusEventId?: string | null;
}

export function TicketDetailDrawer({ ticketId, onClose, columns, fields, agents, pollingEnabled, focusEventId }: Props) {
  const { data: ticket } = useTicket(ticketId ?? undefined, { pollingEnabled });
  const { data: events } = useTicketEvents(ticketId ?? undefined, { pollingEnabled });
  const updateTicket = useUpdateTicket();
  const updateStatus = useUpdateTicketStatus();
  const commentTicket = useCommentTicket();
  const assign = useAssignTicket();
  const unassign = useUnassignTicket();
  const userHandle = useUserHandle();
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatarProps();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [comment, setComment] = useState('');

  const customFieldValues = useMemo(() => parseCustomFields(ticket?.custom_fields_json), [ticket?.custom_fields_json]);
  const agentById = useMemo(() => { const m = new Map<string, ProjectAgent>(); for (const a of agents) m.set(a.id, a); return m; }, [agents]);

  if (!ticketId) return null;

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
                <div className="max-w-2xl mx-auto px-4 sm:px-3 py-8 space-y-8">

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

                  {/* Body — single shared MarkdownField handles view + edit */}
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground/45" />
                      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Description</span>
                    </div>
                    <MarkdownField
                      value={ticket.body_md}
                      onSave={(next) => updateTicket.mutate({ id: ticket.id, body_md: next })}
                      agents={agents}
                      userHandle={userHandle}
                      userAvatarUrl={myAvatarUrl}
                      placeholder="Add a description — acceptance criteria, notes, anything durable."
                    />
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
                          <EventRow
                            key={ev.id}
                            event={ev}
                            agentById={agentById}
                            userHandle={userHandle}
                            agents={agents}
                            focused={focusEventId === ev.id}
                          />
                        ))
                      )}
                    </div>

                    {/* Comment composer */}
                    <div className="mt-3 rounded-xl border border-border/40 bg-card focus-within:border-border transition-colors">
                      <MentionTextarea
                        value={comment}
                        onChange={setComment}
                        agents={agents}
                        userHandle={userHandle}
                        userAvatarUrl={myAvatarUrl}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            postComment();
                          }
                        }}
                        placeholder="Comment. Type @ to tag a team member."
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

// ─── Panel section ──────────────────────────────────────────────────────────

function PanelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-2">{label}</div>
      {children}
    </section>
  );
}

// ─── Status picker (dropdown) ───────────────────────────────────────────────

function columnIcon(c: TicketColumn) {
  if (c.is_terminal) return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/70" />;
  if (c.key === 'in_progress') return <Loader2 className="h-3.5 w-3.5 text-blue-500/80" />;
  if (c.key === 'review') return <CircleDot className="h-3.5 w-3.5 text-amber-500/70" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/55" />;
}

function StatusPills({ columns, value, onChange }: { columns: TicketColumn[]; value: string; onChange: (k: string) => void }) {
  const selected = columns.find((c) => c.key === value) ?? columns[0];
  if (!selected) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="group w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/50 hover:border-border bg-card hover:bg-muted/40 text-[12.5px] text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          {columnIcon(selected)}
          <span className="flex-1 text-left truncate font-medium">{selected.label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px] z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
          Move to
        </DropdownMenuLabel>
        {columns.map((c) => {
          const active = c.key === value;
          return (
            <DropdownMenuItem
              key={c.key}
              onClick={() => onChange(c.key)}
              className="gap-2 cursor-pointer"
            >
              {columnIcon(c)}
              <span className="flex-1 truncate">{c.label}</span>
              {active && <Check className="h-3 w-3 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatarProps();
  return (
    <div className="space-y-1.5">
      {ticket.assignees.length === 0 && (
        <div className="text-[11.5px] text-muted-foreground/40">Unassigned.</div>
      )}
      {ticket.assignees.map((a: any) => {
        const isMe = a.assignee_type === 'user' && a.assignee_id === userHandle;
        const ag = a.assignee_type === 'agent' ? agentById.get(a.assignee_id) : null;
        const label = ag ? `@${ag.slug}` : `@${a.assignee_id}`;
        return (
          <div key={`${a.assignee_type}:${a.assignee_id}`} className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 h-6 pl-0.5 pr-2 rounded-full text-[11.5px] bg-muted/40">
              {ag ? (
                <AgentAvatar hue={ag.color_hue} icon={ag.icon} slug={ag.slug} name={ag.name} size="sm" />
              ) : (
                <UserAvatar handle={a.assignee_id} avatarUrl={isMe ? myAvatarUrl : null} size="sm" />
              )}
              <span className="font-mono text-foreground/85">{label}</span>
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
        <DropdownMenuContent align="start" className="w-60 z-[10000]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Assign to</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={has('user', userHandle)}
            onClick={() => onAssign('user', userHandle)}
            className="gap-2 cursor-pointer"
          >
            <UserAvatar handle={userHandle} avatarUrl={myAvatarUrl} size="sm" />
            <span className="flex-1 truncate">@{userHandle}</span>
            <span className="text-[10px] text-muted-foreground/40">you</span>
          </DropdownMenuItem>
          {agents.length > 0 && <DropdownMenuSeparator />}
          {agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              disabled={has('agent', a.id)}
              onClick={() => onAssign('agent', a.id)}
              className="gap-2 cursor-pointer"
            >
              <AgentAvatar hue={a.color_hue} icon={a.icon} slug={a.slug} name={a.name} size="sm" />
              <span className="flex-1 truncate">@{a.slug}</span>
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
    try { options = field.options_json ? JSON.parse(field.options_json) : []; } catch { }
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

function EventRow({ event, agentById, userHandle, agents, focused }: { event: any; agentById: Map<string, ProjectAgent>; userHandle: string; agents: ProjectAgent[]; focused?: boolean }) {
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatarProps();
  const ref = useRef<HTMLDivElement>(null);

  // When opened from a notification, scroll to this event and briefly ring
  // it so the user can see what the notification was pointing at.
  useEffect(() => {
    if (!focused) return;
    const t = setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    return () => clearTimeout(t);
  }, [focused]);

  const actorAgent = event.actor_type === 'agent' ? agentById.get(event.actor_id ?? '') : null;
  const actorHandle = event.actor_type === 'agent'
    ? (actorAgent?.slug ?? 'agent')
    : event.actor_type === 'system' ? 'system' : (event.actor_id || userHandle);
  const isMeUser = event.actor_type === 'user' && actorHandle === userHandle;
  const Avatar = () => {
    if (event.actor_type === 'agent' && actorAgent) {
      return <AgentAvatar hue={actorAgent.color_hue} icon={actorAgent.icon} slug={actorAgent.slug} name={actorAgent.name} size="sm" />;
    }
    if (event.actor_type === 'system') {
      return <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted/50 text-muted-foreground/60"><Activity className="h-3 w-3" /></span>;
    }
    return <UserAvatar handle={actorHandle} avatarUrl={isMeUser ? myAvatarUrl : null} size="sm" />;
  };

  const focusRing = focused ? 'ring-2 ring-primary/40 ring-offset-0 bg-primary/[0.04]' : '';

  const p = safeJson(event.payload_json);
  let summary: React.ReactNode;
  if (event.type === 'comment') {
    return (
      <div ref={ref} className={cn('px-4 py-3 transition-colors rounded-lg', focusRing)} data-event-id={event.id}>
        <div className="flex items-center gap-2 mb-1.5">
          <Avatar />
          <span className="font-mono text-[11.5px] text-foreground/80">@{actorHandle}</span>
          <span className="text-[10px] text-muted-foreground/40 tabular-nums ml-auto">{relativeTime(event.created_at)}</span>
        </div>
        <MentionMarkdown
          content={event.message ?? ''}
          agents={agents}
          userHandle={userHandle}
          className="text-[13px] leading-relaxed"
        />
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
    <div ref={ref} className={cn('flex items-center gap-2 px-4 py-2 text-[12px] rounded-lg transition-colors', focusRing)} data-event-id={event.id}>
      <Avatar />
      <span className="font-mono text-[11px] text-muted-foreground/65">@{actorHandle}</span>
      <span className="text-muted-foreground/70">{summary}</span>
      <span className="ml-auto text-[10px] text-muted-foreground/35 tabular-nums">{relativeTime(event.created_at)}</span>
    </div>
  );
}

function safeJson(s: string | null): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }
