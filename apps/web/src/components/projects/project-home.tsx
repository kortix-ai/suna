'use client';

/**
 * ProjectHome — the project's dashboard / landing surface.
 *
 * Replaces the old setup-checklist overlay with a calm, on-brand home:
 *   • a hero ("Welcome to <project>") with a composer to start a session, and
 *   • a grid of section tiles (integrations, schedules, skills, Slack, team, …)
 *     that double as a teaser and a setup prompt, each docs-backed.
 *
 * Counts come from the same cached queries the rest of the project uses.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
  CalendarClock,
  Loader2,
  MessageSquare,
  Plug,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectTriggers,
} from '@/lib/projects-client';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function ProjectHome({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (text: string) => void;
  busy: boolean;
}) {
  const router = useRouter();
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const name = detail.data?.project?.name ?? '';

  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl px-6 py-16 sm:py-20">
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <KortixLogo size={36} />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Welcome to {name || 'your project'}
          </h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Describe a task and your agent gets to work — or set things up below.
          </p>
        </div>

        {/* Composer */}
        <div className="mx-auto mt-8 max-w-2xl">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Describe a task to start a session…"
            autoFocus
            rows={3}
            className="resize-none text-base"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground/70">
              Enter to start · Shift + Enter for a new line
            </span>
            <Button size="sm" className="gap-1.5" onClick={submit} disabled={busy || !text.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              Start session
            </Button>
          </div>
        </div>

        {/* Sections */}
        <ProjectHomeSections projectId={projectId} onNavigate={(href) => router.push(href)} />
      </div>
    </div>
  );
}

interface Tile {
  icon: LucideIcon;
  title: string;
  desc: string;
  /** Count when set up; null = no count (pure teaser). */
  count: number | null;
  /** Label when nothing is set up yet. */
  setupCta: string;
  href: string;
  docs: string;
}

function ProjectHomeSections({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (href: string) => void;
}) {
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const connectors = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    ...Q,
  });
  const triggers = useQuery({
    queryKey: ['project-triggers', projectId],
    queryFn: () => listProjectTriggers(projectId),
    ...Q,
  });
  const access = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    ...Q,
  });

  const base = (p: string) => `/projects/${projectId}/${p}`;
  const memberCount = access.data?.members.length ?? 0;

  const tiles: Tile[] = [
    {
      icon: Plug,
      title: 'Integrations',
      desc: 'Connect tools your agent can act in.',
      count: connectors.data?.connectors.length ?? 0,
      setupCta: 'Connect a tool',
      href: base('connectors'),
      docs: '/docs/concepts/connections',
    },
    {
      icon: CalendarClock,
      title: 'Scheduled tasks',
      desc: 'Run work on a schedule or from an event.',
      count: triggers.data?.triggers.length ?? 0,
      setupCta: 'Add an automation',
      href: base('schedules'),
      docs: '/docs/concepts/triggers',
    },
    {
      icon: Sparkles,
      title: 'Skills',
      desc: 'Repeatable workflows your agent reuses.',
      count: detail.data?.config?.skills.length ?? 0,
      setupCta: 'Create a skill',
      href: base('skills'),
      docs: '/docs/concepts/agents',
    },
    {
      icon: MessageSquare,
      title: 'Slack',
      desc: 'Run this project right from chat.',
      count: null,
      setupCta: 'Connect Slack',
      href: base('channels'),
      docs: '/docs/concepts/channels',
    },
    {
      icon: Users,
      title: 'Your team',
      desc: 'Invite people to run and review work.',
      count: memberCount > 1 ? memberCount : 0,
      setupCta: 'Invite your team',
      href: base('members'),
      docs: '/docs/concepts/accounts',
    },
    {
      icon: Bot,
      title: 'Agent',
      desc: 'Shape how your agent thinks and acts.',
      count: null,
      setupCta: 'Configure',
      href: base('agents'),
      docs: '/docs/concepts/agents',
    },
  ];

  return (
    <div className="mt-12">
      <h2 className="mb-3 px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Build out your project
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <SectionTile key={t.title} tile={t} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

function SectionTile({ tile, onNavigate }: { tile: Tile; onNavigate: (href: string) => void }) {
  const { icon: Icon, title, desc, count, setupCta, href, docs } = tile;
  const isSet = (count ?? 0) > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(href)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onNavigate(href);
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col rounded-2xl border border-border/60 bg-card p-4 text-left',
        'transition-all duration-150 hover:border-foreground/25 hover:bg-muted/20',
        'hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground/70 transition-colors group-hover:text-foreground">
          <Icon className="size-4" />
        </span>
        {isSet ? (
          <Badge size="sm" variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        ) : (
          <ArrowRight className="size-4 text-muted-foreground/30 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground/60" />
        )}
      </div>

      <div className="mt-3 text-sm font-medium text-foreground">{title}</div>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</p>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs font-medium text-primary">{isSet ? 'Manage' : setupCta}</span>
        <a
          href={docs}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Learn about ${title}`}
          className="text-muted-foreground/40 transition-colors hover:text-foreground"
        >
          <BookOpen className="size-3.5" />
        </a>
      </div>
    </div>
  );
}
