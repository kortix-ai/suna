'use client';

import {
  AlarmIcon as AlarmClock,
  ArrowRightIcon,
  SquaresFourIcon as Blocks,
  RobotIcon as Bot,
  CubeIcon as Boxes,
  KeyIcon as KeyRound,
  LockKeyIcon as Lock,
  PlugIcon as Plug,
  GearSixIcon as Settings,
  type Icon,
} from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import Link from 'next/link';

import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  CAPABILITY_TABS,
  capabilityTabHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  CAPABILITY_TAB_GATE_ACTIONS,
  visibleCapabilityTabs,
} from '@/features/workspace/capabilities/shared/capability-tabs';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

/**
 * The page body for `/projects/[id]/customize` when opened bare (no
 * `?section=`) — the Customize bar's INDEX. Clicking the sidebar's Customize
 * row used to jump straight into whichever tab the caller could read first
 * (Connectors, usually), which meant most people never saw the other seven
 * tabs unless they went looking. This page is the landing spot instead.
 *
 * ## It is a chooser, so it is built like one
 *
 * It was a 2-up grid of small cards. Seven cards in two ragged columns read as
 * a dashboard — you scan them like status tiles rather than picking one — and
 * the last row always left a hole where the eighth card would be. A chooser
 * wants ONE column, one decision per line, in a fixed reading order.
 *
 * So: full-width bands, hairline-separated, borrowed straight from the
 * marketing site's own vocabulary (`features/marketing/how-it-work/`) — the
 * numbered stack a reader descends. Each band is one target, `py-5`, the whole
 * row clickable, with the number and the arrow doing the work a card's border
 * used to do.
 *
 *  - **The number** (`01`…`07`) is mono and tabular. It gives the set a spine
 *    and tells you how many decisions there are before you start reading them.
 *  - **The arrow** slides in from -4px on hover and focus. It is the only
 *    moving part, so "this row is the one" is unambiguous.
 *  - **The tile** tints to `bg-primary/[0.08]` — the system's selection fill,
 *    not `bg-muted`, which reads as disabled.
 *  - **Focus** is a real `focus-visible` ring on the row, so the whole page is
 *    keyboard-selectable in one `Tab` sweep.
 *
 * The header sits over the hero's dot grid, masked to fade before it reaches
 * the first band — the one piece of marketing chrome this page borrows, and it
 * is `pointer-events-none` and `aria-hidden`, so it costs the chooser nothing.
 *
 * Card copy is local to this file on purpose — `CapabilityTab` deliberately
 * carries no icon or description field (see `capability-tab-routes.ts`'s
 * header comment: "an icon that nothing draws is a field that goes stale
 * unnoticed"). That rule holds for the tab BAR. This page is the one place
 * that actually draws one, so it is the one place that owns the icon.
 */
const CARD_COPY: Record<CapabilityTab['key'], { icon: Icon; description: string }> = {
  // Names both directions, because both live behind this one card now: the
  // outbound catalogue and the Channels scope that used to be its own tab.
  // A card that said only "give agents access to outside tools" would leave
  // someone hunting for Slack with nothing on this page to click.
  connectors: {
    icon: Plug,
    description: 'Give agents access to outside tools — and reach them from Slack, Teams or email.',
  },
  agent: {
    icon: Bot,
    description: "Who does the work — each one's instructions, model, and access.",
  },
  skills: {
    icon: Blocks,
    description: 'Repeatable workflows your agent reuses.',
  },
  triggers: {
    icon: AlarmClock,
    description: 'Run an agent automatically — on a schedule, or when another app sends a signal.',
  },
  models: {
    icon: Boxes,
    description: 'Which providers and models this project can use.',
  },
  secrets: {
    icon: KeyRound,
    description: 'Store encrypted values and control where each value can be used.',
  },
  config: {
    icon: Settings,
    description: 'General project settings, sandbox templates, feature flags, and upgrades.',
  },
};

/**
 * The hero's dot grid, masked so it dissolves before the first band. Tokenised
 * (`--color-border`), so it follows the theme in both directions instead of
 * needing a `dark:` twin.
 */
function DotGrid() {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 h-56 select-none opacity-70',
        '[background-image:radial-gradient(circle_at_center,var(--color-border)_1px,transparent_1px)]',
        '[background-size:22px_22px]',
        '[mask-image:radial-gradient(ellipse_75%_100%_at_50%_0%,#000_0%,transparent_72%)]',
      )}
    />
  );
}

export function CustomizeIndexPage({ projectId }: { projectId: string }) {
  const prefersReducedMotion = useReducedMotion();

  // The SAME probe list and the SAME rule the tab bar applies
  // (`capabilities/shared/capability-tabs.tsx`) — this page is that bar's
  // index, so a card here and a tab there must never disagree about who may
  // open a capability. In particular `project.customize.read` gates the whole
  // surface: without it a plain project member would still see cards for the
  // three leaves they DO hold (Models, Agents, Triggers) on a page they cannot
  // use, reachable by URL.
  const caps = useProjectCans(projectId, CAPABILITY_TAB_GATE_ACTIONS);
  const visible = visibleCapabilityTabs(caps);

  const cards = CAPABILITY_TABS.filter((tab) => visible.includes(tab)).map((tab) => ({
    tab,
    ...CARD_COPY[tab.key],
  }));

  const loading = CAPABILITY_TAB_GATE_ACTIONS.some((a) => caps[a]?.isLoading);

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <DotGrid />
      <div className="relative mx-auto w-full max-w-3xl px-4 py-14 pb-24 lg:py-20">
        <header className="space-y-2">
          <h1 className="text-foreground text-3xl font-medium tracking-tight text-balance">
            Customize
          </h1>
          {/* The marketing site's own sentence shape: the claim in
              `text-foreground`, the qualifier that follows it muted, one line. */}
          <p className="text-muted-foreground max-w-md text-sm text-pretty">
            <span className="text-foreground">Every way to configure this project.</span> Pick where
            you want to start.
          </p>
        </header>

        <div className="mt-10">
          {loading && cards.length === 0 ? (
            <div className="border-border/60 divide-border/60 divide-y border-y">
              {Array.from({ length: 6 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
                <div key={i} className="flex items-center gap-4 py-5">
                  <Skeleton className="size-9 shrink-0 rounded-sm" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-28 rounded-sm" />
                    <Skeleton className="h-3 w-64 rounded-sm" />
                  </div>
                </div>
              ))}
            </div>
          ) : cards.length === 0 ? (
            // Reached by URL only — every entry point into Customize is gated
            // on the same leaf. Say so plainly instead of rendering a heading
            // over an empty grid.
            <EmptyState
              icon={Lock}
              size="sm"
              title="You don't have access to this project's configuration"
              description="Ask a project manager if you need to change how this project is set up."
            />
          ) : (
            <nav aria-label="Customize" className="border-border/60 border-y">
              {cards.map(({ tab, icon: CardIcon, description }, i) => (
                <m.div
                  key={tab.key}
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  /* 45ms, not the polish skill's ~100ms: seven rows at 100ms
                     is a 700ms wait before the last option exists. At 45 the
                     set lands as one sweep and every row is pickable in under
                     half a second. */
                  transition={{
                    duration: 0.28,
                    delay: prefersReducedMotion ? 0 : i * 0.045,
                    ease: [0.23, 1, 0.32, 1],
                  }}
                  className={cn(i > 0 && 'border-border/60 border-t')}
                >
                  <Link
                    href={capabilityTabHref(projectId, tab.key)}
                    className={cn(
                      'group focus-visible:ring-kortix-blue relative flex items-center gap-4 py-5',
                      'transition-colors duration-150 outline-none',
                      // Negative inset + matching padding: the hover fill runs
                      // wider than the text column so a band reads as one
                      // target, while the text stays on the page's grid.
                      '-mx-3 rounded-md px-3',
                      'hover:bg-primary/[0.04] focus-visible:ring-[1.5px]',
                    )}
                  >
                    <span
                      aria-hidden
                      className="text-muted-foreground/50 group-hover:text-muted-foreground w-6 shrink-0 font-mono text-xs tabular-nums transition-colors"
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>

                    <span className="bg-muted group-hover:bg-primary/[0.08] flex size-9 shrink-0 items-center justify-center rounded-sm transition-colors">
                      <CardIcon className="text-foreground size-5 shrink-0" />
                    </span>

                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="text-foreground block text-sm font-medium">{tab.label}</span>
                      <span className="text-muted-foreground block text-xs leading-relaxed text-pretty">
                        {description}
                      </span>
                    </span>

                    {/* The one moving part. `-translate-x-1` → `0` on hover and
                        on keyboard focus, so the pointer and the Tab key get
                        the same answer to "which row is selected". */}
                    <ArrowRightIcon
                      aria-hidden
                      className={cn(
                        'text-muted-foreground size-4 shrink-0 -translate-x-1 opacity-0',
                        'transition-[opacity,translate] duration-200',
                        'group-hover:translate-x-0 group-hover:opacity-100',
                        'group-focus-visible:translate-x-0 group-focus-visible:opacity-100',
                      )}
                    />
                  </Link>
                </m.div>
              ))}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
