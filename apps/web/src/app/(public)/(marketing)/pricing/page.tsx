'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { ComputeCreditCalculator } from '@/features/billing/compute-credit-calculator';
import {
  CREDITS_PER_USD,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  estimateDefaultCompute,
  TEAM_CREDITS_PER_SEAT,
} from '@/features/billing/compute-pricing';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

const START_URL = '/auth';
const DEMO_URL = '/enterprise';

// Rounded marketing rate: the headline says $0.20/hour, so the hour
// equivalences on this page divide by the same rounded rate (10 h / 125 h),
// matching the calculator and plan copy instead of drifting to 124 h.
const ROUNDED_HOURLY_USD = Number(DEFAULT_COMPUTE_HOURLY_PRICE_USD.toFixed(2));
const HOURLY_PRICE = `$${ROUNDED_HOURLY_USD.toFixed(2)}`;
const HOURLY_CREDITS = Math.round(DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD);
const FREE_MONTHLY_CREDITS = 200;
const FREE_MONTHLY_HOURS = Math.round(
  estimateDefaultCompute(FREE_MONTHLY_CREDITS).creditValueUsd / ROUNDED_HOURLY_USD,
);
const SEAT_MONTHLY_HOURS = Math.round(
  estimateDefaultCompute(TEAM_CREDITS_PER_SEAT).creditValueUsd / ROUNDED_HOURLY_USD,
);

const PLAN_CTAS: Record<(typeof PRICING_PLANS)[number]['id'], { cta: string; href: string }> = {
  free: { cta: 'Get started', href: START_URL },
  team: { cta: 'Get started', href: START_URL },
  enterprise: { cta: 'Request demo', href: DEMO_URL },
};

const HOURLY_FACTS: { title: string; body: string }[] = [
  {
    title: 'Billed by the second',
    body: `Per-second metering on vCPU, RAM, and storage. An hour on the default machine is about ${HOURLY_CREDITS} credits (${HOURLY_PRICE}).`,
  },
  {
    title: '$0 while idle',
    body: 'Auto-stop pauses the computer the moment it is not working. Stopped time costs nothing.',
  },
  {
    title: 'Same rate on every plan',
    body: `Free and Team credits buy the same compute. ${FREE_MONTHLY_CREDITS} free credits run about ${FREE_MONTHLY_HOURS} hours; each Team seat adds ${TEAM_CREDITS_PER_SEAT.toLocaleString('en-US')} credits, about ${SEAT_MONTHLY_HOURS} hours.`,
  },
];

const CREDIT_POINTS: { title: string; body: string }[] = [
  {
    title: 'Compute by the second',
    body: 'Billed per resource, per second: $0.0000168/vCPU, $0.0000054/GiB RAM, $0.000000036/GiB storage. The default 2 vCPU / 4 GiB / 20 GiB machine runs about $0.20/hour, and auto-stops when idle so you pay $0 the moment it’s not running.',
  },
  {
    title: 'Keep model billing with your provider',
    body: 'Bring your own API key or connect ChatGPT. You pay your model provider directly and keep Kortix credits for Agent Computer runtime.',
  },
  {
    title: 'Free credits are for sandboxes',
    body: 'Free includes 200 credits each month for Agent Computer runtime. Those credits do not pay for managed LLM calls.',
  },
];

const CREDIT_EXAMPLES: { label: string; body: string }[] = [
  { label: 'Free start', body: '200 credits covers sandbox runtime for early projects and demos.' },
  {
    label: 'Managed models are optional',
    body: 'Kortix-managed models remain available when you need them. Their token-based usage draws from pooled Team credits.',
  },
  {
    label: 'Team scale',
    body: 'Each Team seat includes 2,500 pooled credits. Used only for compute, that covers about 125 hours on the default Agent Computer.',
  },
];

const FAQ: [string, string][] = [
  [
    'How are models and compute priced?',
    'Agent Computer compute is billed per second, per resource — $0.0000168/vCPU, $0.0000054/GiB RAM, $0.000000036/GiB storage — about $0.20/hour for the default 2 vCPU / 4 GiB / 20 GiB machine, and $0 while stopped. Bring your own key or connect ChatGPT to pay your model provider directly. If you choose Kortix-managed models, their input, output, and cached tokens use Team credits at that model’s rate. Free credits remain sandbox-only.',
  ],
  [
    'What does Free include?',
    'Free includes 200 credits each month for sandbox compute — about 10 hours on the default Agent Computer — and 1 project. Bring your own API key or connect your ChatGPT subscription for premium access. Managed Claude, GPT, and Gemini on Kortix keys are paid.',
  ],
  [
    'What does a Team seat include?',
    '$40/seat/month includes 2,500 pooled credits per seat — about 125 hours on the default Agent Computer — optional managed model access, and seats for the people on your team. Agent Computer runtime and managed model token usage draw from the same pool.',
  ],
  [
    'Do I pay per seat or per usage?',
    'Both. The seat is a flat monthly fee that includes credits. Top up only when Agent Computer runtime or optional managed model usage exhausts the pooled balance.',
  ],
  [
    'What about Enterprise?',
    'Everything in Team plus SAML SSO, SCIM directory sync (Okta, Microsoft Entra, JumpCloud), advanced RBAC, audit logs, an SLA and DPA, and Cloud / VPC / on-prem deployment. Talk to us for volume pricing.',
  ],
];

function PlanCard({ plan }: { plan: (typeof PRICING_PLANS)[number] }) {
  const { cta, href } = PLAN_CTAS[plan.id];

  return (
    <PricingPlanCard
      plan={plan}
      action={
        <Button variant={plan.highlight ? 'default' : 'outline'} asChild>
          <Link href={href}>{cta}</Link>
        </Button>
      }
    />
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
            {tI18nHardcoded.raw(
              'autoAppPublicMarketingPricingPageJsxTextCreditsPowerEverything0f094b3e',
            )}
          </h1>
          <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-lg text-balance">
            Your agents work on real cloud computers, billed by the second. Bring your own API key
            or connect ChatGPT — model billing stays with your provider.
          </p>
        </div>

        {/* ── The price ────────────────────────────────────────── */}
        <div className="mx-auto mt-14 flex flex-col items-center text-center">
          <div className="flex items-baseline gap-2" style={{ fontKerning: 'none' }}>
            <span className="text-foreground text-7xl font-medium tracking-tight tabular-nums sm:text-8xl">
              {HOURLY_PRICE}
            </span>
            <span className="text-muted-foreground text-xl sm:text-2xl">/ hour</span>
          </div>
          <p className="text-muted-foreground mt-4 text-sm text-balance">
            One Agent Computer — 2 vCPU · 4 GiB RAM · 20 GiB storage
          </p>

          <div className="divide-border bg-card mt-10 grid w-full max-w-4xl grid-cols-1 divide-y rounded-md border text-left sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {HOURLY_FACTS.map((fact) => (
              <div key={fact.title} className="px-5 py-5">
                <div className="text-foreground text-sm font-medium">{fact.title}</div>
                <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed tabular-nums">
                  {fact.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div className="mx-auto grid max-w-5xl gap-4 pt-20 md:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>

        {/* ── How credits work ─────────────────────────────────── */}
        <section className="border-border/50 mt-24 border-t pt-16">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
              Credits are hours on the computer
            </h2>
            <p className="text-muted-foreground mt-3 text-balance">
              {tI18nHardcoded.raw(
                'autoAppPublicMarketingPricingPageJsxTextOneSimpleBalancef877f3a6',
              )}
            </p>
          </div>
          <div className="mt-10">
            <ComputeCreditCalculator />
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
      <section id="cta" className="relative mx-auto max-w-7xl px-6 py-16 sm:py-24 xl:px-0">
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
