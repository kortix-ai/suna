'use client';

/**
 * ProjectHome — the project's dashboard / landing surface.
 *
 * Laid out as the empty state of a session: the same full-bleed wallpaper the
 * session shows before its first message, the page content centered in the
 * middle, and a composer pinned at the bottom matching the session chat input.
 *
 *   • full-bleed `SessionWelcome` wallpaper for the shared empty-state look,
 *   • a hero with the project's identity,
 *   • a compact grid of section tiles (integrations, schedules, skills, Slack,
 *     team, agent) that double as a teaser and a setup prompt, and
 *   • a bottom-pinned composer with quick-start prompts sitting over it.
 *
 * Counts come from the same cached queries the rest of the project uses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUp,
  Bot,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Container,
  FileCode,
  Loader2,
  MessageSquare,
  Package,
  Plug,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SessionWelcome } from '@/components/session/session-welcome';
import type { CustomizeSection } from '@/lib/customize-sections';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listSandboxTemplates,
  listProjectTriggers,
  type SandboxTemplate,
} from '@/lib/projects-client';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useCustomizeStore } from '@/stores/customize-store';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export interface ProjectHomeSendOptions {
  /** Slug of the sandbox template the new session should boot from. */
  sandbox_slug?: string;
}

export function ProjectHome({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (text: string, options?: ProjectHomeSendOptions) => void;
  busy: boolean;
}) {
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const name = detail.data?.project?.name ?? '';

  const [text, setText] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sandbox templates available for this project. The platform default is
  // always returned; `[[sandbox.templates]]` entries from kortix.toml append to it.
  // We only show a picker when there's a choice (more than one template).
  const sandboxesQuery = useQuery({
    queryKey: ['project-sandboxes', projectId],
    queryFn: () => listSandboxTemplates(projectId),
    ...Q,
  });
  const sandboxItems: SandboxTemplate[] = sandboxesQuery.data?.items ?? [];
  const defaultSlug = sandboxesQuery.data?.default_slug ?? 'default';
  const activeSlug = selectedSlug ?? defaultSlug;
  // Always show the picker (even with only the platform default) so the user
  // can confirm which template they're booting from and see its state. Hide
  // only while the list is still loading.
  const showSandboxPicker = sandboxItems.length >= 1;
  // Reactive subscription scoped to THIS project — fires whether the prefill
  // was set before mount or arrives later (e.g. wizard hands one off while
  // we're already on the page).
  const pendingPrefill = useComposerPrefillStore(
    (s) => s.prefillByProject[projectId],
  );
  const consumePrefill = useComposerPrefillStore((s) => s.consume);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [text, resize]);

  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    setText(pendingPrefill);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const len = pendingPrefill.length;
      textareaRef.current?.setSelectionRange(len, len);
    });
  }, [pendingPrefill, projectId, consumePrefill]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t, { sandbox_slug: activeSlug });
  };

  const applySuggestion = (s: string) => {
    setText(s);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      resize();
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Full-bleed empty-state wallpaper — the exact backdrop a session shows
          before its first message. The content and composer read over it. */}
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <SessionWelcome />
      </div>

      {/* Middle — hero + the "Build out your project" grid, centered in the
          space above the pinned composer. On a normal desktop it fits without
          scrolling; the overflow-safe `min-h-full` + `m-auto` pattern only
          scrolls when the window is genuinely too short (e.g. mobile), never
          clipping the top. */}
      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 py-8">
          {/* m-auto vertically centers the hero + grid as one block. */}
          <div className="m-auto w-full">
            {/* Hero */}
            <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
              <EntityAvatar label={name || 'Project'} size="xl" className="shadow-sm" />
              <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {name || 'Your project'}
              </h1>
            </div>

            {/* Build out your project */}
            <ProjectHomeSections projectId={projectId} />
          </div>
        </div>
      </div>

      {/* Bottom dock — quick-start prompts sitting directly over the composer,
          which is pinned to the page bottom and matches the session chat input
          (same width, surface, radius, textarea metrics, and toolbar). */}
      <div className="relative z-10 shrink-0">
        <div className="mx-auto w-full max-w-[52rem] px-2 pb-6 sm:px-4">
          {/* Quick-start suggestions — paged carousel of the shared starter
              prompts; picking one fills the composer below. */}
          <StarterPromptsCarousel onPick={applySuggestion} />

          <div
            className={cn(
              'mt-2.5 w-full overflow-visible rounded-[24px] border border-border bg-card transition-colors',
              'focus-within:border-foreground/20',
            )}
          >
            <div className="flex flex-col gap-2">
              <div className="px-3.5">
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
                  className="relative max-h-[200px] min-h-[72px] w-full resize-none overflow-y-auto border-none bg-transparent px-0.5 pb-6 pt-4 text-base leading-relaxed outline-none placeholder:text-muted-foreground sm:text-sm"
                />
              </div>

              {/* Bottom toolbar — mirrors the session input's layout: controls
                  left, send right. */}
              <div className="mb-1.5 flex items-center justify-between gap-1 pl-2 pr-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  {showSandboxPicker ? (
                    <SandboxPicker
                      items={sandboxItems}
                      activeSlug={activeSlug}
                      onSelect={setSelectedSlug}
                    />
                  ) : null}
                </div>
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={busy || !text.trim()}
                  aria-label="Start session"
                  className="h-8 w-8 shrink-0 rounded-full p-0"
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
        </div>
      </div>
    </div>
  );
}

function StarterPromptsCarousel({ onPick }: { onPick: (text: string) => void }) {
  // Native horizontal scroll on the chip strip — works with trackpad
  // swipes, touch flicks, and the chevron buttons. The chevrons call
  // scrollBy({ behavior: 'smooth' }) so the user sees a glide whether
  // they click an arrow or trackpad-swipe directly on the row. Edge
  // mask gradients fade chips in/out at the borders so partially-
  // visible chips look intentional rather than clipped.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Arrow enabled-state is driven by actual scrollLeft, not a page
  // counter — anything else (counting chip widths, paginating) goes
  // out of sync as soon as the viewport resizes mid-session.
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      // 4px slack so a sub-pixel scrollLeft (Chrome rounds inconsistently
      // after a smooth scroll) doesn't keep an arrow falsely enabled.
      setAtStart(el.scrollLeft <= 4);
      setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 4);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  const scrollByPage = (direction: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    // 70% of viewport: nudges enough that new chips clearly appear, but
    // leaves one chip in common with the previous frame as a visual
    // anchor — feels less jarring than a full-viewport jump.
    el.scrollBy({ left: direction * el.clientWidth * 0.7, behavior: 'smooth' });
  };

  return (
    <div className="mt-3 flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous suggestions"
        disabled={atStart}
        onClick={() => scrollByPage(-1)}
        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <div
        ref={scrollRef}
        className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto"
        // Edge fade so the row visually "continues" past the chevrons
        // instead of clipping at a hard border. 6% is enough to soften
        // without eating real chip pixels.
        style={{
          WebkitMaskImage:
            'linear-gradient(to right, transparent, black 6%, black 94%, transparent)',
          maskImage:
            'linear-gradient(to right, transparent, black 6%, black 94%, transparent)',
        }}
      >
        {STARTER_PROMPTS.map((p) => {
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.prompt)}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:border-foreground/20 hover:bg-card hover:text-foreground"
            >
              <Icon className="size-3.5" />
              {p.label}
            </button>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="More suggestions"
        disabled={atEnd}
        onClick={() => scrollByPage(1)}
        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
      >
        <ChevronRight className="size-3.5" />
      </Button>
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
  /** Customize section this tile opens. */
  section: CustomizeSection;
  docs: string;
}

function SandboxPicker({
  items,
  activeSlug,
  onSelect,
}: {
  items: SandboxTemplate[];
  activeSlug: string;
  onSelect: (slug: string) => void;
}) {
  const active = items.find((t) => t.slug === activeSlug) ?? items[0] ?? null;
  if (!active) return null;
  const ActiveIcon = active.is_default ? Container : active.has_image ? Package : FileCode;
  const activeStateTone =
    active.daytona_state === 'active'
      ? 'bg-emerald-500'
      : ['pulling', 'building'].includes(active.daytona_state)
        ? 'bg-blue-500'
        : active.daytona_state === 'missing'
          ? 'bg-muted-foreground/40'
          : 'bg-destructive';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Sandbox template"
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
        >
          <ActiveIcon className="size-3.5" />
          <span className="max-w-[10rem] truncate">{active.name}</span>
          <span className={cn('size-1.5 rounded-full', activeStateTone)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Sandbox template</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((tpl) => {
          const Icon = tpl.is_default ? Container : tpl.has_image ? Package : FileCode;
          const subtitle = tpl.is_default
            ? 'Platform default · clones workspace at boot'
            : tpl.has_image
              ? `Image: ${tpl.image}`
              : `Dockerfile: ${tpl.dockerfile_path}`;
          const stateTone =
            tpl.daytona_state === 'active'
              ? 'text-emerald-600 dark:text-emerald-400'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'text-blue-600 dark:text-blue-400'
                : tpl.daytona_state === 'missing'
                  ? 'text-muted-foreground'
                  : 'text-destructive';
          const stateLabel =
            tpl.daytona_state === 'active'
              ? 'Ready'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'Building — session will wait'
                : tpl.daytona_state === 'missing'
                  ? 'Not built — first session will build it'
                  : tpl.daytona_state.replace('_', ' ');
          return (
            <DropdownMenuItem
              key={tpl.template_id ?? `tpl-${tpl.slug}`}
              className="flex items-start gap-2 py-2"
              onSelect={() => onSelect(tpl.slug)}
            >
              <Icon className="mt-0.5 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  {tpl.slug === activeSlug && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">selected</Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
                <div className={cn('mt-0.5 text-[11px] capitalize', stateTone)}>
                  {stateLabel}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
    <div className="mx-auto mt-9 w-full max-w-3xl">
      <h2 className="mb-2.5 px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Build out your project
      </h2>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
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
  const { icon: Icon, title, desc, count, section } = tile;
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
        'group relative flex cursor-pointer items-center gap-3 rounded-2xl border border-border/60 bg-card/70 p-3 text-left backdrop-blur-sm',
        'transition-all duration-150 hover:border-foreground/25 hover:bg-card',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70 transition-colors group-hover:text-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{desc}</div>
      </div>
      {isSet ? (
        <Badge size="sm" variant="secondary" className="shrink-0 tabular-nums">
          {count}
        </Badge>
      ) : (
        <ArrowRight className="size-4 shrink-0 text-muted-foreground/30 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground/60" />
      )}
    </div>
  );
}
