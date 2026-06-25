'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ArrowRight, Check, FileText, GitMerge, LayoutDashboard, Webhook } from 'lucide-react';
import type { ReactNode } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

/* ---------- shared atoms ---------- */

/** A small mono chip used inside the bespoke visuals. */
function Chip({
  children,
  className,
  dashed,
}: {
  children: ReactNode;
  className?: string;
  dashed?: boolean;
}) {
  return (
    <span
      className={cn(
        'border-border text-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs whitespace-nowrap',
        dashed && 'border-dashed',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The Kortix chat reply, styled as a clean single line / bubble. */
function Snippet({ text }: { text: string }) {
  return (
    <div className="border-border bg-background mt-5 flex items-start gap-2.5 rounded-2xl border p-3">
      <span className="bg-foreground flex size-5 shrink-0 items-center justify-center rounded-md">
        <KortixLogo size={11} className="text-background" />
      </span>
      <p className="text-muted-foreground min-w-0 text-sm leading-relaxed">
        <span className="text-foreground font-medium">Kortix:</span> &ldquo;{text}&rdquo;
      </p>
    </div>
  );
}

/** Card frame: equal-height, generous padding, strong vertical hierarchy. */
function HireCard({
  title,
  body,
  visual,
  snippet,
}: {
  title: string;
  body: string;
  visual: ReactNode;
  snippet: string;
}) {
  return (
    <div className="border-border bg-card flex h-full min-w-0 flex-col rounded-2xl border p-6 md:p-7">
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{body}</p>
      {/* bespoke visual — fills the middle so cards stay equal height */}
      <div className="border-border/60 bg-background/60 mt-5 flex flex-1 items-center justify-center rounded-2xl border border-dashed p-5">
        {visual}
      </div>
      <Snippet text={snippet} />
    </div>
  );
}

/* ---------- bespoke visuals ---------- */

/** 1 · Real output — a merged PR + the deliverable files it produced. */
function OutputVisual() {
  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5">
      <div className="border-border bg-card flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
        <GitMerge className="text-kortix-green size-4 shrink-0" />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
          Add scheduled exports
        </span>
        <Chip className="text-kortix-green border-kortix-green/30 shrink-0">merged</Chip>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="border-border bg-card flex items-center gap-2 rounded-xl border px-3 py-2.5">
          <FileText className="text-muted-foreground size-4 shrink-0" />
          <span className="text-foreground truncate font-mono text-xs">deck.pdf</span>
        </div>
        <div className="border-border bg-card flex items-center gap-2 rounded-xl border px-3 py-2.5">
          <LayoutDashboard className="text-muted-foreground size-4 shrink-0" />
          <span className="text-foreground truncate font-mono text-xs">dashboard</span>
        </div>
      </div>
    </div>
  );
}

/** 2 · Whole stack — tool chips converging into one Kortix run. */
function StackVisual() {
  const tools = ['Stripe', 'Salesforce', 'Notion'];
  return (
    <div className="flex w-full items-center justify-center gap-3 sm:gap-4">
      <div className="flex flex-col gap-2">
        {tools.map((t) => (
          <Chip key={t} className="bg-card justify-center">
            {t}
          </Chip>
        ))}
      </div>
      <ArrowRight className="text-muted-foreground/60 size-4 shrink-0" />
      <span className="bg-foreground flex size-11 shrink-0 items-center justify-center rounded-2xl">
        <KortixLogo size={20} className="text-background" />
      </span>
      <ArrowRight className="text-muted-foreground/60 size-4 shrink-0" />
      <Chip className="bg-card">1 pass</Chip>
    </div>
  );
}

/** 3 · Schedule & triggers — a cron line and a webhook firing, 24/7. */
function ScheduleVisual() {
  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5">
      <div className="border-border bg-card flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
        <span className="text-muted-foreground text-xs">every</span>
        <Chip>Mon · 9:00</Chip>
        <span className="text-muted-foreground ml-auto text-xs">Monday recap</span>
      </div>
      <div className="border-border bg-card flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
        <Webhook className="text-kortix-green size-4 shrink-0" />
        <Chip dashed>
          webhook
          <ArrowRight className="size-3" />
        </Chip>
        <span className="text-foreground ml-auto inline-flex items-center gap-1.5 text-xs font-medium">
          <span className="bg-kortix-green/80 size-1.5 rounded-full" />
          24 / 7
        </span>
      </div>
    </div>
  );
}

/** 4 · Learns your company — a memory file the agent remembered. */
function MemoryVisual() {
  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5">
      <div className="border-border bg-card flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
        <FileText className="text-muted-foreground size-4 shrink-0" />
        <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
          memory/preferences.md
        </span>
        <span className="text-kortix-green inline-flex items-center gap-1 text-xs font-medium">
          <Check className="size-3.5" />
          saved
        </span>
      </div>
      <div className="border-border bg-card text-muted-foreground rounded-xl border px-3 py-2.5 text-xs leading-relaxed">
        <span className="text-foreground font-medium">Format:</span> exec summary first ·{' '}
        <span className="text-foreground font-medium">Tone:</span> concise
      </div>
    </div>
  );
}

/* ---------- section ---------- */

type Card = {
  title: string;
  body: string;
  snippet: string;
  visual: ReactNode;
};

const CARDS: Card[] = [
  {
    title: 'It ships finished work.',
    body: 'You get the merged PR, the deck, the deployed app — the actual deliverable, ready to use. No wall of suggestions to go act on yourself.',
    snippet: "Done — PR's merged and deployed.",
    visual: <OutputVisual />,
  },
  {
    title: 'Works across every system.',
    body: 'Wired into 3,000+ tools, one request reaches all of them in a single pass — the job that usually means five tabs and three teammates.',
    snippet: 'Hit Stripe, Salesforce, and Notion in one run.',
    visual: <StackVisual />,
  },
  {
    title: 'Always on — schedule or trigger.',
    body: 'Put it on a cadence, or wire it to an event so a webhook fires it the instant something happens. Your agents run 24/7.',
    snippet: "Monday recap's up. Also paged you on the 2am incident.",
    visual: <ScheduleVisual />,
  },
  {
    title: 'It remembers how you work.',
    body: 'Your decisions, your formats, your context — saved as memory it reuses. Tell it once; never repeat yourself.',
    snippet: 'Formatted it your way — already knew.',
    visual: <MemoryVisual />,
  },
];

export function WhyItsAHire() {
  return (
    <section id="why-a-hire" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            More hire than tool
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            Not a chatbot. A coworker.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            Four reasons it feels less like software and more like someone on the team.
          </p>
        </div>
      </Reveal>

      <div className="grid items-stretch gap-4 sm:grid-cols-2">
        {CARDS.map((card, i) => (
          <Reveal key={card.title} delay={(i % 2) * 0.06}>
            <HireCard
              title={card.title}
              body={card.body}
              visual={card.visual}
              snippet={card.snippet}
            />
          </Reveal>
        ))}
      </div>
    </section>
  );
}

export default WhyItsAHire;
