'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bug,
  Code2,
  Headphones,
  LineChart,
  Megaphone,
  Receipt,
  Search,
  Settings2,
} from 'lucide-react';
import { motion, useInView } from 'motion/react';
import { useRef } from 'react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

type Category = {
  key: string;
  label: string;
  icon: LucideIcon;
};

const CATEGORIES = {
  engineering: { key: 'engineering', label: 'Engineering', icon: Code2 },
  incidents: { key: 'incidents', label: 'Production', icon: Bug },
  support: { key: 'support', label: 'Support', icon: Headphones },
  growth: { key: 'growth', label: 'Growth & data', icon: LineChart },
  finance: { key: 'finance', label: 'Finance & ops', icon: Receipt },
  gtm: { key: 'gtm', label: 'GTM', icon: Megaphone },
  pm: { key: 'pm', label: 'Cross-team', icon: BarChart3 },
  research: { key: 'research', label: 'Research', icon: Search },
  platform: { key: 'platform', label: 'The platform', icon: Settings2 },
} satisfies Record<string, Category>;

type Prompt = {
  category: Category;
  text: string;
};

// Real, one-off asks you'd send Kortix in Slack — picked to show breadth.
const PROMPTS: Prompt[] = [
  {
    category: CATEGORIES.engineering,
    text: 'build scheduled exports — workspace-level, cadence picker — and open a PR',
  },
  {
    category: CATEGORIES.incidents,
    text: "what's throwing in prod right now? pull the top Better Stack errors and fix the worst",
  },
  {
    category: CATEGORIES.growth,
    text: "pull this week's growth report from our ad accounts, PostHog and Stripe — summary, an Excel, and an investor deck",
  },
  {
    category: CATEGORIES.support,
    text: "what's going on with john@acme.com? he says the app won't load",
  },
  {
    category: CATEGORIES.engineering,
    text: 'find the flaky test in checkout, fix it, merge when green',
  },
  {
    category: CATEGORIES.finance,
    text: 'close the month: reconcile QuickBooks vs Stripe, flag gaps, post the P&L narrative',
  },
  {
    category: CATEGORIES.incidents,
    text: '#incident the app is down — investigate from logs + deploys, tell me code vs infra',
  },
  {
    category: CATEGORIES.gtm,
    text: 'research this account and draft a cold email in my voice — one real hook',
  },
  {
    category: CATEGORIES.engineering,
    text: 'review PR #4210 like a senior eng — and actually run it',
  },
  {
    category: CATEGORIES.growth,
    text: 'which ad campaigns are underwater? flag them and recommend cuts',
  },
  {
    category: CATEGORIES.platform,
    text: 'add a HubSpot connector and wire it into the GTM agent',
  },
  {
    category: CATEGORIES.pm,
    text: 'scheduled exports merged — update the launch blog, feature table, and beta invite email, and post in #launch',
  },
  {
    category: CATEGORIES.finance,
    text: "who's about to churn? cross Stripe + usage and give me the at-risk list",
  },
  {
    category: CATEGORIES.engineering,
    text: 'p99 on /api/search doubled — profile it and propose a fix',
  },
  {
    category: CATEGORIES.support,
    text: "summarize this week's support threads and file the top 3 bugs in Linear",
  },
  {
    category: CATEGORIES.research,
    text: "deep-dive our top 3 competitors' pricing and give me a cited brief",
  },
  {
    category: CATEGORIES.growth,
    text: 'build a live dashboard for these metrics and deploy it',
  },
  {
    category: CATEGORIES.gtm,
    text: "turn last week's launch into 5 LinkedIn posts and an X thread",
  },
  {
    category: CATEGORIES.platform,
    text: 'spin up a support agent that watches #support and drafts replies',
  },
  {
    category: CATEGORIES.incidents,
    text: 'query the logs: what failed at 14:02 UTC for that customer?',
  },
  {
    category: CATEGORIES.engineering,
    text: 'bump us to Next 15, fix what breaks, open a PR',
  },
  {
    category: CATEGORIES.pm,
    text: 'take triage in #bugs for a few hours and ping me on anything that needs me',
  },
  {
    category: CATEGORIES.growth,
    text: 'every Monday 9am, post the growth report to #leadership',
  },
  {
    category: CATEGORIES.pm,
    text: 'turn this thread into a Linear project with owners + due dates',
  },
  {
    category: CATEGORIES.platform,
    text: 'remember: we never email on Fridays',
  },
];

function PromptCard({ prompt, index }: { prompt: Prompt; index: number }) {
  const Icon = prompt.category.icon;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{
        duration: 0.45,
        delay: Math.min(index * 0.025, 0.4),
        ease: [0.16, 1, 0.3, 1],
      }}
      className="group bg-card hover:bg-accent/40 flex h-full flex-col gap-3 p-5 transition-colors duration-200 md:p-6"
    >
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground text-xs font-medium tracking-wide">
          {prompt.category.label}
        </span>
      </div>
      <div className="flex items-start gap-2.5">
        <span className="bg-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm">
          <KortixLogo size={11} className="text-background" />
        </span>
        <p className="text-foreground text-sm leading-relaxed">
          <span className="text-muted-foreground font-medium">@Kortix</span> {prompt.text}
        </p>
      </div>
    </motion.div>
  );
}

const CATEGORY_LEGEND: Category[] = [
  CATEGORIES.engineering,
  CATEGORIES.incidents,
  CATEGORIES.support,
  CATEGORIES.growth,
  CATEGORIES.finance,
  CATEGORIES.gtm,
  CATEGORIES.pm,
  CATEGORIES.research,
  CATEGORIES.platform,
];

export function UseCasesShowcase() {
  return (
    <section id="use-cases" className={sectionShell}>
      <Reveal>
        <div className="mb-12 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            What can Kortix do?
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            One coworker. The whole company.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            Real, one-off asks you&apos;d send Kortix in Slack — across engineering, incidents,
            growth, finance, support, and GTM. Not a demo. The actual work.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.05}>
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {CATEGORY_LEGEND.map((category) => {
            const Icon = category.icon;
            return (
              <span
                key={category.key}
                className="border-border text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
              >
                <Icon className="size-3" />
                {category.label}
              </span>
            );
          })}
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div
          className={cn(
            'bg-border grid gap-px overflow-hidden rounded-sm border',
            'sm:grid-cols-2 lg:grid-cols-3',
          )}
        >
          {PROMPTS.map((prompt, index) => (
            <PromptCard key={prompt.text} prompt={prompt} index={index} />
          ))}
        </div>
      </Reveal>
    </section>
  );
}

export default UseCasesShowcase;
