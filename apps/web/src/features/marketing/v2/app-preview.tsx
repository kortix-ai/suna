'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  AtSign,
  ChevronDown,
  ChevronsUpDown,
  Filter,
  Home,
  ListChecks,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Shuffle,
  Sliders,
  Sparkles,
  Users,
} from 'lucide-react';

/**
 * A still of the Kortix app, used as the hero's product shot. Deliberately
 * static — it is a screenshot, not a working surface. Token-driven so it
 * renders correctly in both themes.
 */

const NAV = [
  { name: 'Home', icon: Home, active: true },
  { name: 'Sessions', icon: MessageSquare },
  { name: 'Agents', icon: Sparkles },
  { name: 'Reviews', icon: ListChecks },
];

const VIEWS = [
  { name: 'My sessions', icon: Shuffle, tint: 'text-kortix-orange' },
  { name: 'Team activity', icon: Users, tint: 'text-kortix-green' },
  { name: 'Needs review', icon: Sparkles, tint: 'text-kortix-blue' },
  { name: 'Slack requests', icon: Search, tint: 'text-muted-foreground' },
];

const RECENT = [
  { title: 'Migrate the billing cron to the new scheduler', when: 'Just now', who: 'Theo' },
  { title: 'Fix the flaky onboarding e2e test', when: '1 min ago', who: 'Mira' },
  { title: 'Add retry logic to the webhook dispatcher', when: '2 min ago', who: 'Benja' },
  { title: 'Patch the rate-limit bug in the auth gateway', when: '3 min ago', who: 'Antoine' },
  { title: 'Review pull requests to identify bugs', when: '4 min ago', who: 'Sara' },
];

const AGENTS = [
  {
    name: 'Auto Fix Sentry Errors',
    description: 'Diagnoses new Sentry errors, finds the root cause, and opens a fix PR.',
    icons: [Icon.Github, Icon.Slack] as const,
  },
  {
    name: 'Enrich Linear Issue',
    description: 'Adds context and implementation suggestions to new Linear issues.',
    icons: [Icon.Linear, Icon.Github] as const,
  },
  {
    name: 'Daily Slack Changelog',
    description: 'Summarizes daily code changes and posts a formatted changelog to Slack.',
    icons: [Icon.Slack, Icon.Notion] as const,
  },
];

const SESSIONS = [
  'Review pull requests to identify bugs, security issues and code quality problems',
  'Generate a description whenever a new pull request is opened',
  'Draft the weekly customer digest from support threads',
];

function SidebarRow({
  name,
  icon: IconCmp,
  active,
  tint,
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  tint?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px]',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground',
      )}
    >
      <IconCmp className={cn('size-3.5 shrink-0', tint ?? 'text-muted-foreground')} />
      <span className="truncate">{name}</span>
    </div>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-baseline gap-2">
        <h3 className="text-foreground text-[15px] font-medium">{label}</h3>
        <span className="text-muted-foreground text-xs">{count}</span>
      </div>
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        All <ArrowRight className="size-3" />
      </span>
    </div>
  );
}

export function AppPreview() {
  return (
    <div className="bg-background flex h-full w-full min-w-[64rem] text-left">
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="border-border bg-sidebar flex w-[16rem] shrink-0 flex-col border-r p-3">
        <div className="mb-3 flex items-center gap-2 px-1.5">
          <span className="bg-foreground flex size-5 items-center justify-center rounded-sm">
            <KortixLogo size={11} variant="symbol" className="text-background" />
          </span>
          <span className="text-foreground text-[13px] font-medium">Kortix</span>
          <ChevronsUpDown className="text-muted-foreground size-3" />
          <span className="border-border bg-background ml-auto flex size-6 items-center justify-center rounded-sm border">
            <Plus className="text-muted-foreground size-3.5" />
          </span>
        </div>

        <div className="space-y-0.5">
          {NAV.map((item) => (
            <SidebarRow key={item.name} {...item} />
          ))}
        </div>

        <div className="text-muted-foreground mt-5 mb-1.5 flex items-center gap-1 px-2.5 text-xs">
          Views <ChevronDown className="size-3" />
        </div>
        <div className="space-y-0.5">
          {VIEWS.map((item) => (
            <SidebarRow key={item.name} {...item} />
          ))}
        </div>

        <div className="text-muted-foreground mt-5 mb-1.5 flex items-center gap-1 px-2.5 text-xs">
          Recent <ChevronDown className="size-3" />
          <span className="ml-auto flex items-center gap-2">
            <Search className="size-3" />
            <Filter className="size-3" />
          </span>
        </div>
        <div className="space-y-2.5 px-2.5">
          {RECENT.map((item) => (
            <div key={item.title}>
              <p className="text-foreground/80 truncate text-[13px]">{item.title}</p>
              <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[11px]">
                {item.when}
                <span className="bg-muted text-muted-foreground flex size-3 items-center justify-center rounded-full text-[7px] font-medium">
                  {item.who[0]}
                </span>
                {item.who}
              </p>
            </div>
          ))}
        </div>
      </aside>

      {/* ── main ────────────────────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-border text-foreground border-b px-6 py-3.5 text-[13px] font-medium">
          Home
        </div>

        <div className="border-border bg-muted/30 border-b px-6 py-10">
          <div className="border-border bg-background mx-auto max-w-2xl rounded-sm border p-4 shadow-xs">
            <p className="text-foreground text-[13px]">
              Find stale API docs across our repos and update them to match the code
              <span className="bg-foreground ml-px inline-block h-3.5 w-px translate-y-0.5" />
            </p>
            <div className="text-muted-foreground mt-5 flex items-center gap-3 text-[12px]">
              <span className="flex items-center gap-1">
                Repositories <ChevronsUpDown className="size-3" />
              </span>
              <span className="flex items-center gap-1.5">
                <Icon.Claude className="size-3.5" />
                Kortix: Opus 5 <ChevronsUpDown className="size-3" />
              </span>
              <span className="ml-auto flex items-center gap-3">
                <Sliders className="size-3.5" />
                <AtSign className="size-3.5" />
                <Paperclip className="size-3.5" />
                <span className="bg-foreground text-background flex h-6 items-center gap-1.5 rounded-full px-2.5">
                  <ArrowRight className="size-3" />
                  <span className="bg-background/30 h-3 w-px" />
                  <ChevronDown className="size-3" />
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 pt-7">
          <SectionHeading label="Suggested agents" count={12} />
          <div className="grid grid-cols-3 gap-3">
            {AGENTS.map((agent) => (
              <div
                key={agent.name}
                className="border-border bg-card rounded-sm border p-4 shadow-xs"
              >
                <div className="flex gap-1.5">
                  {agent.icons.map((Glyph, i) => (
                    <Glyph key={i} className="size-4" />
                  ))}
                </div>
                <p className="text-foreground mt-3 text-[13px] font-medium">{agent.name}</p>
                <p className="text-muted-foreground mt-1.5 text-[12px] leading-snug">
                  {agent.description}
                </p>
                <span className="border-border text-muted-foreground mt-4 inline-flex h-7 items-center rounded-sm border px-2.5 text-[12px]">
                  Use template
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-7 space-y-3 px-6">
          <SectionHeading label="Active sessions" count={8} />
          <div className="space-y-2">
            {SESSIONS.map((session, i) => (
              <div
                key={session}
                className="border-border flex items-center gap-3 rounded-sm border px-4 py-3"
                style={{ opacity: 1 - i * 0.3 }}
              >
                <span className="border-muted-foreground/40 size-3.5 shrink-0 rounded-full border-2 border-t-transparent" />
                <p className="text-foreground/85 truncate text-[13px]">{session}</p>
                <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
                  1 min ago
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
