'use client';

import { Icon } from '@/features/icon/icon';
import { LIBRARY } from '@/features/marketing/v2/content';
import { Display, Lead, MAX_W } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useCallback, useRef } from 'react';

const CARDS = [
  {
    title: 'Agent templates',
    body: 'Pre-built agents for the work your company already repeats, ready to install.',
  },
  {
    title: 'Centralized audit logs',
    body: 'Every session, whether a person or a trigger started it, is logged in one place.',
  },
  {
    title: 'Team visibility',
    body: 'See what teammates and agents are working on, instead of work hiding on a laptop.',
  },
  {
    title: 'Scoped credentials',
    body: 'Each agent gets exactly the reach it needs through one token the model never sees.',
  },
  {
    title: 'Human approval gates',
    body: 'Nothing reaches main without a person signing off on the diff.',
  },
];

/** Plugs into your stack. Logs everything. */
export function PlugsSection() {
  const railRef = useRef<HTMLDivElement>(null);

  const scrollBy = useCallback((direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * rail.clientWidth * 0.6, behavior: 'smooth' });
  }, []);

  return (
    <section id="library" className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
          <Display lines={['Plugs into your stack.', 'Logs everything']} />
          <Lead className="self-center">
            Kortix connects to the tools your team already works in and centrally logs every
            session, from a Slack question to a scheduled trigger, so nothing runs without a trail.
          </Lead>
        </div>

        <div
          ref={railRef}
          className="mt-14 flex snap-x snap-mandatory gap-5 overflow-x-auto pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {CARDS.map((card, i) => (
            <article
              key={card.title}
              className="flex w-[20rem] shrink-0 snap-start flex-col overflow-hidden rounded-[1.35rem] sm:w-[24rem]"
              style={{
                background:
                  'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 5%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 15%, var(--background)) 100%)',
                border: '1px solid color-mix(in oklab, var(--kortix-blue) 11%, transparent)',
              }}
            >
              <div className="h-56 p-6">
                {i === 0 ? (
                  <TemplateGrid />
                ) : i === 1 ? (
                  <EventTrail />
                ) : i === 2 ? (
                  <RecentList />
                ) : i === 3 ? (
                  <SecretsList />
                ) : (
                  <ApprovalMini />
                )}
              </div>
              <div className="px-6 pt-2 pb-7">
                <h3 className="text-foreground text-[1.25rem] font-medium">{card.title}</h3>
                <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.5]">
                  {card.body}
                </p>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {[
            { dir: -1 as const, Icon: ArrowLeft, label: 'Previous' },
            { dir: 1 as const, Icon: ArrowRight, label: 'Next' },
          ].map(({ dir, Icon: Glyph, label }) => (
            <button
              key={label}
              type="button"
              onClick={() => scrollBy(dir)}
              aria-label={label}
              className="bg-foreground/[0.06] hover:bg-foreground/10 flex size-11 cursor-pointer items-center justify-center rounded-full transition-colors"
            >
              <Glyph className="size-4" />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Tile({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-background h-full overflow-hidden rounded-[0.75rem] p-3.5 shadow-[0_10px_28px_-10px_rgba(26,31,46,0.22)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

function TemplateGrid() {
  return (
    <div className="grid h-full grid-cols-2 gap-3">
      {LIBRARY.cards[0].items.slice(0, 4).map((name, i) => (
        <div
          key={name}
          className="bg-background flex flex-col justify-between rounded-[0.65rem] p-3 shadow-[0_8px_22px_-10px_rgba(26,31,46,0.2)]"
        >
          <div className="flex gap-1">
            {[Icon.Slack, Icon.Github][i % 2] &&
              [Icon.Slack, Icon.Github].map((G, k) => <G key={k} className="size-3.5" />)}
          </div>
          <p className="text-foreground mt-2 font-mono text-[11px] leading-snug">{name}</p>
          <span className="border-border text-muted-foreground mt-2 w-fit rounded border px-1.5 py-0.5 text-[9.5px]">
            Install
          </span>
        </div>
      ))}
    </div>
  );
}

const EVENTS = [
  { name: 'Session started · #company-ops', meta: '16h ago' },
  { name: 'Context retrieved', meta: '' },
  { name: '3 files modified', meta: '' },
  { name: 'Change request opened', meta: '' },
  { name: 'Approved by Sarah', meta: '' },
];

function EventTrail() {
  return (
    <Tile>
      <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[9.5px]">
        All events
      </span>
      <ul className="mt-3 space-y-2">
        {EVENTS.map((e, i) => (
          <li key={e.name}>
            <div className="flex items-center gap-2">
              <span className="bg-kortix-blue/20 size-3 shrink-0 rounded-full" />
              <p className="text-foreground truncate text-[11px]">{e.name}</p>
              {e.meta && <span className="text-muted-foreground text-[9.5px]">{e.meta}</span>}
            </div>
            {i === 1 && (
              <ul className="text-muted-foreground mt-1 ml-5 space-y-0.5 text-[9.5px]">
                <li>• Slack thread (12 messages)</li>
                <li>• memory/accounts/acme.md</li>
                <li>• Stripe · last 90 days</li>
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Tile>
  );
}

const RECENT = [
  'Draft the renewal for Acme',
  'Q3 enterprise pipeline analysis',
  'Backfill missing firmographics',
  'Refresh the pricing review deck',
  'Audit connector scopes',
  'Weekly revenue digest',
];

function RecentList() {
  return (
    <Tile>
      <p className="text-muted-foreground text-[10.5px]">Recent</p>
      <ul className="mt-2.5 space-y-2.5">
        {RECENT.map((item, i) => (
          <li key={item} style={{ opacity: 1 - i * 0.12 }}>
            <p className="text-foreground truncate text-[11px]">{item}</p>
            <p className="text-muted-foreground text-[9.5px]">
              {i + 1} {i === 0 ? 'week' : 'weeks'} ago
            </p>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

const SECRETS = ['STRIPE_API_KEY', 'SLACK_BOT_TOKEN', 'GITHUB_APP_KEY', 'CRM_API_KEY'];

function SecretsList() {
  return (
    <Tile>
      <p className="text-muted-foreground text-[10.5px]">Secrets · scoped to go-to-market</p>
      <ul className="mt-3 space-y-2">
        {SECRETS.map((s) => (
          <li key={s} className="flex items-center gap-2">
            <span className="bg-kortix-green/15 text-kortix-green rounded px-1 py-0.5 text-[8.5px]">
              scoped
            </span>
            <span className="text-foreground truncate font-mono text-[10.5px]">{s}</span>
            <span className="text-muted-foreground ml-auto font-mono text-[10px]">••••</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

function ApprovalMini() {
  return (
    <Tile className="flex flex-col">
      <p className="text-foreground font-mono text-[10.5px]">sales/renewals/acme.md</p>
      <pre className="mt-2 flex-1 font-mono text-[9.5px] leading-[1.7]">
        <div className="bg-kortix-green/10 text-kortix-green px-1.5">+ Seats: 120 → 165</div>
        <div className="bg-kortix-green/10 text-kortix-green px-1.5">+ ARR: $148k → $203.5k</div>
        <div className="bg-destructive/10 text-destructive px-1.5">- TODO: pull the numbers</div>
      </pre>
      <div className="mt-2 flex gap-1.5">
        <span className="bg-foreground text-background rounded px-2 py-1 text-[9.5px] font-medium">
          Approve
        </span>
        <span className="border-border text-muted-foreground rounded border px-2 py-1 text-[9.5px]">
          Request changes
        </span>
      </div>
    </Tile>
  );
}
