'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import type { LucideIcon } from 'lucide-react';
import { Brain, CalendarClock, Layers, PackageCheck } from 'lucide-react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

type Card = {
  icon: LucideIcon;
  title: string;
  body: string;
  snippet: string;
};

const CARDS: Card[] = [
  {
    icon: PackageCheck,
    title: 'Real output, not just text',
    body: 'Kortix hands you the finished PR, deck, dashboard, or app — not a wall of suggestions.',
    snippet: "Done. The PR's merged.",
  },
  {
    icon: Layers,
    title: 'One message, your whole stack',
    body: '3,000+ tools in a single request. The work that crosses every system.',
    snippet: 'Pulled it from Stripe, Salesforce, and Notion in one pass.',
  },
  {
    icon: CalendarClock,
    title: 'On a schedule — and on triggers',
    body: 'Daily reports and weekly digests on autopilot, or fired by a webhook the moment something happens. Agents running 24/7.',
    snippet: 'Posted your Monday recap. And paged on that incident at 2am.',
  },
  {
    icon: Brain,
    title: 'It learns your company',
    body: 'It remembers your decisions, your formats, your context — so you never repeat yourself.',
    snippet: 'Used your usual format. I remembered.',
  },
];

function Snippet({ text }: { text: string }) {
  return (
    <div className="border-border bg-background mt-5 flex items-start gap-2.5 rounded-xl border p-3">
      <span className="bg-foreground flex size-5 shrink-0 items-center justify-center rounded-sm">
        <KortixLogo size={11} className="text-background" />
      </span>
      <p className="text-muted-foreground min-w-0 text-sm leading-relaxed">
        <span className="text-foreground font-medium">Kortix:</span> &ldquo;{text}&rdquo;
      </p>
    </div>
  );
}

export function WhyItsAHire() {
  return (
    <section id="why-a-hire" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            Why it feels like a hire
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            Not a chatbot. A coworker.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            Four things that make Kortix feel less like a tool and more like someone you just hired.
          </p>
        </div>
      </Reveal>

      <div className="grid gap-4 sm:grid-cols-2">
        {CARDS.map((card, i) => {
          const Icon = card.icon;
          return (
            <Reveal key={card.title} delay={(i % 2) * 0.06}>
              <div className="border-border bg-card flex h-full flex-col rounded-2xl border p-6 md:p-7">
                <span className="border-border bg-background text-foreground flex size-11 items-center justify-center rounded-xl border">
                  <Icon className="size-5" />
                </span>
                <h3 className="text-foreground mt-5 text-lg font-medium tracking-tight">
                  {card.title}
                </h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{card.body}</p>
                <Snippet text={card.snippet} />
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

export default WhyItsAHire;
