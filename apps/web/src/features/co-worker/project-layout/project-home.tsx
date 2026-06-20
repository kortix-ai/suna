'use client';

import { Icon as IconMynauiType, SparklesSolid, UsersGroupSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Container,
  FileCode,
  Package,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IconType } from 'react-icons/lib';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { Icon } from '@/features/icon/icon';
import { SessionWelcome } from '@/features/session/session-welcome';
import type { CustomizeSection } from '@/lib/customize-sections';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectSandboxes,
  listProjectTriggers,
  type SandboxTemplate,
} from '@/lib/projects-client';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useCustomizeStore } from '@/stores/customize-store';
import { chalkColors } from '@kortix/shared';
import { HiOutlineViewGrid } from 'react-icons/hi';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export interface ProjectHomeSendOptions {
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
  const displayName = name.trim() || 'this project';

  const [text, setText] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sandboxesQuery = useQuery({
    queryKey: ['project-sandboxes', projectId],
    queryFn: () => listProjectSandboxes(projectId),
    ...Q,
  });
  const sandboxItems: SandboxTemplate[] = sandboxesQuery.data?.items ?? [];
  const defaultSlug = sandboxesQuery.data?.default_slug ?? 'default';
  const activeSlug = selectedSlug ?? defaultSlug;

  const showSandboxPicker = sandboxItems.length >= 1;

  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
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
    <div
      className={cn('bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5')}
    >
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <SessionWelcome />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto">
        <div className="flex w-full max-w-3xl items-center justify-start py-8 xl:py-8">
          <h1 className="text-muted-foreground text-left text-[2.3rem] leading-[1.2] tracking-tight text-balance max-sm:text-3xl">
            Give <span className="text-foreground">{displayName}</span> something real to work on.
          </h1>
        </div>

        <ProjectHomeSections projectId={projectId} />
      </div>

      <div className="relative z-10 shrink-0">
        <div className="mx-auto mb-4 w-full max-w-3xl space-y-4">
          <StarterPromptsCarousel onPick={applySuggestion} />

          <div className={cn('bg-card border-border w-full overflow-visible rounded-lg border')}>
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
                className="placeholder:text-muted-foreground relative max-h-[200px] min-h-[62px] w-full resize-none overflow-y-auto border-none bg-transparent py-3 text-base leading-relaxed outline-none sm:text-sm"
              />
            </div>

            <div className="flex items-center justify-between gap-2 p-3 pt-1">
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
                size="icon"
                onClick={submit}
                disabled={busy || !text.trim()}
                aria-label="Start session"
                className="rounded-full"
              >
                {busy ? (
                  <Loading />
                ) : (
                  <ArrowUp className="text-background size-4.5" strokeWidth={2.5} />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StarterPromptsCarousel({ onPick }: { onPick: (text: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const maxScroll = scrollWidth - clientWidth;
    const canScroll = maxScroll > 1;
    if (!canScroll) {
      setShowLeftFade(false);
      setShowRightFade(false);
      return;
    }
    setShowLeftFade(scrollLeft > 1);
    setShowRightFade(scrollLeft < maxScroll - 1);
  }, []);

  useLayoutEffect(() => {
    updateScrollFades();
  }, [updateScrollFades]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateScrollFades);
    ro.observe(el);
    el.addEventListener('scroll', updateScrollFades, { passive: true });
    window.addEventListener('resize', updateScrollFades);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateScrollFades);
      window.removeEventListener('resize', updateScrollFades);
    };
  }, [updateScrollFades]);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.75, 120);
    el.scrollBy({
      left: direction === 'left' ? -amount : amount,
      behavior: 'smooth',
    });
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <div
          className={cn(
            'from-background pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r to-transparent transition-opacity',
            showLeftFade ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden
        />
        <div
          className={cn(
            'from-background pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l to-transparent transition-opacity',
            showRightFade ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden
        />
        <div
          ref={scrollRef}
          className="[scrollbar-width:none] overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="inline-flex w-max justify-start gap-2">
            {STARTER_PROMPTS.map((p) => {
              const TabIcon = p.icon;
              const chalk = chalkColors(p.label);
              return (
                <Button
                  key={p.id}
                  value={p.id}
                  onClick={() => onPick(p.prompt)}
                  variant="secondary"
                  className="shrink-0 gap-1.5 text-sm"
                >
                  <TabIcon
                    className="size-4 shrink-0"
                    style={{ color: chalk.foreground }}
                    aria-hidden
                  />
                  {p.label}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
      {showLeftFade && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          disabled={!showLeftFade}
          aria-label="Scroll tabs left"
          onClick={() => scrollTabs('left')}
        >
          <ChevronLeft className="text-muted-foreground size-4" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        disabled={!showRightFade}
        aria-label="Scroll tabs right"
        onClick={() => scrollTabs('right')}
      >
        <ChevronRight className="text-muted-foreground size-4" />
      </Button>
    </div>
  );
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
        <Button type="button" aria-label="Sandbox template" variant="secondary" size="sm">
          <ActiveIcon className="size-3.5" />
          <span className="max-w-[10rem] truncate">{active.name}</span>
          <span className={cn('size-1.5 rounded-full', activeStateTone)} />
        </Button>
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
              className="flex items-start gap-2"
              onSelect={() => onSelect(tpl.slug)}
            >
              <Icon className="text-muted-foreground mt-0.5 size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  {tpl.slug === activeSlug && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      selected
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
                <div className={cn('mt-0.5 text-[11px] capitalize', stateTone)}>{stateLabel}</div>
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

  const tiles: {
    icon: LucideIcon | IconMynauiType | IconType;
    title: string;
    desc: string;
    count: number | null;
    setupCta: string;
    section: CustomizeSection;
    docs: string;
  }[] = [
    {
      icon: HiOutlineViewGrid,
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
      icon: SparklesSolid,
      title: 'Skills',
      desc: 'Repeatable workflows your agent reuses.',
      count: detail.data?.config?.skills.length ?? 0,
      setupCta: 'Create a skill',
      section: 'skills',
      docs: '/docs/concepts/agents',
    },
    {
      icon: Icon.Slack,
      title: 'Slack',
      desc: 'Run this project right from chat.',
      count: null,
      setupCta: 'Connect Slack',
      section: 'channels',
      docs: '/docs/concepts/channels',
    },
    {
      icon: UsersGroupSolid,
      title: 'Your team',
      desc: 'Invite people to run and review work.',
      count: memberCount > 1 ? memberCount : 0,
      setupCta: 'Invite your team',
      section: 'members',
      docs: '/docs/concepts/accounts',
    },
    {
      icon: Icon.Kortix,
      title: 'Agent',
      desc: 'Shape how your agent thinks and acts.',
      count: null,
      setupCta: 'Configure',
      section: 'agents',
      docs: '/docs/concepts/agents',
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col space-y-2">
      <label className="text-muted-foreground text-sm font-medium">Build out your project</label>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => {
          const { icon: Icon, title, desc, count, section } = tile;
          const isSet = (count ?? 0) > 0;

          return (
            <Button
              key={section}
              role="button"
              variant="secondary"
              tabIndex={0}
              onClick={() => openCustomize(section)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openCustomize(section);
                }
              }}
              className={cn(
                'bg-secondary/80 flex h-fit items-start justify-start overflow-hidden rounded-lg px-2.5 backdrop-blur-sm',
              )}
            >
              <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
                <Icon className="size-4.5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col items-start justify-start overflow-hidden">
                <div className="text-foreground truncate text-sm font-medium">{title}</div>
                <div className="text-muted-foreground truncate text-xs">{desc}</div>
              </div>
              {isSet ? (
                <Badge size="sm" variant="secondary" className="shrink-0 tabular-nums">
                  {count}
                </Badge>
              ) : null}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
