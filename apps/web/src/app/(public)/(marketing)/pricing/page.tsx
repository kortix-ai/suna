'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import KortixGrid from '@/components/ui/marketing/gridder';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

const START_URL = '/auth';
const DEMO_URL = '/enterprise';

const PLAN_CTAS: Record<(typeof PRICING_PLANS)[number]['id'], { cta: string; href: string }> = {
  free: { cta: 'Start free', href: START_URL },
  team: { cta: 'Get started', href: START_URL },
  enterprise: { cta: 'Contact sales', href: DEMO_URL },
};

const CREDIT_POINTS: { title: string; body: string }[] = [
  {
    title: 'Free credits are for sandboxes',
    body: 'Free includes 500 credits for Agent Computer runtime. Those credits do not pay for managed LLM calls.',
  },
  {
    title: 'Use the models you already pay for',
    body: 'Run free OpenCode models, bring your own API key, or connect your ChatGPT subscription for premium model access.',
  },
  {
    title: 'Compute by the second',
    body: 'Agent Computers run about $0.10/hour and auto-stop when idle, so you never pay for a machine sitting still.',
  },
];

const CREDIT_EXAMPLES: { label: string; body: string }[] = [
  { label: 'Free start', body: '500 credits covers sandbox runtime for early projects and demos.' },
  {
    label: 'Bring your model',
    body: 'Use BYOK or ChatGPT subscription when you want premium models without using Kortix credits.',
  },
  {
    label: 'Team scale',
    body: 'Upgrade when you want managed frontier models, pooled credits, and seats for the whole team.',
  },
];

const FAQ: [string, string][] = [
  [
    'What does Free include?',
    'Free includes 500 credits each month for sandbox compute. You can run free OpenCode models, bring your own API key, or connect your ChatGPT subscription. Managed Claude, GPT, and Gemini on Kortix keys are paid.',
  ],
  [
    'What does a Team seat include?',
    '$40/seat/month includes $20 of pooled usage credits, managed frontier models, and seats for the people on your team. Add seats anytime; credits scale with them.',
  ],
  [
    'How are models and compute priced?',
    'Free credits are sandbox-only. Team credits cover managed models and compute from one wallet. Bring your own key or connect ChatGPT and you pay the provider directly. Agent-Computer compute is about $0.10/hour, billed by the second and $0 while stopped.',
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
            {tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxTextSimplePerSeat194cf521')}
          </h1>
          <p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-lg text-balance">
            {tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxTextEverySeatGets58d131e8')}
          </p>
        </div>

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div className="mx-auto grid max-w-5xl gap-4 pt-16 md:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
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
