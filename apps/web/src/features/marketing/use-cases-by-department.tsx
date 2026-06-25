'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Code2,
  Headphones,
  Megaphone,
  PiggyBank,
  ServerCog,
  TrendingUp,
  UserRound,
} from 'lucide-react';

const sectionShell = 'mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0';

type Ask = {
  /** The one-off prompt sent to @Kortix. */
  text: string;
  /** The agent that runs it. */
  agent: string;
};

type Department = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** One-line framing of what this department hands to Kortix. */
  blurb: string;
  asks: Ask[];
};

const DEPARTMENTS: Department[] = [
  {
    key: 'engineering',
    label: 'Engineering',
    icon: Code2,
    blurb: 'Ships real code — reviews, fixes, profiling and PRs, run end to end.',
    asks: [
      {
        text: 'build scheduled exports — workspace-level, cadence picker — and open a PR',
        agent: 'eng',
      },
      { text: 'review PR #4210 like a senior eng and actually run it', agent: 'pr-review' },
      { text: 'find the flaky test in checkout, fix it, merge when green', agent: 'eng' },
      {
        text: 'prod is throwing — find the root cause, ship the fix, post the postmortem',
        agent: 'incident',
      },
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    icon: Megaphone,
    blurb: 'Turns one input into a week of on-brand content across every channel.',
    asks: [
      { text: "turn last week's launch into 5 LinkedIn posts and an X thread", agent: 'social' },
      { text: 'write an SEO post on agentic CI and open a PR to the blog', agent: 'content' },
      { text: 'repurpose this video into 6 vertical clips', agent: 'studio' },
      { text: 'draft the launch announcement and the email', agent: 'content' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    icon: TrendingUp,
    blurb: 'Researches, enriches and writes — in your voice, with one real hook.',
    asks: [
      {
        text: 'research this account and draft a cold email in my voice — one real hook',
        agent: 'outbound',
      },
      { text: 'who in my pipeline went quiet? draft follow-ups', agent: 'outbound' },
      { text: 'build the deal one-pager for Acme', agent: 'gtm' },
      { text: 'enrich these 50 leads with firmographics and a fit score', agent: 'enrich' },
    ],
  },
  {
    key: 'support',
    label: 'Support',
    icon: Headphones,
    blurb: 'Traces a ticket from logs to Stripe to a fix and a reply.',
    asks: [
      { text: "what's going on with john@acme.com? he can't load the app", agent: 'support' },
      { text: "summarize this week's tickets and file the top 3 bugs in Linear", agent: 'support' },
      { text: 'draft a reply to this escalation', agent: 'support' },
    ],
  },
  {
    key: 'hr',
    label: 'HR / Onboarding',
    icon: UserRound,
    blurb: 'Owns onboarding and answers the team from your handbook.',
    asks: [
      { text: 'build an onboarding plan for the new eng hire', agent: 'people' },
      { text: 'answer the team’s PTO and policy questions from the handbook', agent: 'people' },
      { text: 'draft the offer letter', agent: 'people' },
    ],
  },
  {
    key: 'it',
    label: 'IT',
    icon: ServerCog,
    blurb: 'Provisions, rotates and audits access across every tool.',
    asks: [
      { text: 'provision access for the new hire across our tools', agent: 'it-ops' },
      { text: 'rotate the leaked key and open a PR', agent: 'it-ops' },
      { text: 'audit who has admin on what', agent: 'it-ops' },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting',
    icon: Banknote,
    blurb: 'Closes the books — reconciled, categorized, narrated.',
    asks: [
      {
        text: 'close the month: reconcile QuickBooks vs Stripe and post the P&L',
        agent: 'accounting',
      },
      { text: "categorize this month's expenses", agent: 'accounting' },
      { text: 'reconcile the bank feed', agent: 'accounting' },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    icon: PiggyBank,
    blurb: 'Watches churn, runway and the metrics that matter — live.',
    asks: [
      {
        text: "who's about to churn? cross Stripe and usage and give me the at-risk list",
        agent: 'finance',
      },
      { text: 'build the board-metrics dashboard and deploy it', agent: 'finance' },
      { text: "what's our runway and burn this month?", agent: 'finance' },
    ],
  },
];

function AskRow({ ask }: { ask: Ask }) {
  return (
    <div className="border-border flex items-start gap-3 border-b py-4 first:pt-0 last:border-b-0">
      <span className="bg-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm">
        <KortixLogo size={11} className="text-background" />
      </span>
      <p className="text-foreground min-w-0 flex-1 text-sm leading-relaxed sm:text-base">
        <span className="text-muted-foreground font-medium">@Kortix</span> {ask.text}
      </p>
      <span className="border-border text-muted-foreground mt-px hidden shrink-0 rounded-full border px-2.5 py-1 font-mono text-xs sm:inline-flex">
        {ask.agent}
      </span>
    </div>
  );
}

export function UseCasesByDepartment() {
  return (
    <section id="use-cases" className={sectionShell}>
      <Reveal>
        <div className="mb-10 max-w-2xl space-y-3">
          <Badge variant="kortix" className="rounded">
            What can Kortix do?
          </Badge>
          <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
            One coworker for every department.
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed">
            Real, one-off asks you&apos;d send Kortix in chat — each handled by an agent that runs
            it end to end. Pick a team.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.05}>
        <Tabs defaultValue={DEPARTMENTS[0].key} className="gap-0">
          <div className="-mx-6 overflow-x-auto px-6 pb-1 lg:mx-0 lg:px-0">
            <TabsList
              variant="secondary"
              className="h-auto w-max flex-nowrap gap-1 rounded-full p-1"
            >
              {DEPARTMENTS.map((dept) => {
                const Icon = dept.icon;
                return (
                  <TabsTrigger
                    key={dept.key}
                    value={dept.key}
                    variant="a_accent-i_outline"
                    className="h-9 shrink-0 rounded-full px-4"
                  >
                    <Icon className="size-3.5" />
                    {dept.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          {DEPARTMENTS.map((dept) => (
            <TabsContent key={dept.key} value={dept.key} className="mt-6">
              <div
                className={cn(
                  'border-border bg-card grid overflow-hidden rounded-2xl border',
                  'lg:grid-cols-12',
                )}
              >
                <div className="border-border flex flex-col justify-between gap-6 p-6 max-lg:border-b md:p-8 lg:col-span-4 lg:border-r lg:border-b-0">
                  <div className="space-y-4">
                    <span className="border-border bg-background text-foreground flex size-11 items-center justify-center rounded-xl border">
                      <dept.icon className="size-5" />
                    </span>
                    <div>
                      <h3 className="text-foreground text-xl font-medium tracking-tight">
                        {dept.label}
                      </h3>
                      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                        {dept.blurb}
                      </p>
                    </div>
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">
                    {dept.asks.length} of many · runs in its own sandbox
                  </p>
                </div>

                <div className="p-6 md:p-8 lg:col-span-8">
                  {dept.asks.map((ask) => (
                    <AskRow key={ask.text} ask={ask} />
                  ))}
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </Reveal>
    </section>
  );
}

export default UseCasesByDepartment;
