'use client';

/**
 * ProjectHome — the project's dashboard / landing surface.
 *
 * A calm, on-brand home that communicates the one important thing first —
 * "describe a task, your agent works" — and then how to build the project out:
 *   • the standard Kortix brandmark wallpaper, fading into the page, for
 *     ambient brand presence,
 *   • a hero with the project's identity + a premium composer (matching the
 *     signature look of the session chat input) to start a session, with
 *     quick-start suggestions, and
 *   • a grid of section tiles (integrations, schedules, skills, Slack, team,
 *     agent) that double as a teaser and a setup prompt, each docs-backed.
 *
 * Counts come from the same cached queries the rest of the project uses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import type { CustomizeSection } from '@/lib/customize-sections';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectTriggers,
} from '@/lib/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

const SUGGESTIONS = [
  'Give me an overview of this project',
  'What can you help me with?',
  'Summarize what changed recently',
];

export function ProjectHome({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (text: string) => void;
  busy: boolean;
}) {
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const name = detail.data?.project?.name ?? '';

  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [text, resize]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
  };

  const applySuggestion = (s: string) => {
    setText(s);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      resize();
    });
  };

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
      {/* Standard Kortix brandmark wallpaper — ambient brand presence behind the
          hero, masked so it fades out before the setup grid below. */}
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <div className="absolute inset-0 opacity-60 dark:opacity-50 [-webkit-mask-image:linear-gradient(to_bottom,black,black_28%,transparent_68%)] [mask-image:linear-gradient(to_bottom,black,black_28%,transparent_68%)]">
          <WallpaperBackground wallpaperId="brandmark" />
        </div>
      </div>

      <div className="relative z-10 h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 pb-24 pt-20 sm:pt-28">
          {/* Hero */}
          <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
            <EntityAvatar label={name || 'Project'} size="xl" className="shadow-sm" />
            <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {name || 'Your project'}
            </h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Describe a task and your agent gets to work — or set things up below.
            </p>
          </div>

          {/* Composer — mirrors the session chat input's signature card */}
          <div className="mx-auto mt-8 w-full max-w-2xl">
            <div
              className={cn(
                'group relative w-full rounded-[24px] border border-border bg-card transition-all duration-200',
                'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_18px_40px_-24px_rgba(0,0,0,0.18)]',
                'focus-within:border-foreground/20 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.05),0_24px_56px_-28px_rgba(0,0,0,0.28)]',
              )}
            >
              <div className="flex flex-col px-3.5">
                <textarea
                  ref={textareaRef}
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
                  rows={1}
                  className="relative max-h-[220px] min-h-[64px] w-full resize-none overflow-y-auto border-none bg-transparent px-0.5 pb-2 pt-4 text-base leading-relaxed outline-none placeholder:text-muted-foreground/60 sm:text-[15px]"
                />
                <div className="mb-2 flex items-center justify-between gap-2 pl-1">
                  <span className="hidden items-center gap-1.5 text-xs text-muted-foreground/60 sm:flex">
                    <Kbd>Enter</Kbd>
                    <span>to start</span>
                    <span className="text-muted-foreground/30">·</span>
                    <Kbd>Shift</Kbd>
                    <Kbd>Enter</Kbd>
                    <span>for a new line</span>
                  </span>
                  <Button
                    size="sm"
                    onClick={submit}
                    disabled={busy || !text.trim()}
                    aria-label="Start session"
                    className="ml-auto size-8 shrink-0 rounded-full p-0"
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowUp className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            {/* Quick-start suggestions */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => applySuggestion(s)}
                  className="rounded-full border border-border/60 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:border-foreground/20 hover:bg-card hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Sections */}
          <ProjectHomeSections projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1.5 font-sans text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
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
  /** Customize section this tile opens. */
  section: CustomizeSection;
  docs: string;
}

function ProjectHomeSections({ projectId }: { projectId: string }) {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
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

  const memberCount = access.data?.members.length ?? 0;

  const tiles: Tile[] = [
    {
      icon: Plug,
      title: 'Integrations',
      desc: 'Connect tools your agent can act in.',
      count: connectors.data?.connectors.length ?? 0,
      setupCta: 'Connect a tool',
      section: 'connectors',
      docs: '/docs/concepts/connections',
    },
    {
      icon: CalendarClock,
      title: 'Scheduled tasks',
      desc: 'Run work on a schedule or from an event.',
      count: triggers.data?.triggers.length ?? 0,
      setupCta: 'Add an automation',
      section: 'schedules',
      docs: '/docs/concepts/triggers',
    },
    {
      icon: Sparkles,
      title: 'Skills',
      desc: 'Repeatable workflows your agent reuses.',
      count: detail.data?.config?.skills.length ?? 0,
      setupCta: 'Create a skill',
      section: 'skills',
      docs: '/docs/concepts/agents',
    },
    {
      icon: MessageSquare,
      title: 'Slack',
      desc: 'Run this project right from chat.',
      count: null,
      setupCta: 'Connect Slack',
      section: 'channels',
      docs: '/docs/concepts/channels',
    },
    {
      icon: Users,
      title: 'Your team',
      desc: 'Invite people to run and review work.',
      count: memberCount > 1 ? memberCount : 0,
      setupCta: 'Invite your team',
      section: 'members',
      docs: '/docs/concepts/accounts',
    },
    {
      icon: Bot,
      title: 'Agent',
      desc: 'Shape how your agent thinks and acts.',
      count: null,
      setupCta: 'Configure',
      section: 'agents',
      docs: '/docs/concepts/agents',
    },
  ];

  return (
    <div className="mt-16">
      <h2 className="mb-3 px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Build out your project
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <SectionTile key={t.title} tile={t} onOpen={openCustomize} />
        ))}
      </div>
    </div>
  );
}

function SectionTile({
  tile,
  onOpen,
}: {
  tile: Tile;
  onOpen: (section: CustomizeSection) => void;
}) {
  const { icon: Icon, title, desc, count, setupCta, section, docs } = tile;
  const isSet = (count ?? 0) > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(section)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(section);
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col rounded-2xl border border-border/60 bg-card/70 p-4 text-left backdrop-blur-sm',
        'transition-all duration-150 hover:border-foreground/25 hover:bg-card',
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
