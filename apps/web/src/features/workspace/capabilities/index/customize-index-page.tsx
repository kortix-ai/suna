'use client';

import {
  AlarmIcon as AlarmClock,
  SquaresFourIcon as Blocks,
  RobotIcon as Bot,
  CubeIcon as Boxes,
  KeyIcon as KeyRound,
  LockKeyIcon as Lock,
  PlugIcon as Plug,
  GearSixIcon as Settings,
  type Icon,
} from '@phosphor-icons/react';
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

/**
 * The page body for `/projects/[id]/customize` when opened bare (no
 * `?section=`) — the Customize bar's INDEX. Clicking the sidebar's Customize
 * row used to jump straight into whichever tab the caller could read first
 * (Connectors, usually), which meant most people never saw the other seven
 * tabs unless they went looking. This page is the landing spot instead: one
 * card per top-level tab, so the whole surface introduces itself before a
 * person picks a corner of it.
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

export function CustomizeIndexPage({ projectId }: { projectId: string }) {
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-10 pb-20 lg:py-14">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Customize</h1>
          <p className="text-muted-foreground text-sm">
            Every way to configure this project, in one place.
          </p>
        </div>

        {loading && cards.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
              <Skeleton key={i} className="h-24 rounded-md" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          // Reached by URL only — every entry point into Customize is gated on
          // the same leaf. Say so plainly instead of rendering a heading over
          // an empty grid.
          <EmptyState
            icon={Lock}
            size="sm"
            title="You don't have access to this project's configuration"
            description="Ask a project manager if you need to change how this project is set up."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cards.map(({ tab, icon: CardIcon, description }) => (
              <Link
                key={tab.key}
                href={capabilityTabHref(projectId, tab.key)}
                className="group hover:border-foreground/20 hover:bg-accent/50 flex items-start gap-3 rounded-md border p-4 transition-colors"
              >
                <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
                  <CardIcon className="text-foreground size-5 shrink-0" />
                </span>
                <span className="min-w-0 space-y-0.5">
                  <span className="text-foreground block text-sm font-medium">{tab.label}</span>
                  <span className="text-muted-foreground block text-xs leading-relaxed text-pretty">
                    {description}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
