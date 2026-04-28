'use client';

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { motion } from 'framer-motion';
import { toast as sonnerToast } from 'sonner';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import {
  useFileContent,
  useInvalidateFileContent,
} from '@/features/files/hooks/use-file-content';
import { uploadFile } from '@/features/files/api/opencode-files';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertCircle,
  ArrowUpRight,
  Boxes,
  Check,
  CircleDot,
  Loader2,
  Pencil,
  Target,
} from 'lucide-react';
import {
  AgentAvatar,
  UserAvatar,
} from '@/components/kortix/agent-avatar';
import {
  useTickets,
  useProjectAgents,
  useProjectActivity,
  useUserHandle,
  type TicketEvent,
  type ProjectAgent,
  type Ticket,
} from '@/hooks/kortix/use-kortix-tickets';
import { useMilestones } from '@/hooks/kortix/use-milestones';
import { useKortixProjectSessions } from '@/hooks/kortix/use-kortix-projects';
import { fullDate } from '@/lib/kortix/task-meta';
import type { ProjectTab } from '@/components/kortix/project-header';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'cancelled', 'archived']);

interface ProjectAboutProps {
  project: any;
  onNavigate?: (tab: ProjectTab) => void;
  onOpenTicket?: (id: string) => void;
}

export function ProjectAbout({
  project,
  onNavigate,
  onOpenTicket,
}: ProjectAboutProps) {
  const projectId = project?.id;

  const { data: tickets = [] } = useTickets(projectId, { pollingEnabled: false });
  const { data: milestones = [] } = useMilestones(projectId, 'all');
  const { data: agents = [] } = useProjectAgents(projectId);
  const { data: sessions = [] } = useKortixProjectSessions(projectId);
  const { data: activity = [] } = useProjectActivity(projectId, {
    pollingEnabled: false,
  });
  const userHandle = useUserHandle();

  const openTickets = useMemo(
    () => tickets.filter((t) => !TERMINAL_STATUSES.has(t.status)),
    [tickets],
  );
  const openMilestones = useMemo(
    () => milestones.filter((m) => m.status === 'open').length,
    [milestones],
  );

  const agentById = useMemo(() => {
    const m = new Map<string, ProjectAgent>();
    agents.forEach((a) => m.set(a.id, a));
    return m;
  }, [agents]);

  const ticketTitleById = useMemo(() => {
    const m = new Map<string, string>();
    tickets.forEach((t) => m.set(t.id, t.title));
    return m;
  }, [tickets]);

  const rawDescription = project?.description?.trim();
  const isAutoDescription =
    rawDescription &&
    project?.name &&
    rawDescription.toLowerCase() === `new project: ${project.name.toLowerCase()}`;
  const description = isAutoDescription ? '' : rawDescription;

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
        }}
        className="mx-auto w-full max-w-3xl px-6 pt-10 pb-24"
      >
        {description && (
          <Section>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </Section>
        )}

        <Section delay={!!description}>
          <StatusRow
            openTickets={openTickets.length}
            openMilestones={openMilestones}
            sessionCount={sessions.length}
            agentCount={agents.length}
            agents={agents}
            userHandle={userHandle}
            onNavigate={onNavigate}
          />
        </Section>

        {openTickets.length > 0 && (
          <Section delay>
            <ActiveWork
              tickets={openTickets.slice(0, 4)}
              total={openTickets.length}
              agentById={agentById}
              onOpenTicket={onOpenTicket}
              onSeeAll={() => onNavigate?.('board')}
            />
          </Section>
        )}

        <Section delay>
          <Activity
            events={activity.slice(0, 16)}
            ticketTitleById={ticketTitleById}
            agentById={agentById}
            onOpenTicket={onOpenTicket}
          />
        </Section>

        <Section delay>
          <ContextSection project={project} />
        </Section>
      </motion.div>
    </div>
  );
}

function Section({
  children,
  delay,
}: {
  children: React.ReactNode;
  delay?: boolean;
}) {
  return (
    <motion.section
      variants={{
        hidden: { opacity: 0, y: 6 },
        show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
      }}
      className={cn(delay && 'mt-10')}
    >
      {children}
    </motion.section>
  );
}

function StatusRow({
  openTickets,
  openMilestones,
  sessionCount,
  agentCount,
  agents,
  userHandle,
  onNavigate,
}: {
  openTickets: number;
  openMilestones: number;
  sessionCount: number;
  agentCount: number;
  agents: ProjectAgent[];
  userHandle: string;
  onNavigate?: (tab: ProjectTab) => void;
}) {
  const stats: Array<{
    label: string;
    value: number;
    dot: string;
    tab: ProjectTab;
  }> = [
    {
      label: openTickets === 1 ? 'open ticket' : 'open tickets',
      value: openTickets,
      dot: 'bg-blue-500',
      tab: 'board',
    },
    {
      label: openMilestones === 1 ? 'milestone' : 'milestones',
      value: openMilestones,
      dot: 'bg-amber-500',
      tab: 'milestones',
    },
    {
      label: sessionCount === 1 ? 'session' : 'sessions',
      value: sessionCount,
      dot: 'bg-violet-500',
      tab: 'sessions',
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {stats.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => onNavigate?.(s.tab)}
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs',
            'text-muted-foreground transition-colors',
            'hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground',
          )}
        >
          <span className={cn('size-1.5 rounded-full', s.dot)} />
          <span className="font-semibold tabular-nums text-foreground">
            {s.value}
          </span>
          <span>{s.label}</span>
        </button>
      ))}

      <span className="mx-1 hidden h-4 w-px bg-border sm:block" />

      <div className="flex -space-x-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="rounded-full ring-2 ring-background">
              <UserAvatar handle={userHandle} avatarUrl={null} size="sm" />
            </span>
          </TooltipTrigger>
          <TooltipContent>@{userHandle}</TooltipContent>
        </Tooltip>
        {agents.map((agent) => (
          <Tooltip key={agent.id}>
            <TooltipTrigger asChild>
              <span className="rounded-full ring-2 ring-background">
                <AgentAvatar
                  hue={agent.color_hue}
                  icon={agent.icon}
                  slug={agent.slug}
                  name={agent.name}
                  size="sm"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              @{agent.slug} · {agent.name}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
      </span>
    </div>
  );
}

function SectionLabel({
  icon: Icon,
  label,
  count,
  onSeeAll,
  liveDot,
}: {
  icon: typeof CircleDot;
  label: string;
  count?: number;
  onSeeAll?: () => void;
  liveDot?: boolean;
}) {
  return (
    <div className="group/header flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground/60" />
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </h2>
        {typeof count === 'number' && count > 0 && (
          <Badge variant="muted" size="sm" className="tabular-nums">
            {count}
          </Badge>
        )}
        {liveDot && <LivePulse />}
      </div>
      {onSeeAll && (
        <button
          type="button"
          onClick={onSeeAll}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/header:opacity-100"
        >
          View all
          <ArrowUpRight className="size-3" />
        </button>
      )}
    </div>
  );
}

function ActiveWork({
  tickets,
  total,
  agentById,
  onOpenTicket,
  onSeeAll,
}: {
  tickets: Ticket[];
  total: number;
  agentById: Map<string, ProjectAgent>;
  onOpenTicket?: (id: string) => void;
  onSeeAll?: () => void;
}) {
  return (
    <div>
      <SectionLabel
        icon={Boxes}
        label="Active work"
        count={total}
        onSeeAll={total > tickets.length ? onSeeAll : undefined}
      />
      <div className="mt-3 overflow-hidden rounded-2xl bg-muted/30">
        {tickets.map((ticket, i) => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            agentById={agentById}
            onOpen={onOpenTicket}
            isLast={i === tickets.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function TicketRow({
  ticket,
  agentById,
  onOpen,
  isLast,
}: {
  ticket: Ticket;
  agentById: Map<string, ProjectAgent>;
  onOpen?: (id: string) => void;
  isLast: boolean;
}) {
  const status = ticket.column?.label ?? ticket.status ?? 'todo';
  const dot = statusDotColor(ticket.status);
  const assignee = ticket.assignees?.[0];
  const agent =
    assignee?.assignee_type === 'agent' && assignee.assignee_id
      ? agentById.get(assignee.assignee_id)
      : undefined;

  return (
    <button
      type="button"
      onClick={() => onOpen?.(ticket.id)}
      className={cn(
        'group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60',
        !isLast && 'border-b border-border/40',
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', dot)} />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/60">
        #{ticket.number}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {ticket.title}
      </span>
      <span className="hidden text-xs uppercase tracking-wider text-muted-foreground/70 sm:inline">
        {status}
      </span>
      {assignee && agent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <AgentAvatar
                hue={agent.color_hue}
                icon={agent.icon}
                slug={agent.slug}
                name={agent.name}
                size="sm"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>@{agent.slug}</TooltipContent>
        </Tooltip>
      ) : assignee?.assignee_type === 'user' && assignee.assignee_id ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <UserAvatar handle={assignee.assignee_id} avatarUrl={null} size="sm" />
            </span>
          </TooltipTrigger>
          <TooltipContent>@{assignee.assignee_id}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground/40">unassigned</span>
      )}
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/30 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
    </button>
  );
}

function statusDotColor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('done') || s.includes('closed')) return 'bg-emerald-500';
  if (s.includes('progress') || s.includes('doing') || s.includes('working')) return 'bg-blue-500';
  if (s.includes('review')) return 'bg-violet-500';
  if (s.includes('block')) return 'bg-rose-500';
  return 'bg-muted-foreground/50';
}

function Activity({
  events,
  ticketTitleById,
  agentById,
  onOpenTicket,
}: {
  events: TicketEvent[];
  ticketTitleById: Map<string, string>;
  agentById: Map<string, ProjectAgent>;
  onOpenTicket?: (id: string) => void;
}) {
  if (events.length === 0) {
    return (
      <div>
        <SectionLabel icon={CircleDot} label="Activity" />
        <div className="mt-3 rounded-2xl bg-muted/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground/85">Quiet so far</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground/65">
            Comments, status changes, and assignments will appear here.
          </p>
        </div>
      </div>
    );
  }

  const groups = groupByDay(events);
  const recent = isRecent(events[0]?.created_at);

  return (
    <div>
      <SectionLabel
        icon={CircleDot}
        label="Activity"
        count={events.length}
        liveDot={recent}
      />
      <div className="mt-3 space-y-5">
        {groups.map(({ label, events: items }, gi) => (
          <div key={label}>
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/55">
                {label}
              </span>
              {gi === 0 && recent && <LivePulse />}
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/40">
                {items.length}
              </span>
            </div>
            <div className="overflow-hidden rounded-2xl bg-muted/30">
              {items.map((ev, i) => (
                <ActivityRow
                  key={ev.id}
                  event={ev}
                  ticketTitle={ticketTitleById.get(ev.ticket_id)}
                  agent={
                    ev.actor_type === 'agent' && ev.actor_id
                      ? agentById.get(ev.actor_id)
                      : undefined
                  }
                  onOpen={onOpenTicket}
                  isLast={i === items.length - 1}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LivePulse() {
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className="absolute size-2 animate-ping rounded-full bg-emerald-500/40" />
      <span className="relative size-1 rounded-full bg-emerald-500" />
    </span>
  );
}

function isRecent(iso?: string): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 5 * 60_000;
}

function ActivityRow({
  event,
  ticketTitle,
  agent,
  onOpen,
  isLast,
}: {
  event: TicketEvent;
  ticketTitle?: string;
  agent?: ProjectAgent;
  onOpen?: (id: string) => void;
  isLast: boolean;
}) {
  const handle =
    event.actor_type === 'user'
      ? `@${event.actor_id ?? 'unknown'}`
      : event.actor_type === 'agent'
        ? `@${agent?.slug ?? event.actor_id ?? 'agent'}`
        : 'System';
  const verb = describeEventType(event.type);
  const verbClass = verbColor(event.type);
  const ref = ticketTitle ?? `ticket ${event.ticket_id.slice(0, 6)}`;

  return (
    <button
      type="button"
      onClick={() => onOpen?.(event.ticket_id)}
      className={cn(
        'group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60',
        !isLast && 'border-b border-border/40',
      )}
    >
      <span className="shrink-0">
        {event.actor_type === 'agent' && agent ? (
          <AgentAvatar
            hue={agent.color_hue}
            icon={agent.icon}
            slug={agent.slug}
            name={agent.name}
            size="sm"
          />
        ) : (
          <UserAvatar
            handle={event.actor_id ?? 'system'}
            avatarUrl={null}
            size="sm"
          />
        )}
      </span>

      <p className="min-w-0 flex-1 truncate text-sm leading-snug text-foreground/85">
        <span className="font-medium text-foreground">{handle}</span>
        <span className={verbClass}> {verb} </span>
        <span className="text-foreground">{ref}</span>
      </p>

      <span
        className="hidden shrink-0 text-xs tabular-nums text-muted-foreground/55 sm:inline"
        title={fullDate(event.created_at)}
      >
        {timeOnly(event.created_at)}
      </span>

      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

function verbColor(type: string): string {
  switch (type) {
    case 'closed':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'created':
    case 'reopened':
      return 'text-blue-600 dark:text-blue-400';
    case 'status_change':
      return 'text-violet-600 dark:text-violet-400';
    default:
      return 'text-muted-foreground';
  }
}

function describeEventType(type: string): string {
  switch (type) {
    case 'comment':
      return 'commented on';
    case 'assigned':
      return 'was assigned to';
    case 'unassigned':
      return 'was unassigned from';
    case 'status_change':
      return 'moved';
    case 'created':
      return 'opened';
    case 'closed':
      return 'closed';
    case 'reopened':
      return 'reopened';
    default:
      return type.replace(/_/g, ' ');
  }
}

function timeOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function groupByDay(events: TicketEvent[]): Array<{ label: string; events: TicketEvent[] }> {
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const lastWeek = new Date(today);
  lastWeek.setDate(today.getDate() - 7);

  const buckets: Record<string, TicketEvent[]> = {};
  const order: string[] = [];

  const push = (label: string, ev: TicketEvent) => {
    if (!buckets[label]) {
      buckets[label] = [];
      order.push(label);
    }
    buckets[label].push(ev);
  };

  for (const ev of events) {
    const t = new Date(ev.created_at);
    if (Number.isNaN(t.getTime())) continue;
    const tDay = startOfDay(t).getTime();
    if (tDay === today.getTime()) push('Today', ev);
    else if (tDay === yesterday.getTime()) push('Yesterday', ev);
    else if (t >= lastWeek)
      push(t.toLocaleDateString([], { weekday: 'long' }), ev);
    else
      push(t.toLocaleDateString([], { month: 'short', day: 'numeric' }), ev);
  }

  return order.map((label) => ({ label, events: buckets[label] }));
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function ContextSection({ project }: { project: any }) {
  const contextPath =
    project?.path && project.path !== '/'
      ? `${project.path.replace(/\/+$/, '')}/.kortix/CONTEXT.md`
      : null;

  const {
    data: contextFile,
    isLoading: contextLoading,
    error: contextError,
  } = useFileContent(contextPath, { staleTime: 30_000 });
  const invalidateContent = useInvalidateFileContent();
  const contextContent = contextFile?.type === 'text' ? contextFile.content : null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEditing = useCallback(() => {
    setDraft(contextContent || '');
    setEditing(true);
  }, [contextContent]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setDraft('');
  }, []);

  const saveContext = useCallback(async () => {
    if (!contextPath || draft === (contextContent || '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const parts = contextPath.split('/');
      const fileName = parts.pop() || 'CONTEXT.md';
      const dirPath = parts.join('/');
      const file = new File([draft], fileName, { type: 'text/markdown' });
      await uploadFile(file, dirPath);
      invalidateContent(contextPath);
      setEditing(false);
    } catch (err) {
      sonnerToast.error(
        err instanceof Error ? `Save failed: ${err.message}` : 'Save failed',
      );
    } finally {
      setSaving(false);
    }
  }, [contextPath, draft, contextContent, invalidateContent]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useEffect(() => {
    if (editing) setTimeout(() => textareaRef.current?.focus(), 0);
  }, [editing]);

  const action = editing ? (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={cancelEditing}
        disabled={saving}
        className="text-muted-foreground hover:text-foreground"
      >
        Cancel
      </Button>
      <Button size="sm" onClick={saveContext} disabled={saving}>
        {saving ? <Loader2 className="animate-spin" /> : <Check />}
        Save
      </Button>
    </div>
  ) : contextContent ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={startEditing}
      className="text-muted-foreground hover:text-foreground"
    >
      <Pencil />
      Edit
    </Button>
  ) : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <SectionLabel icon={Target} label="Context" />
          <Badge
            variant="secondary"
            size="sm"
            className="rounded-md font-mono normal-case tracking-normal"
          >
            .kortix/CONTEXT.md
          </Badge>
        </div>
        {action}
      </div>

      <div className="mt-4">
        {contextLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelEditing();
              }
              if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                saveContext();
              }
            }}
            spellCheck
            className={cn(
              'min-h-60 w-full resize-none overflow-hidden bg-transparent',
              'font-mono text-sm leading-relaxed text-foreground/85 outline-none',
              'placeholder:text-muted-foreground/40',
            )}
            placeholder="# Project context\n\nMission, architecture, key decisions, open questions — the durable project memory every agent reads first."
          />
        ) : contextError || !contextContent ? (
          <button
            onClick={startEditing}
            className="group flex w-full items-start gap-3 rounded-lg py-2 text-left transition-colors hover:bg-muted/30"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground/60" />
            <div>
              <p className="text-sm font-medium text-foreground">No context yet</p>
              <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                Write the durable project memory every agent reads first — mission,
                architecture, key decisions, open questions.
              </p>
            </div>
          </button>
        ) : (
          <article className="prose prose-sm max-w-none dark:prose-invert">
            <UnifiedMarkdown content={contextContent} />
          </article>
        )}
      </div>
    </div>
  );
}
