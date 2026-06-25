'use client';

import { CliDemo } from '@/components/home/cli-demo';
import { InteractiveDemoSection } from '@/components/home/interactive-demo-section';
import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import {
  Check,
  Download,
  MonitorSmartphone,
  SendHorizontal,
  Smartphone,
  Terminal,
} from 'lucide-react';
import type { ReactNode } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

const MARKO_AVATAR = 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png';

type Deliverable = { name: string; meta: string };

type ChatLine =
  | { from: 'user'; name: string; text: string }
  | { from: 'kortix'; text: ReactNode; steps?: string[]; deliverable?: Deliverable };

function KortixAvatar({ size = 8 }: { size?: number }) {
  return (
    <span
      className="bg-foreground flex shrink-0 items-center justify-center rounded-md"
      style={{ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }}
    >
      <KortixLogo size={size * 1.85} className="text-background" />
    </span>
  );
}

function UserAvatar({ size = 8 }: { size?: number }) {
  return (
    <span
      className="bg-muted relative flex shrink-0 items-center justify-center overflow-hidden rounded-md"
      style={{ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MARKO_AVATAR} alt="Marko" className="size-full object-cover" />
    </span>
  );
}

function DeliverableCard({
  deliverable,
  compact,
}: {
  deliverable: Deliverable;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'border-border bg-background mt-3 flex items-center gap-3 rounded-xl border p-3',
        compact && 'p-2.5',
      )}
    >
      <span className="bg-destructive/10 text-destructive flex size-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold">
        PDF
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{deliverable.name}</p>
        <p className="text-muted-foreground truncate text-xs">{deliverable.meta}</p>
      </div>
      <span className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 items-center justify-center transition-colors">
        <Download className="size-4" />
      </span>
    </div>
  );
}

function ChatBody({
  lines,
  composerPlaceholder,
  dense,
}: {
  lines: ChatLine[];
  composerPlaceholder: string;
  dense?: boolean;
}) {
  const avatarSize = dense ? 7 : 8;
  return (
    <div className={cn('flex flex-1 flex-col justify-start gap-4', dense ? 'p-4' : 'p-5 md:p-6')}>
      {lines.map((line, i) =>
        line.from === 'user' ? (
          <div key={i} className="flex items-start gap-2.5">
            <UserAvatar size={avatarSize} />
            <div className="min-w-0">
              <span className="text-foreground text-sm font-semibold">{line.name}</span>
              <p className="text-foreground mt-0.5 text-sm leading-relaxed">{line.text}</p>
            </div>
          </div>
        ) : (
          <div key={i} className="flex items-start gap-2.5">
            <KortixAvatar size={avatarSize} />
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
              {line.deliverable ? (
                <DeliverableCard deliverable={line.deliverable} compact={dense} />
              ) : null}
            </div>
          </div>
        ),
      )}

      <div
        className={cn(
          'border-border bg-card mt-auto flex items-center gap-2 rounded-xl border px-3.5',
          dense ? 'py-2' : 'py-2.5',
        )}
      >
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

// The same idea across every surface: ask for the weekly report, watch the
// steps, get the natural-language reply + a generated PDF deliverable.
const REPORT_DELIVERABLE: Deliverable = {
  name: 'Weekly-Performance.pdf',
  meta: 'Revenue, signups, churn · 12 pages · just now',
};

function reportLines(name: string): ChatLine[] {
  return [
    {
      from: 'user',
      name,
      text: 'pull this week’s performance report and post it here',
    },
    {
      from: 'kortix',
      steps: [
        'pulled Stripe + PostHog + ad accounts',
        'built the summary + charts',
        'rendered the PDF',
      ],
      text: (
        <>
          Revenue is up <span className="text-foreground font-medium">+18%</span> w/w, signups{' '}
          <span className="text-foreground font-medium">+9%</span>, churn flat. Here&apos;s the full
          report.
        </>
      ),
      deliverable: REPORT_DELIVERABLE,
    },
  ];
}

function WebDesktopSurface() {
  // The full Kortix web/desktop app — the rich tabbed product UI (Projects ·
  // Chat · Agents · Skills · Integrations · Models · Channels). The CLI lives in
  // its own tab now, so this is the app surface only (embedded = no CLI window).
  return (
    <div className="border-card bg-background relative flex h-full w-full flex-col overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
      <div className="border-border/60 bg-muted/40 flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <span className="bg-foreground/20 size-2.5 rounded-full" />
        <span className="bg-foreground/20 size-2.5 rounded-full" />
        <span className="bg-foreground/20 size-2.5 rounded-full" />
      </div>
      <div className="min-h-0 flex-1 p-2 sm:p-3">
        <InteractiveDemoSection
          gradientbg={false}
          embedded
          className="h-full"
          contentClassName="h-full"
        />
      </div>
    </div>
  );
}

function CliSurface() {
  // The terminal experience: kortix init -> kortix ship, in its own window.
  return (
    <div className="h-full w-full">
      <CliDemo />
    </div>
  );
}

function PhoneSurface() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="border-foreground/15 bg-background flex h-full max-h-[520px] w-full max-w-[300px] flex-col overflow-hidden rounded-3xl border-4 shadow-xl">
        <div className="bg-muted/30 flex items-center justify-center py-2">
          <span className="bg-foreground/20 h-1.5 w-16 rounded-full" />
        </div>
        <div className="border-border/60 flex items-center gap-2.5 border-b px-4 py-3">
          <Icon.Slack className="size-4" />
          <span className="text-foreground text-sm font-semibold">#leadership</span>
        </div>
        <ChatBody lines={reportLines('Marko')} composerPlaceholder="Message" dense />
      </div>
    </div>
  );
}

const TABS = [
  { key: 'webdesktop', label: 'Web/Desktop', icon: <MonitorSmartphone className="size-3.5" /> },
  { key: 'slack', label: 'Slack', icon: <Icon.Slack className="size-3.5" /> },
  { key: 'teams', label: 'Teams', icon: <Icon.MicrosoftTeams className="size-3.5" /> },
  { key: 'mobile', label: 'Mobile', icon: <Smartphone className="size-3.5" /> },
  { key: 'cli', label: 'CLI', icon: <Terminal className="size-3.5" /> },
] as const;

const CONTENT_CLASS = 'mt-0 h-full data-[state=inactive]:hidden';

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
            The same agents, the same repo — reachable from the web/desktop app, Slack, Teams, your
            phone, or the CLI. Ask in a message; get the work back.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.05}>
        <Tabs defaultValue="webdesktop" className="gap-6">
          <div className="-mx-6 overflow-x-auto px-6 lg:mx-0 lg:px-0">
            <TabsList variant="secondary" className="h-auto w-max gap-1 rounded-full p-1">
              {TABS.map((tab) => (
                <TabsTrigger
                  key={tab.key}
                  value={tab.key}
                  variant="a_accent-i_outline"
                  className="h-9 shrink-0 rounded-full px-4"
                >
                  {tab.icon}
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Fixed-height stage — switching tabs never changes the size. */}
          <div className="h-[34rem] w-full sm:h-[36rem]">
            <TabsContent value="webdesktop" className={CONTENT_CLASS}>
              <WebDesktopSurface />
            </TabsContent>

            <TabsContent value="slack" className={CONTENT_CLASS}>
              <div className="h-full rounded-2xl bg-[linear-gradient(in_oklch_180deg,oklch(from_var(--kortix-blue)_l_c_h/0.18)_0%,oklch(from_var(--kortix-green)_l_c_h/0.14)_50%,transparent_100%)] p-4 md:p-6">
                <SurfaceFrame icon={<Icon.Slack className="size-5" />} title="#leadership">
                  <ChatBody
                    lines={reportLines('Marko')}
                    composerPlaceholder="Message #leadership"
                  />
                </SurfaceFrame>
              </div>
            </TabsContent>

            <TabsContent value="teams" className={CONTENT_CLASS}>
              <div className="from-kortix-purple/15 via-kortix-blue/10 h-full rounded-2xl bg-linear-180 to-transparent p-4 md:p-6">
                <SurfaceFrame icon={<Icon.MicrosoftTeams className="size-5" />} title="Leadership">
                  <ChatBody lines={reportLines('Alex')} composerPlaceholder="Type a message" />
                </SurfaceFrame>
              </div>
            </TabsContent>

            <TabsContent value="mobile" className={CONTENT_CLASS}>
              <div className="from-kortix-blue/10 h-full rounded-2xl bg-linear-180 to-transparent p-4">
                <PhoneSurface />
              </div>
            </TabsContent>

            <TabsContent value="cli" className={CONTENT_CLASS}>
              <CliSurface />
            </TabsContent>
          </div>
        </Tabs>
      </Reveal>
    </section>
  );
}

export default ModalitySwitcher;
