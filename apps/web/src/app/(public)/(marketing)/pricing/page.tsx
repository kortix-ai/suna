'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { cn } from '@/lib/utils';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

const START_URL = '/auth';
const DEMO_URL = '/enterprise';

type Plan = {
  name: string;
  price: string;
  unit?: string;
  note: string;
  cta: string;
  href: string;
  highlight?: boolean;
  badge?: string;
  features: string[];
};

const PLANS: Plan[] = [
  {
    name: 'Team',
    price: '$40',
    unit: '/ seat / mo',
    note: 'For teams running real work on agents.',
    cta: 'Get started',
    href: START_URL,
    highlight: true,
    badge: 'Most popular',
    features: [
      '$20 of usage credits per seat, pooled',
      'Every frontier model included',
      'Up to 200 projects, up to 100 seats',
      'Top up credits anytime',
      'Standard support',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    note: 'Scale, security, and your deployment.',
    cta: 'Contact sales',
    href: DEMO_URL,
    features: [
      'Everything in Team',
      'SAML SSO + SCIM directory sync',
      'Advanced RBAC + audit logs',
      'Cloud, VPC, or on-prem',
      'SLA, DPA & dedicated support',
    ],
  },
];

// Plain-language, Viktor-style. Keeps the only two facts that matter (models at
// +20%, compute ~$0.10/hr) without a rate card.
const CREDIT_POINTS: { title: string; body: string }[] = [
  {
    title: 'One wallet, in plain dollars',
    body: 'Credits cover models and Agent Computers from a single balance. No tokens to decode — spend shows up in dollars.',
  },
  {
    title: 'Models at cost + 20%',
    body: 'Every model is billed at its provider’s price plus a flat 20%. Bring your own key and you pay the provider directly — $0 to us.',
  },
  {
    title: 'Compute by the second',
    body: 'Agent Computers run about $0.10/hour and auto-stop when idle, so you never pay for a machine sitting still.',
  },
];

const CREDIT_EXAMPLES: { label: string; body: string }[] = [
  { label: 'A quick task', body: 'Summarize a thread or fix a small bug — a few cents.' },
  {
    label: 'A working session',
    body: 'An agent coding for an hour — around $0.10 of compute plus model calls.',
  },
  {
    label: 'A full project',
    body: 'Research and ship across many steps — scales with the work, not a flat fee.',
  },
];

const FAQ: [string, string][] = [
  [
    'What does a Team seat include?',
    '$40/seat/month includes $20 of usage credits (pooled across your workspace) and every frontier model with no key to set up. Add seats anytime; credits scale with them.',
  ],
  [
    'How are models and compute priced?',
    'Every model is its provider’s list price plus a flat 20% — our only margin on inference. Bring your own key and you pay the provider directly. Agent-Computer compute is about $0.10/hour, billed by the second and $0 while stopped.',
  ],
  [
    'Do I pay per seat or per usage?',
    'Both. The seat is a flat monthly fee that already includes credits; if your team runs heavy, top up credits on top. A light month costs just the seats.',
  ],
  [
    'What about Enterprise?',
    'Everything in Team plus SAML SSO, SCIM directory sync (Okta, Microsoft Entra, JumpCloud), advanced RBAC, audit logs, an SLA and DPA, and Cloud / VPC / on-prem deployment. Talk to us for volume pricing.',
  ],
];

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-6 rounded-xl border p-8',
        plan.highlight &&
          'ring-border bg-border/60 dark:bg-card relative shadow-xl ring-1 shadow-black/6.5 backdrop-blur',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-medium tracking-tight">{plan.name}</div>
          <div className="text-muted-foreground mt-1 text-sm text-balance">{plan.note}</div>
        </div>
        {plan.badge && (
          <Badge variant="update" className="rounded-full">
            {plan.badge}
          </Badge>
        )}
      </div>

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-4xl" style={{ fontKerning: 'none' }}>
          {plan.price}
        </span>
        {plan.unit && <span className="text-muted-foreground text-sm">{plan.unit}</span>}
      </div>

      <Button variant={plan.highlight ? 'default' : 'outline'} asChild>
        <Link href={plan.href}>{plan.cta}</Link>
      </Button>

      <ul role="list" className="flex flex-col space-y-3 text-left text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start justify-start gap-2 first:font-medium">
            <Check className="text-foreground mt-0.5 size-4 shrink-0" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PricingPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="bg-background relative pt-28 sm:pt-40">
      <div className="mx-auto max-w-5xl px-4 md:px-0">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <div className="mx-auto text-center">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:text-5xl lg:tracking-tight">
            {tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxTextSimplePerSeat194cf521')}
          </h1>
          <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-lg text-balance">
            {tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxTextEverySeatGets907db6fe')}
          </p>
        </div>

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div className="mx-auto grid max-w-3xl gap-4 pt-16 md:grid-cols-2">
          {PLANS.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </div>

        {/* ── How credits work ─────────────────────────────────── */}
        <section className="border-border/50 mt-24 border-t pt-16">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
              {tI18nHardcoded.raw(
                'autoAppPublicMarketingPricingPageJsxTextCreditsPowerEverything0f094b3e',
              )}
            </h2>
            <p className="text-muted-foreground mt-3 text-balance">
              {tI18nHardcoded.raw(
                'autoAppPublicMarketingPricingPageJsxTextOneSimpleBalancef877f3a6',
              )}
            </p>
          </div>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {CREDIT_POINTS.map((p) => (
              <div key={p.title} className="space-y-2">
                <div className="text-foreground text-sm font-medium">{p.title}</div>
                <p className="text-muted-foreground text-sm leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 grid gap-3 md:grid-cols-3">
            {CREDIT_EXAMPLES.map((e) => (
              <div key={e.label} className="border-border bg-card rounded-lg border p-5">
                <div className="text-foreground text-sm font-medium">{e.label}</div>
                <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{e.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────── */}
        <section className="border-border/50 mt-20 border-t px-4 py-16 sm:py-24">
          <div className="space-y-8">
            <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
              {tI18nHardcoded.raw(
                'autoAppPublicMarketingPricingPageJsxTextPricingQuestionsa7129c6e',
              )}
            </h2>
            <div className="divide-border divide-y">
              {FAQ.map(([q, a]) => (
                <div key={q} className="py-5">
                  <h3 className="text-foreground text-sm font-semibold">{q}</h3>
                  <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* ── CTA footer ─────────────────────────────────────────── */}
      <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 xl:px-0">
        <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
          <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
            <div className="col-span-4 flex flex-col items-start justify-start p-6 *:text-left">
              <div className="space-y-2">
                <Badge variant="update" className="rounded">
                  {tI18nHardcoded.raw(
                    'autoAppPublicMarketingPricingPageJsxTextStartBuilding8d5b4add',
                  )}
                </Badge>
                <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                  {tI18nHardcoded.raw(
                    'autoAppPublicMarketingPricingPageJsxTextGetYourTeam34f94a76',
                  )}
                </h2>
                <p className="text-muted-foreground mt-6 pb-8 text-sm leading-relaxed">
                  {tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxText40PerSeat60546e3a')}
                </p>
              </div>

              <div className="mt-auto grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                <Button size="lg" className="w-full" variant="outline" asChild>
                  <Link href={DEMO_URL}>
                    {tI18nHardcoded.raw(
                      'autoAppPublicMarketingPricingPageJsxTextContactSales8f878231',
                    )}
                    <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
                <Button asChild size="lg" className="w-full" variant="accent">
                  <Link href={START_URL}>
                    {tI18nHardcoded.raw(
                      'autoAppPublicMarketingPricingPageJsxTextGetStarted9675943d',
                    )}
                  </Link>
                </Button>
              </div>
            </div>
            <div className="col-span-8 mask-y-from-90% mask-x-from-90%">
              <KortixGrid count={45} cols={8} seed={4622} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
