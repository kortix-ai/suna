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
  Sparkles,
  Sliders,
  Users,
} from 'lucide-react';

/**
 * A still of the Kortix app, used as the hero's product shot. Deliberately
 * static — it is a screenshot, not a working surface.
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
  },
  {
    name: 'Enrich Linear Issue',
    description: 'Adds context and implementation suggestions to new Linear issues.',
  },
  {
    name: 'Daily Slack Changelog',
    description: 'Summarizes daily code changes and posts a formatted changelog to Slack.',
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
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]',
        active ? 'bg-black/[0.05] text-neutral-900' : 'text-neutral-600',
      )}
    >
      <IconCmp className={cn('size-3.5 shrink-0', tint ?? 'text-neutral-400')} />
      <span className="truncate">{name}</span>
    </div>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] text-neutral-900">{label}</h3>
        <span className="text-xs text-neutral-400">{count}</span>
      </div>
      <span className="flex items-center gap-1 text-xs text-neutral-500">
        All <ArrowRight className="size-3" />
      </span>
    </div>
  );
}

export function AppPreview() {
  return (
    <div className="flex h-full w-full min-w-[64rem] bg-white text-left font-sans">
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="flex w-[16rem] shrink-0 flex-col border-r border-black/[0.06] bg-[#FAFAFA] p-3">
        <div className="mb-3 flex items-center gap-2 px-1.5">
          <span className="flex size-5 items-center justify-center rounded bg-neutral-900">
            <KortixLogo size={11} variant="symbol" className="text-white" />
          </span>
          <span className="text-[13px] font-medium text-neutral-900">Kortix</span>
          <ChevronsUpDown className="size-3 text-neutral-400" />
          <span className="ml-auto flex size-6 items-center justify-center rounded-md border border-black/[0.07] bg-white">
            <Plus className="size-3.5 text-neutral-500" />
          </span>
        </div>

        <div className="space-y-0.5">
          {NAV.map((item) => (
            <SidebarRow key={item.name} {...item} />
          ))}
        </div>

        <div className="mt-5 mb-1.5 flex items-center gap-1 px-2.5 text-xs text-neutral-500">
          Views <ChevronDown className="size-3" />
        </div>
        <div className="space-y-0.5">
          {VIEWS.map((item) => (
            <SidebarRow key={item.name} {...item} />
          ))}
        </div>

        <div className="mt-5 mb-1.5 flex items-center gap-1 px-2.5 text-xs text-neutral-500">
          Recent <ChevronDown className="size-3" />
          <span className="ml-auto flex items-center gap-2">
            <Search className="size-3" />
            <Filter className="size-3" />
          </span>
        </div>
        <div className="space-y-2.5 px-2.5">
          {RECENT.map((item) => (
            <div key={item.title}>
              <p className="truncate text-[13px] text-neutral-800">{item.title}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-400">
                {item.when}
                <span className="flex size-3 items-center justify-center rounded-full bg-neutral-200 text-[7px] font-medium text-neutral-600">
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
        <div className="border-b border-black/[0.06] px-6 py-3.5 text-[13px] font-medium text-neutral-900">
          Home
        </div>

        <div className="border-b border-black/[0.06] bg-[#FCFCFC] px-6 py-10">
          <div className="mx-auto max-w-2xl rounded-lg border border-black/[0.08] bg-white p-4 shadow-sm">
            <p className="text-[13px] text-neutral-900">
              Find stale API docs across our repos and update them to match the code
              <span className="ml-px inline-block h-3.5 w-px translate-y-0.5 bg-neutral-900" />
            </p>
            <div className="mt-5 flex items-center gap-3 text-[12px] text-neutral-500">
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
                <span className="flex h-6 items-center gap-1.5 rounded-full bg-neutral-900 px-2.5 text-white">
                  <ArrowRight className="size-3" />
                  <span className="h-3 w-px bg-white/30" />
                  <ChevronDown className="size-3" />
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 pt-7">
          <SectionHeading label="Suggested Agents" count={12} />
          <div className="grid grid-cols-3 gap-3">
            {AGENTS.map((agent) => (
              <div
                key={agent.name}
                className="rounded-lg border border-black/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(26,31,46,0.04)]"
              >
                <div className="flex gap-1">
                  <span className="size-4 rounded-sm bg-neutral-200" />
                  <span className="size-4 rounded-sm bg-neutral-300" />
                </div>
                <p className="mt-3 text-[13px] font-medium text-neutral-900">{agent.name}</p>
                <p className="mt-1.5 text-[12px] leading-snug text-neutral-500">
                  {agent.description}
                </p>
                <span className="mt-4 inline-flex h-7 items-center rounded-md border border-black/[0.08] px-2.5 text-[12px] text-neutral-600">
                  Use template
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-7 space-y-3 px-6">
          <SectionHeading label="Active Sessions" count={8} />
          <div className="space-y-2">
            {SESSIONS.map((session, i) => (
              <div
                key={session}
                className="flex items-center gap-3 rounded-lg border border-black/[0.06] px-4 py-3"
                style={{ opacity: 1 - i * 0.35 }}
              >
                <span className="size-3.5 shrink-0 rounded-full border-2 border-neutral-300 border-t-transparent" />
                <p className="truncate text-[13px] text-neutral-800">{session}</p>
                <span className="ml-auto shrink-0 text-[11px] text-neutral-400">1 min ago</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
