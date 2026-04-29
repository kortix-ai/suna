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
  useUserHandle,
  type ProjectAgent,
} from '@/hooks/kortix/use-kortix-tickets';
import { useMilestones } from '@/hooks/kortix/use-milestones';
import { useKortixProjectSessions } from '@/hooks/kortix/use-kortix-projects';
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
}: ProjectAboutProps) {
  const projectId = project?.id;

  const { data: tickets = [] } = useTickets(projectId, { pollingEnabled: false });
  const { data: milestones = [] } = useMilestones(projectId, 'all');
  const { data: agents = [] } = useProjectAgents(projectId);
  const { data: sessions = [] } = useKortixProjectSessions(projectId);
  const userHandle = useUserHandle();

  const openTickets = useMemo(
    () => tickets.filter((t) => !TERMINAL_STATUSES.has(t.status)),
    [tickets],
  );
  const openMilestones = useMemo(
    () => milestones.filter((m) => m.status === 'open').length,
    [milestones],
  );

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

      <div className="flex items-center gap-2">
        <span className="hidden h-4 w-px bg-border sm:block" />

        <div className="flex items-center -space-x-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex rounded-full ring-2 ring-background">
                <UserAvatar handle={userHandle} avatarUrl={null} size="sm" />
              </span>
            </TooltipTrigger>
            <TooltipContent>@{userHandle}</TooltipContent>
          </Tooltip>
          {agents.map((agent) => (
            <Tooltip key={agent.id}>
              <TooltipTrigger asChild>
                <span className="inline-flex rounded-full ring-2 ring-background">
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
    </div>
  );
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: typeof CircleDot;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground/60" />
      <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </h2>
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
