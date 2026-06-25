'use client';

import { InteractiveDemo } from '@/components/home/interactive-demo';
import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Check, FileText, MonitorSmartphone, PanelTop, SendHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

const MARKO_AVATAR = 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png';

type ChatLine =
  | { from: 'user'; name: string; text: string }
  | { from: 'kortix'; text: ReactNode; steps?: string[]; deliverables?: string[] };

function KortixAvatar() {
  return (
    <span className="bg-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
      <KortixLogo size={15} className="text-background" />
    </span>
  );
}

function UserAvatar() {
  return (
    <span className="bg-muted relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MARKO_AVATAR} alt="Marko" className="size-full object-cover" />
    </span>
  );
}

function ChatBody({
  lines,
  composerPlaceholder,
}: {
  lines: ChatLine[];
  composerPlaceholder: string;
}) {
  return (
    <div className="flex flex-1 flex-col justify-start gap-4 p-5 md:p-6">
      {lines.map((line, i) =>
        line.from === 'user' ? (
          <div key={i} className="flex items-start gap-2.5">
            <UserAvatar />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-foreground text-sm font-semibold">{line.name}</span>
              </div>
              <p className="text-foreground mt-0.5 text-sm leading-relaxed">{line.text}</p>
            </div>
          </div>
        ) : (
          <div key={i} className="flex items-start gap-2.5">
            <KortixAvatar />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-foreground text-sm font-semibold">Kortix</span>
                <span className="bg-muted text-muted-foreground rounded px-1 py-px text-xs font-semibold tracking-wide">
                  APP
                </span>
              </div>
              {line.steps ? (
                <div className="mt-1.5 space-y-1">
                  {line.steps.map((step) => (
                    <div
                      key={step}
                      className="text-muted-foreground flex items-center gap-2 text-xs"
                    >
                      <Check className="text-kortix-green size-3 shrink-0" />
                      <span className="font-mono">{step}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                {line.text}
              </div>
              {line.deliverables ? (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {line.deliverables.map((d) => (
                    <span
                      key={d}
                      className="border-border bg-background text-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                    >
                      <FileText className="text-muted-foreground size-3" />
                      {d}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ),
      )}

      <div className="border-border bg-card mt-auto flex items-center gap-2 rounded-xl border px-3.5 py-2.5">
        <span className="text-muted-foreground/70 flex-1 truncate text-sm">
          {composerPlaceholder}
        </span>
        <span className="bg-foreground flex size-6 shrink-0 items-center justify-center rounded-md">
          <SendHorizontal className="text-background size-3.5" />
        </span>
      </div>
    </div>
  );
}

function SurfaceFrame({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="border-card bg-background flex h-full flex-col overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
      <div className="border-border/60 bg-muted/30 flex items-center gap-2.5 border-b px-4 py-3">
        {icon}
        <span className="text-foreground text-sm font-semibold">{title}</span>
        <span className="bg-foreground/30 ml-1 size-1 rounded-full" />
        <span className="text-muted-foreground text-xs">Kortix</span>
      </div>
      {children}
    </div>
  );
}

const SLACK_LINES: ChatLine[] = [
  {
    from: 'user',
    name: 'Marko',
    text: "what's going on with john@acme.com? he says the app won't load",
  },
  {
    from: 'kortix',
    steps: [
      'read prod logs · 14:02 UTC',
      'cross-checked Stripe + auth',
      'shipped fix + opened PR #4218',
    ],
    text: (
      <>
        A stale auth token was 401ing every request. Forced a refresh — he&apos;s back in — and
        opened <span className="text-foreground font-medium">PR #4218</span> so it self-heals next
        time. Replied to John and filed the ticket.
      </>
    ),
    deliverables: ['PR #4218', 'SUP-1043', 'reply sent'],
  },
];

const TEAMS_LINES: ChatLine[] = [
  {
    from: 'user',
    name: 'Alex',
    text: 'close the month: reconcile QuickBooks vs Stripe and post the P&L',
  },
  {
    from: 'kortix',
    steps: [
      'pulled QuickBooks + Stripe',
      'reconciled 1,284 transactions',
      'flagged 2 gaps for review',
    ],
    text: (
      <>
        Reconciled — <span className="text-foreground font-medium">2 gaps</span> flagged ($412 in
        fees, one duplicate payout). Posted the P&amp;L narrative and dropped the close packet here.
      </>
    ),
    deliverables: ['close-packet.xlsx', 'P&L narrative'],
  },
];

function WebSurface() {
  return (
    <div className="border-card bg-background relative aspect-video h-full w-full overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
      <InteractiveDemo
        gradientbg={false}
        tab={false}
        embedded
        aside
        activePage="home"
        className="h-full w-full max-w-full"
      />
    </div>
  );
}

function DesktopSurface() {
  return (
    <div className="border-card bg-background relative aspect-video h-full w-full overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
      <div className="border-border/60 bg-muted/40 flex items-center gap-1.5 border-b px-3 py-2">
        <span className="bg-foreground/20 size-2.5 rounded-full" />
        <span className="bg-foreground/20 size-2.5 rounded-full" />
        <span className="bg-foreground/20 size-2.5 rounded-full" />
      </div>
      <InteractiveDemo
        gradientbg={false}
        tab={false}
        embedded
        aside
        activePage="chat"
        className="h-[calc(100%-2.25rem)] w-full max-w-full"
      />
    </div>
  );
}

const TABS = [
  { key: 'web', label: 'Web', icon: <PanelTop className="size-3.5" /> },
  { key: 'slack', label: 'Slack', icon: <Icon.Slack className="size-3.5" /> },
  { key: 'teams', label: 'Teams', icon: <Icon.MicrosoftTeams className="size-3.5" /> },
  { key: 'desktop', label: 'Desktop', icon: <MonitorSmartphone className="size-3.5" /> },
] as const;

export function ModalitySwitcher() {
  return (
    <section id="surfaces" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            Where it works
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            Meet Kortix where you already work.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            The same agents, the same repo — reachable from the web workspace, Slack, Teams, or your
            desktop. Ask in a message; get the work back.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.05}>
        <Tabs defaultValue="web" className="gap-0">
          <TabsList variant="secondary" className="h-auto gap-1 rounded-full p-1">
            {TABS.map((tab) => (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                variant="a_accent-i_outline"
                className="h-9 rounded-full px-4"
              >
                {tab.icon}
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="web" className="mt-6">
            <div className="aspect-video h-[min(70vh,560px)] w-full">
              <WebSurface />
            </div>
          </TabsContent>

          <TabsContent value="slack" className="mt-6">
            <div
              className={cn(
                'min-h-[26rem] w-full',
                'rounded-2xl bg-[linear-gradient(in_oklch_180deg,oklch(from_var(--kortix-blue)_l_c_h/0.18)_0%,oklch(from_var(--kortix-green)_l_c_h/0.14)_50%,transparent_100%)] p-5 md:p-6',
              )}
            >
              <SurfaceFrame icon={<Icon.Slack className="size-5" />} title="#support">
                <ChatBody lines={SLACK_LINES} composerPlaceholder="Message #support" />
              </SurfaceFrame>
            </div>
          </TabsContent>

          <TabsContent value="teams" className="mt-6">
            <div
              className={cn(
                'min-h-[26rem] w-full',
                'from-kortix-purple/15 via-kortix-blue/10 rounded-2xl bg-linear-180 to-transparent p-5 md:p-6',
              )}
            >
              <SurfaceFrame icon={<Icon.MicrosoftTeams className="size-5" />} title="Finance">
                <ChatBody lines={TEAMS_LINES} composerPlaceholder="Type a message" />
              </SurfaceFrame>
            </div>
          </TabsContent>

          <TabsContent value="desktop" className="mt-6">
            <div className="aspect-video h-[min(70vh,560px)] w-full">
              <DesktopSurface />
            </div>
          </TabsContent>
        </Tabs>
      </Reveal>
    </section>
  );
}

export default ModalitySwitcher;
