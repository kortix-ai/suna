'use client';

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
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
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  CircleDot,
  Copy,
  FileText,
  FolderGit2,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import {
  AgentAvatar,
  UserAvatar,
} from '@/components/kortix/agent-avatar';
import { useTickets, useProjectAgents, useProjectActivity, useUserHandle, type TicketEvent, type ProjectAgent, type Ticket } from '@/hooks/kortix/use-kortix-tickets';
import { useMilestones, type Milestone } from '@/hooks/kortix/use-milestones';
import { useKortixProjectSessions } from '@/hooks/kortix/use-kortix-projects';
import { relativeTime, fullDate } from '@/lib/kortix/task-meta';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'cancelled', 'archived']);

interface ProjectAboutProps {
  project: any;
}

export function ProjectAbout({ project }: ProjectAboutProps) {
  const projectId = project?.id;

  const { data: tickets = [], isLoading: ticketsLoading } = useTickets(projectId, {
    pollingEnabled: false,
  });
  const { data: milestones = [], isLoading: milestonesLoading } = useMilestones(
    projectId,
    'all',
  );
  const { data: agents = [], isLoading: agentsLoading } = useProjectAgents(projectId);
  const { data: sessions = [], isLoading: sessionsLoading } =
    useKortixProjectSessions(projectId);
  const { data: activity = [], isLoading: activityLoading } = useProjectActivity(
    projectId,
    { pollingEnabled: false },
  );
  const userHandle = useUserHandle();

  const ticketStats = useMemo(() => {
    const total = tickets.length;
    const open = tickets.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
    const done = total - open;
    return { total, open, done };
  }, [tickets]);

  const milestoneStats = useMemo(() => {
    const open = milestones.filter((m) => m.status === 'open').length;
    const closed = milestones.filter((m) => m.status === 'closed').length;
    return { total: milestones.length, open, closed };
  }, [milestones]);

  const activeMilestones = useMemo(
    () =>
      milestones
        .filter((m) => m.status === 'open')
        .sort((a, b) => {
          const ad = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
          const bd = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
          return ad - bd;
        })
        .slice(0, 4),
    [milestones],
  );

  const ticketTitleById = useMemo(() => {
    const m = new Map<string, string>();
    tickets.forEach((t) => m.set(t.id, t.title));
    return m;
  }, [tickets]);

  const recentActivity = useMemo(() => activity.slice(0, 8), [activity]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 sm:px-6 sm:py-10">
        <StatsGrid
          loading={ticketsLoading || milestonesLoading || agentsLoading || sessionsLoading}
          tickets={ticketStats}
          milestones={milestoneStats}
          sessions={sessions.length}
          agents={agents.length}
        />

        <Section
          icon={Target}
          label="Active milestones"
          count={milestoneStats.open}
          loading={milestonesLoading}
        >
          {activeMilestones.length === 0 ? (
            <EmptyTile
              icon={Target}
              title="No active milestones"
              hint="Create a milestone to group tickets toward a release goal."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {activeMilestones.map((m) => (
                <MilestoneCard key={m.id} milestone={m} />
              ))}
            </div>
          )}
        </Section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
          <Section icon={Users} label="Team" count={agents.length} loading={agentsLoading}>
            <TeamPanel agents={agents} userHandle={userHandle} />
          </Section>

          <Section
            icon={Sparkles}
            label="Recent activity"
            count={recentActivity.length}
            loading={activityLoading}
          >
            <ActivityPanel
              events={recentActivity}
              ticketTitleById={ticketTitleById}
            />
          </Section>
        </div>

        <ContextSection project={project} />
      </div>
    </div>
  );
}

function StatsGrid({
  loading,
  tickets,
  milestones,
  sessions,
  agents,
}: {
  loading: boolean;
  tickets: { total: number; open: number; done: number };
  milestones: { total: number; open: number; closed: number };
  sessions: number;
  agents: number;
}) {
  const items: Array<{
    label: string;
    value: number;
    sub: string;
    icon: typeof CircleDot;
  }> = [
    {
      label: 'Tickets',
      value: tickets.total,
      sub: `${tickets.open} open · ${tickets.done} done`,
      icon: CircleDot,
    },
    {
      label: 'Milestones',
      value: milestones.total,
      sub: `${milestones.open} open · ${milestones.closed} closed`,
      icon: Target,
    },
    {
      label: 'Sessions',
      value: sessions,
      sub: sessions === 1 ? '1 chat' : `${sessions} chats`,
      icon: MessageSquareText,
    },
    {
      label: 'Agents',
      value: agents,
      sub: agents === 1 ? '1 in the team' : `${agents} in the team`,
      icon: Users,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-col gap-2 rounded-2xl border bg-card p-4"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {item.label}
            </span>
            <item.icon className="size-3.5 text-muted-foreground/50" />
          </div>
          {loading ? (
            <Skeleton className="h-7 w-12" />
          ) : (
            <span className="text-2xl font-semibold tabular-nums tracking-tight">
              {item.value}
            </span>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {loading ? <Skeleton className="h-3 w-20" /> : item.sub}
          </span>
        </div>
      ))}
    </div>
  );
}

function Section({
  icon: Icon,
  label,
  count,
  loading,
  action,
  children,
}: {
  icon: typeof Target;
  label: string;
  count?: number;
  loading?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground/60" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {typeof count === 'number' && !loading && (
          <Badge variant="muted" size="sm" className="tabular-nums">
            {count}
          </Badge>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function MilestoneCard({ milestone }: { milestone: Milestone }) {
  const pct = Math.max(0, Math.min(100, milestone.percent_complete));
  const total = milestone.progress?.total ?? 0;
  const done = milestone.progress?.done ?? 0;
  const due = milestone.due_at;

  return (
    <div className="group flex flex-col gap-3 rounded-2xl border bg-card p-4 transition-colors hover:bg-muted/30">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
            {milestone.title}
          </h3>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {done} of {total} tickets · {pct}%
          </p>
        </div>
        <Badge
          variant={due ? 'highlight' : 'muted'}
          size="sm"
          className="tabular-nums"
        >
          {due ? relativeTime(due) : 'No due date'}
        </Badge>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/80 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function TeamPanel({
  agents,
  userHandle,
}: {
  agents: ProjectAgent[];
  userHandle: string;
}) {
  if (agents.length === 0) {
    return (
      <EmptyTile
        icon={Users}
        title="No agents yet"
        hint="Add an agent in Settings → Team to start delegating work."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <Member
        avatar={
          <UserAvatar
            handle={userHandle}
            avatarUrl={null}
            size="sm"
          />
        }
        name={`@${userHandle}`}
        role="Human · default reviewer"
      />
      {agents.map((agent) => (
        <Member
          key={agent.id}
          avatar={
            <AgentAvatar
              hue={agent.color_hue}
              icon={agent.icon}
              slug={agent.slug}
              name={agent.name}
              size="sm"
            />
          }
          name={`@${agent.slug}`}
          role={agent.name}
        />
      ))}
    </div>
  );
}

function Member({
  avatar,
  name,
  role,
}: {
  avatar: React.ReactNode;
  name: string;
  role: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      {avatar}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tabular-nums text-foreground">
          {name}
        </p>
        <p className="truncate text-xs text-muted-foreground">{role}</p>
      </div>
    </div>
  );
}

function ActivityPanel({
  events,
  ticketTitleById,
}: {
  events: TicketEvent[];
  ticketTitleById: Map<string, string>;
}) {
  if (events.length === 0) {
    return (
      <EmptyTile
        icon={Sparkles}
        title="Nothing yet"
        hint="Comments, status changes, and assignments will appear here."
      />
    );
  }

  return (
    <ol className="overflow-hidden rounded-2xl border bg-card">
      {events.map((ev) => (
        <ActivityRow
          key={ev.id}
          event={ev}
          ticketTitle={ticketTitleById.get(ev.ticket_id)}
        />
      ))}
    </ol>
  );
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
      return 'created';
    case 'closed':
      return 'closed';
    case 'reopened':
      return 'reopened';
    default:
      return type.replace(/_/g, ' ');
  }
}

function ActivityRow({
  event,
  ticketTitle,
}: {
  event: TicketEvent;
  ticketTitle?: string;
}) {
  const actor =
    event.actor_type === 'user'
      ? `@${event.actor_id ?? 'unknown'}`
      : event.actor_type === 'agent'
        ? `@${event.actor_id ?? 'agent'}`
        : 'System';
  const action = describeEventType(event.type);
  const ticketRef =
    ticketTitle ?? `ticket ${event.ticket_id.slice(0, 6)}`;

  return (
    <li className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{actor}</span>{' '}
          {action}{' '}
          <span className="font-medium text-foreground">{ticketRef}</span>
        </p>
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground/70">
          {relativeTime(event.created_at)}
        </p>
      </div>
    </li>
  );
}

function EmptyTile({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof Target;
  title: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed bg-card/40 px-6 py-10 text-center">
      <div className="mx-auto flex size-9 items-center justify-center rounded-lg border bg-card text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">{hint}</p>
    </div>
  );
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
  const [pathCopied, setPathCopied] = useState(false);

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

  const copyPath = useCallback(() => {
    if (!project?.path) return;
    navigator.clipboard.writeText(project.path).catch(() => {});
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1200);
  }, [project?.path]);

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
      <Button
        size="sm"
        onClick={saveContext}
        disabled={saving}
      >
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
    <Section icon={FileText} label="Context" action={action}>
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Source</span>
        <Badge variant="secondary" size="sm" className="rounded-md font-mono normal-case tracking-normal">
          .kortix/CONTEXT.md
        </Badge>
      </div>

      {contextLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border bg-card py-12 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-sm">Loading CONTEXT.md…</span>
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
            'min-h-60 w-full resize-none overflow-hidden rounded-2xl border bg-card p-5',
            'font-mono text-sm leading-relaxed text-foreground/85 outline-none',
            'placeholder:text-muted-foreground/40',
            'focus:border-foreground/30 focus:ring-2 focus:ring-ring/30',
            'transition-colors',
          )}
          placeholder="# Project Context\n\nMission, architecture, key decisions, open questions — the durable project memory every agent reads first."
        />
      ) : contextError || !contextContent ? (
        <button
          onClick={startEditing}
          className="group w-full rounded-2xl border border-dashed bg-card/40 p-10 text-center transition-colors hover:border-foreground/40 hover:bg-muted/30"
        >
          <AlertCircle className="mx-auto mb-3 size-5 text-muted-foreground/30 transition-colors group-hover:text-foreground/60" />
          <p className="mb-1 text-sm font-medium text-foreground">No CONTEXT.md yet</p>
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
            Click to create{' '}
            <Badge variant="secondary" size="sm" className="rounded-md font-mono normal-case tracking-normal">
              .kortix/CONTEXT.md
            </Badge>{' '}
            — the durable project memory every agent reads first.
          </p>
        </button>
      ) : (
        <div className="rounded-2xl border bg-card px-5 py-5 sm:px-6">
          <article className="prose prose-sm max-w-none dark:prose-invert">
            <UnifiedMarkdown content={contextContent} />
          </article>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
        <DetailRow
          icon={<FolderGit2 className="size-3.5 text-muted-foreground/60" />}
          label="Path"
          value={
            <button
              onClick={copyPath}
              className="inline-flex max-w-full min-w-0 items-center gap-1.5 truncate font-mono text-xs text-foreground/80 transition-colors hover:text-foreground"
              title="Copy path"
            >
              <span className="truncate">{project?.path || '—'}</span>
              {pathCopied ? (
                <Check className="size-3 shrink-0 text-emerald-500" />
              ) : (
                <Copy className="size-3 shrink-0 text-muted-foreground/40" />
              )}
            </button>
          }
        />
        <DetailRow
          icon={<Calendar className="size-3.5 text-muted-foreground/60" />}
          label="Created"
          value={
            <span
              className="text-xs tabular-nums text-foreground/80"
              title={fullDate(project?.created_at)}
            >
              {relativeTime(project?.created_at)}
            </span>
          }
        />
      </div>
    </Section>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 bg-card px-4 py-3">
      <span className="shrink-0">{icon}</span>
      <span className="w-16 shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-end text-right">
        {value}
      </div>
    </div>
  );
}
