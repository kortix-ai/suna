'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowUpRight,
  Boxes,
  CircleDot,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AgentAvatar,
  UserAvatar,
} from '@/components/kortix/agent-avatar';
import {
  useTickets,
  useProjectAgents,
  useProjectActivity,
  type TicketEvent,
  type ProjectAgent,
  type Ticket,
} from '@/hooks/kortix/use-kortix-tickets';
import { fullDate } from '@/lib/kortix/task-meta';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'cancelled', 'archived']);

interface ProjectActivityTabProps {
  projectId: string;
  onOpenTicket?: (id: string) => void;
}

export function ProjectActivityTab({
  projectId,
  onOpenTicket,
}: ProjectActivityTabProps) {
  const { data: tickets = [] } = useTickets(projectId, { pollingEnabled: false });
  const { data: agents = [] } = useProjectAgents(projectId);
  const { data: activity = [] } = useProjectActivity(projectId, {
    pollingEnabled: false,
  });

  const openTickets = useMemo(
    () => tickets.filter((t) => !TERMINAL_STATUSES.has(t.status)),
    [tickets],
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

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
        }}
        className="mx-auto w-full max-w-3xl px-6 pt-12 pb-24"
      >
        <Section>
          <header>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Activity
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              What's in flight and what's happened — every ticket and event in one place.
            </p>
          </header>
        </Section>

        <Section delay>
          <ActiveWork
            tickets={openTickets}
            agentById={agentById}
            onOpenTicket={onOpenTicket}
          />
        </Section>

        <Section delay>
          <Activity
            events={activity}
            ticketTitleById={ticketTitleById}
            agentById={agentById}
            onOpenTicket={onOpenTicket}
          />
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

function SectionLabel({
  icon: Icon,
  label,
  count,
  liveDot,
}: {
  icon: typeof CircleDot;
  label: string;
  count?: number;
  liveDot?: boolean;
}) {
  return (
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
  );
}

function ActiveWork({
  tickets,
  agentById,
  onOpenTicket,
}: {
  tickets: Ticket[];
  agentById: Map<string, ProjectAgent>;
  onOpenTicket?: (id: string) => void;
}) {
  if (tickets.length === 0) {
    return (
      <div>
        <SectionLabel icon={Boxes} label="Active work" />
        <div className="mt-3 rounded-2xl bg-muted/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground/85">Nothing in flight</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground/65">
            Open tickets will show up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionLabel icon={Boxes} label="Active work" count={tickets.length} />
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
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
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
        <SectionLabel icon={CircleDot} label="History" />
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
        label="History"
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
