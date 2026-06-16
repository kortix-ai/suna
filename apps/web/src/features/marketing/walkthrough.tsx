'use client';

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import { Check, FileText, Plus, Sparkles } from 'lucide-react';
import { useInView } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WALKTHROUGH, type WalkStep } from './narrative';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

/* ─── Window chrome ─────────────────────────────────────────────────────── */

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-border dark:bg-background rounded-xl p-1 shadow-sm">
      <div className="bg-background dark:bg-primary/7 flex items-center gap-2 rounded-t-lg px-3.5 py-2.5">
        <span className="flex gap-1.5">
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground ml-1.5 font-mono text-xs">{label}</span>
      </div>
      <div className="bg-background dark:bg-primary/7 flex h-[360px] flex-col rounded-b-lg p-5">
        {children}
      </div>
    </div>
  );
}

function Bubble({ who, children }: { who: 'user' | 'kortix'; children: React.ReactNode }) {
  if (who === 'user') {
    return (
      <div className="bg-muted/50 text-foreground ml-auto w-fit max-w-[80%] rounded-lg rounded-tr-sm px-3 py-2 text-sm">
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold">
        K
      </span>
      <div className="bg-card border-border text-foreground w-fit max-w-[85%] rounded-lg rounded-tl-sm border px-3 py-2 text-sm">
        {children}
      </div>
    </div>
  );
}

/* ─── Showcases ─────────────────────────────────────────────────────────── */

function ConnectShowcase() {
  const apps: [string, string][] = [
    ['slack.com', 'Slack'],
    ['salesforce.com', 'Salesforce'],
    ['stripe.com', 'Stripe'],
    ['notion.so', 'Notion'],
    ['github.com', 'GitHub'],
    ['hubspot.com', 'HubSpot'],
  ];
  return (
    <Frame label="kortix · connect">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-foreground text-sm font-semibold">Connected</span>
        <span className="text-kortix-green inline-flex items-center gap-1.5 text-xs font-medium">
          <span className="bg-kortix-green size-1.5 rounded-full" /> one-click · OAuth
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {apps.map(([d, n]) => (
          <div
            key={n}
            className="border-kortix-green/30 bg-card flex items-center gap-2.5 rounded-md border p-2.5"
          >
            <span className="border-border bg-background flex size-7 items-center justify-center overflow-hidden rounded-lg border">
              <img src={favicon(d)} alt={n} width={16} height={16} loading="lazy" />
            </span>
            <span className="text-foreground truncate text-sm font-medium">{n}</span>
            <Check className="text-kortix-green ml-auto size-3.5" />
          </div>
        ))}
      </div>
      <div className="text-muted-foreground mt-auto text-center text-xs">+ 3,000 more</div>
    </Frame>
  );
}

function DelegateShowcase() {
  return (
    <Frame label="#growth · slack">
      <div className="flex flex-1 flex-col justify-center gap-3">
        <Bubble who="user">@Kortix build a competitive analysis on our top 3 rivals — as a PDF</Bubble>
        <Bubble who="kortix">
          On it. Pulling positioning, pricing and recent launches across the three…
        </Bubble>
        <div className="text-muted-foreground flex items-center gap-2 pl-8 text-xs">
          <span className="bg-kortix-green size-1.5 animate-pulse rounded-full" /> working · 3 tools
        </div>
      </div>
    </Frame>
  );
}

function ShipShowcase() {
  return (
    <Frame label="#growth · slack">
      <div className="flex flex-1 flex-col justify-center gap-3">
        <Bubble who="kortix">Done — here you go. Summary in thread 👇</Bubble>
        <div className="border-border bg-card ml-8 flex items-center gap-3 rounded-md border p-3">
          <span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-lg border">
            <FileText className="text-foreground size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-foreground truncate text-sm font-medium">
              competitive-analysis.pdf
            </div>
            <div className="text-muted-foreground text-xs">12 pages · charts · sources</div>
          </div>
          <Check className="text-kortix-green ml-auto size-4" />
        </div>
        <div className="text-muted-foreground pl-8 text-xs">Delivered in 2m 14s</div>
      </div>
    </Frame>
  );
}

function ShareShowcase() {
  return (
    <Frame label="kortix · skills">
      <div className="flex flex-1 flex-col justify-center">
        <div className="border-kortix-green/40 bg-kortix-green/5 rounded-md border p-4">
          <div className="flex items-center gap-2">
            <span className="border-border bg-background flex size-7 items-center justify-center rounded-md border">
              <Sparkles className="text-foreground/70 size-3.5" />
            </span>
            <span className="text-foreground font-mono text-sm font-medium">competitive-analysis</span>
            <span className="bg-kortix-green text-background ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
              <Plus className="size-3" /> Saved as skill
            </span>
          </div>
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            Versioned · composable · now available to every coworker in the company.
          </p>
        </div>
        <div className="text-muted-foreground mt-3 text-center text-xs">
          Shared with the team — the whole company just leveled up.
        </div>
      </div>
    </Frame>
  );
}

function showcaseFor(id: WalkStep['id']) {
  switch (id) {
    case 'connect':
      return <ConnectShowcase />;
    case 'delegate':
      return <DelegateShowcase />;
    case 'ship':
      return <ShipShowcase />;
    case 'share':
      return <ShareShowcase />;
  }
}

/* ─── Scroll mechanic ───────────────────────────────────────────────────── */

function StepRow({
  index,
  step,
  onActive,
}: {
  index: number;
  step: WalkStep;
  onActive: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { margin: '-45% 0px -45% 0px' });

  useEffect(() => {
    if (isInView) onActive(index);
  }, [index, isInView, onActive]);

  return (
    <div ref={ref} className="flex min-h-[58vh] flex-col justify-center space-y-4 py-8">
      <span className="bg-primary text-background w-fit rounded px-2 py-1 font-mono text-xs tracking-wider">
        {step.label}
      </span>
      <h3 className="text-foreground text-2xl font-medium tracking-tight">{step.title}</h3>
      <p className="text-muted-foreground max-w-md text-base leading-relaxed">{step.description}</p>
      <ul className="max-w-md space-y-2">
        {step.bullets.map((b) => (
          <li key={b} className="text-muted-foreground flex gap-2.5 text-[15px] leading-relaxed">
            <KortixAsterisk index={index} />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 lg:hidden">{showcaseFor(step.id)}</div>
    </div>
  );
}

export function HomeWalkthrough() {
  const [activeIndex, setActiveIndex] = useState(0);
  const handleActive = useCallback((i: number) => setActiveIndex(i), []);
  const steps = WALKTHROUGH.steps;

  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-8 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {WALKTHROUGH.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {WALKTHROUGH.title}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">{WALKTHROUGH.description}</p>
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          {steps.map((step, index) => (
            <StepRow key={step.id} index={index} step={step} onActive={handleActive} />
          ))}
        </div>

        <div className="relative hidden lg:block">
          <div className="sticky top-32">
            <div className="relative aspect-[5/4] w-full">
              {steps.map((step, index) => (
                <div
                  key={step.id}
                  className={cn(
                    'absolute inset-0 transition-opacity duration-300',
                    index === activeIndex ? 'opacity-100' : 'pointer-events-none opacity-0',
                  )}
                >
                  {showcaseFor(step.id)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
