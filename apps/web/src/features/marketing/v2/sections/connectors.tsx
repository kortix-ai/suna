'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { TAG } from '@/features/marketing/v2/content';
import { Icon } from '@/features/icon/icon';
import { Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ChevronRight, Inbox, Star, Target, Zap } from 'lucide-react';
import Link from 'next/link';

const DOCK = [Icon.Linear, Icon.Slack, Icon.Github, Icon.Notion, Icon.Gmail];

export function ConnectorsSection() {
  return (
    <Section id="connectors">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-foreground text-[2rem] leading-[1.1] font-medium tracking-[-0.02em] sm:text-[2.75rem]">
          <span className="block">
            Tag <span className="text-kortix-blue bg-kortix-blue/10 rounded px-1.5">@Kortix</span>{' '}
            where
          </span>
          <span className="block">the work is happening</span>
        </h2>
        <p className="text-muted-foreground mt-5 text-[1.0625rem] leading-relaxed">
          {TAG.subheading}
        </p>

        <div className="mt-8 flex items-center justify-center gap-3">
          <div className="flex -space-x-2.5">
            {DOCK.slice(0, 3).map((Glyph, i) => (
              <span
                key={i}
                className="border-background bg-card flex size-9 items-center justify-center rounded-full border-2"
              >
                <Glyph className="size-4" />
              </span>
            ))}
          </div>
          <span className="text-foreground text-sm font-medium">{TAG.integrationsLabel}</span>
        </div>
      </div>

      <div className="relative mt-14">
        <TicketMock />
        <div className="pointer-events-none absolute inset-x-0 -bottom-4 flex justify-center">
          <div className="border-border bg-card/80 flex items-end gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md">
            {DOCK.map((Glyph, i) => (
              <span
                key={i}
                className="border-border bg-background flex size-12 items-center justify-center rounded-xl border shadow-[0_1px_2px_rgba(26,31,46,0.05)]"
              >
                <Glyph className="size-6" />
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-16 text-center">
        <p className="text-muted-foreground text-[0.9375rem] leading-relaxed">
          {TAG.caption.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </p>
        <Link
          href="/marketplace"
          className="border-border bg-card hover:bg-accent text-foreground mt-6 inline-flex h-10 items-center gap-1.5 rounded-full border px-5 text-sm font-medium transition-colors"
        >
          {TAG.cta}
          <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </Section>
  );
}

/** A still of an issue tracker where a teammate @mentions Kortix. */
function TicketMock() {
  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border">
      <div className="flex min-w-0">
        <aside className="hidden w-52 shrink-0 flex-col gap-0.5 border-r border-black/[0.05] p-3 text-[13px] sm:flex dark:border-white/[0.06]">
          <div className="mb-3 flex items-center gap-2 px-2 py-1">
            <span className="bg-kortix-blue/15 text-kortix-blue flex size-5 items-center justify-center rounded">
              <Target className="size-3" />
            </span>
            <span className="text-foreground font-medium">Acme Inc</span>
          </div>
          {[
            { name: 'Inbox', icon: Inbox },
            { name: 'My issues', icon: Target },
            { name: 'Reviews', icon: Star },
            { name: 'Pulse', icon: Zap },
          ].map((item) => (
            <div
              key={item.name}
              className="text-muted-foreground flex items-center gap-2.5 rounded-md px-2 py-1.5"
            >
              <item.icon className="size-3.5" />
              {item.name}
            </div>
          ))}
          <p className="text-muted-foreground mt-4 px-2 text-xs">Favorites</p>
          <div className="bg-accent/60 text-foreground mt-1 flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <span className="bg-kortix-yellow size-2 rounded-full" />
            Clarify onboarding…
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between border-b border-black/[0.05] px-5 py-3 dark:border-white/[0.06]">
            <p className="text-foreground truncate text-[13px] font-medium">
              Clarify onboarding complaint
            </p>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">02 / 145</span>
          </div>

          <div className="space-y-4 p-5">
            <p className="text-muted-foreground text-xs">Activity</p>

            <div className="border-border bg-background rounded-xl border p-4">
              <p className="text-muted-foreground text-xs">
                <span className="text-foreground font-medium">Benja</span> · 2 min ago
              </p>
              <p className="text-foreground mt-2 text-[13px]">
                <span className="text-kortix-blue bg-kortix-blue/10 rounded px-1">@Kortix</span>{' '}
                what customer context should we know before scoping this?
              </p>
            </div>

            <div className="border-border bg-background rounded-xl border p-4">
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <span className="bg-foreground flex size-4 items-center justify-center rounded">
                  <KortixLogo size={8} variant="symbol" className="text-background" />
                </span>
                <span className="text-foreground font-medium">Kortix</span> · just now
              </p>
              <p className="text-foreground mt-2 text-[13px] leading-relaxed">
                I checked the CRM, the latest customer call, and our Slack history. Northstar's VP
                Eng marked this as blocking the team rollout after their SSO pilot.
              </p>
              <p className="text-muted-foreground/60 mt-2 text-[13px] leading-relaxed">
                On the call last week, Maya said the confusing part is not SSO itself. It is the
                missing mapping between SCIM groups and Kortix roles after the first sync.
              </p>
            </div>
          </div>
        </div>

        <aside className="hidden w-56 shrink-0 border-l border-black/[0.05] p-5 lg:block dark:border-white/[0.06]">
          <p className="text-muted-foreground text-xs">KOR-123</p>
          <div className="mt-4 space-y-3 text-[13px]">
            {[
              { label: 'In Progress', dot: 'bg-kortix-yellow' },
              { label: 'High', dot: 'bg-kortix-orange' },
              { label: 'Benja', dot: 'bg-kortix-green' },
            ].map((row) => (
              <div key={row.label} className="text-foreground flex items-center gap-2">
                <span className={cn('size-2 rounded-full', row.dot)} />
                {row.label}
              </div>
            ))}
            <div className="text-muted-foreground flex items-center gap-2 pl-4">
              <span className="bg-foreground flex size-4 items-center justify-center rounded">
                <KortixLogo size={8} variant="symbol" className="text-background" />
              </span>
              Kortix
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
