'use client';

/**
 * Project-level notifications bell.
 *
 * Shows a bell icon with an unread count pill. Click → popover with a
 * chronological feed of mentions + assignments for the current user.
 * Click an entry → opens the ticket drawer. "Mark all read" drops the
 * server timestamp into localStorage so everything older stops counting.
 */

import { useMemo, useState } from 'react';
import { Bell, AtSign, UserPlus, Inbox, CheckCheck } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/kortix/task-meta';
import {
  AgentAvatar,
  UserAvatar,
  useCurrentUserAvatarProps,
} from '@/components/kortix/agent-avatar';
import {
  computeNotifications,
  writeLastSeen,
  type TicketEvent,
  type Ticket,
  type ProjectAgent,
  type ProjectNotification,
} from '@/hooks/kortix/use-kortix-tickets';

export interface NotificationsBellProps {
  projectId: string;
  userHandle: string;
  events: TicketEvent[] | undefined;
  tickets: Ticket[];
  agents: ProjectAgent[];
  lastSeenAt: string | null;
  onMarkAllRead: (iso: string) => void;
  onOpenTicket: (ticketId: string) => void;
}

export function NotificationsBell({
  projectId: _projectId,
  userHandle,
  events,
  tickets,
  agents,
  lastSeenAt,
  onMarkAllRead,
  onOpenTicket,
}: NotificationsBellProps) {
  const [open, setOpen] = useState(false);

  const ticketById = useMemo(() => {
    const m = new Map<string, Ticket>();
    for (const t of tickets) m.set(t.id, t);
    return m;
  }, [tickets]);
  const agentById = useMemo(() => {
    const m = new Map<string, ProjectAgent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  // Unread = after lastSeenAt. Also keep the last 20 overall (read + unread)
  // so the panel shows history once you've caught up, not just an empty state.
  const unread = useMemo(() => computeNotifications(events, userHandle, lastSeenAt), [events, userHandle, lastSeenAt]);
  const recent = useMemo(() => computeNotifications(events, userHandle, null).slice(0, 20), [events, userHandle]);

  const latestAt = useMemo(() => {
    if (!events || events.length === 0) return null;
    return events.reduce((a, e) => (!a || e.created_at > a ? e.created_at : a), null as string | null);
  }, [events]);

  const markAllRead = () => {
    if (latestAt) onMarkAllRead(latestAt);
  };

  const pick = (n: ProjectNotification) => {
    onOpenTicket(n.ticket_id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
          aria-label={unread.length ? `${unread.length} unread notifications` : 'Notifications'}
        >
          <Bell className="h-4 w-4" />
          {unread.length > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold leading-none tabular-nums ring-2 ring-background"
            >
              {unread.length > 99 ? '99+' : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[400px] p-0 z-[10000] overflow-hidden border-border/60"
      >
        <div className="flex items-center gap-2 px-4 h-10 border-b border-border/40">
          <Bell className="h-3.5 w-3.5 text-muted-foreground/55" />
          <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
            Notifications
          </span>
          {unread.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
              {unread.length} new
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[11px] text-muted-foreground/60 hover:text-foreground gap-1 disabled:opacity-40"
            onClick={markAllRead}
            disabled={unread.length === 0}
            title="Mark all as read"
          >
            <CheckCheck className="h-3 w-3" />
            Mark all read
          </Button>
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Inbox className="h-5 w-5 text-muted-foreground/30 mb-2" />
              <p className="text-[12.5px] text-foreground/70 font-medium">All caught up</p>
              <p className="text-[11.5px] text-muted-foreground/50 mt-0.5">
                Mentions and assignments will show up here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/30">
              {recent.map((n) => (
                <NotificationRow
                  key={n.event.id}
                  n={n}
                  ticket={ticketById.get(n.ticket_id)}
                  agentById={agentById}
                  userHandle={userHandle}
                  isUnread={lastSeenAt === null || n.event.created_at > lastSeenAt}
                  onClick={() => pick(n)}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  n, ticket, agentById, userHandle, isUnread, onClick,
}: {
  n: ProjectNotification;
  ticket: Ticket | undefined;
  agentById: Map<string, ProjectAgent>;
  userHandle: string;
  isUnread: boolean;
  onClick: () => void;
}) {
  const { avatarUrl: myAvatarUrl } = useCurrentUserAvatarProps();
  const ev = n.event;
  const actorAgent = ev.actor_type === 'agent' ? agentById.get(ev.actor_id ?? '') : null;

  const actorLabel = actorAgent
    ? `@${actorAgent.slug}`
    : ev.actor_type === 'system'
      ? 'system'
      : `@${ev.actor_id || userHandle}`;

  const Avatar = () => {
    if (actorAgent) {
      return <AgentAvatar hue={actorAgent.color_hue} icon={actorAgent.icon} slug={actorAgent.slug} name={actorAgent.name} size="md" />;
    }
    if (ev.actor_type === 'user') {
      const isMe = (ev.actor_id ?? '') === userHandle;
      return <UserAvatar handle={ev.actor_id || userHandle} avatarUrl={isMe ? myAvatarUrl : null} size="md" />;
    }
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/50 text-muted-foreground/60">
        <UserPlus className="h-3 w-3" />
      </span>
    );
  };

  let KindIcon: typeof AtSign;
  let kindColor: string;
  let summary: React.ReactNode;
  if (n.kind === 'mention') {
    KindIcon = AtSign;
    kindColor = 'text-primary/80';
    summary = <>mentioned you</>;
  } else {
    KindIcon = UserPlus;
    kindColor = 'text-emerald-500/80';
    summary = <>assigned you</>;
  }

  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          'w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-muted/25 transition-colors cursor-pointer',
          isUnread && 'bg-primary/[0.04]',
        )}
      >
        <div className="relative shrink-0">
          <Avatar />
          <span className={cn(
            'absolute -bottom-0.5 -right-0.5 inline-flex h-[14px] w-[14px] items-center justify-center rounded-full bg-background ring-1 ring-border/60',
            kindColor,
          )}>
            <KindIcon className="h-2.5 w-2.5" />
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 text-[12px] text-foreground/85">
            <span className="font-semibold truncate max-w-[110px]">{actorLabel}</span>
            <span className="text-muted-foreground/70 truncate">{summary}</span>
            {ticket && (
              <span className="text-muted-foreground/55 truncate">
                on <span className="font-mono tabular-nums">#{ticket.number}</span> {ticket.title}
              </span>
            )}
          </div>
          {n.kind === 'mention' && ev.message && (
            <p className="text-[12px] text-muted-foreground/75 line-clamp-2 mt-0.5 leading-snug">
              {ev.message}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className="text-[10px] text-muted-foreground/45 tabular-nums whitespace-nowrap">
            {relativeTime(ev.created_at)}
          </span>
          {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="unread" />}
        </div>
      </button>
    </li>
  );
}
