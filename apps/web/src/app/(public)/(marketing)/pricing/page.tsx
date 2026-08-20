'use client';

import { Button } from '@/components/ui/marketing/button';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import { FaqSection, type FaqItem } from '@/features/marketing/faq';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

const START_URL = '/auth';
const DEMO_URL = '/enterprise';

// Keyed by MARKETING plan id (display-only — see pricing-plans.ts). Never an
// API tier key.
const PLAN_CTAS: Record<(typeof PRICING_PLANS)[number]['id'], { cta: string; href: string }> = {
  free: { cta: 'Get started', href: START_URL },
  team_seat: { cta: 'Get started', href: START_URL },
  enterprise: { cta: 'Request demo', href: DEMO_URL },
};

const CREDIT_POINTS: { title: string; body: string }[] = [
  {
    title: 'Free credits are for sandboxes',
    body: 'Free includes 200 credits each month for Agent Computer runtime. Those credits do not pay for managed LLM calls.',
  },
  {
    title: 'Keep model billing with your provider',
    body: 'Bring your own API key or connect ChatGPT. You pay your model provider directly and keep Kortix credits for Agent Computer runtime.',
  },
  {
    title: 'Compute by the second',
    body: 'Billed per resource, per second: $0.0000168/vCPU, $0.0000054/GiB RAM, $0.000000036/GiB storage. The default 2 vCPU / 4 GiB / 20 GiB machine runs about $0.20/hour, and auto-stops when idle so you pay $0 the moment it’s not running.',
  },
];

const FAQ: readonly FaqItem[] = [
  {
    id: 'free-include',
    question: 'What does Free include?',
    answer:
      'Free includes 200 credits each month for sandbox compute and 1 project. Bring your own API key or connect your ChatGPT subscription for premium access. Managed Claude, GPT, and Gemini on Kortix keys are paid.',
  },
  {
    id: 'team-seat-include',
    question: 'What does a Team seat include?',
    answer:
      '$40/seat/month includes 2,500 pooled credits per seat, optional managed model access, and seats for the people on your team. Agent Computer runtime and managed model token usage draw from the same pool.',
  },
  {
    id: 'models-and-compute',
    question: 'How are models and compute priced?',
    answer:
      'Agent Computer compute is billed per second, per resource — $0.0000168/vCPU, $0.0000054/GiB RAM, $0.000000036/GiB storage — about $0.20/hour for the default 2 vCPU / 4 GiB / 20 GiB machine, and $0 while stopped. Bring your own key or connect ChatGPT to pay your model provider directly. If you choose Kortix-managed models, their input, output, and cached tokens use Team credits at that model’s rate. Free credits remain sandbox-only.',
  },
  {
    id: 'seat-or-usage',
    question: 'Do I pay per seat or per usage?',
    answer:
      'Both. The seat is a flat monthly fee that includes credits. Top up only when Agent Computer runtime or optional managed model usage exhausts the pooled balance.',
  },
  {
    id: 'enterprise',
    question: 'What about Enterprise?',
    answer:
      'Everything in Team plus SAML SSO, SCIM directory sync (Okta, Microsoft Entra, JumpCloud), advanced RBAC, audit logs, an SLA and DPA, and Cloud / VPC / on-prem deployment. Talk to us for volume pricing.',
  },
];

function PlanCard({ plan }: { plan: (typeof PRICING_PLANS)[number] }) {
  const { cta, href } = PLAN_CTAS[plan.id];

  return (
    <PricingPlanCard
      plan={plan}
      action={
        <Button
          variant={plan.highlight ? 'default' : 'outline'}
          size="lg"
          className="w-full"
          asChild
        >
          <Link href={href}>{cta} </Link>
        </Button>
      }
    />
  );
}

export default function PricingPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const headline = String(
    tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxTextSimplePerSeat194cf521'),
  );
  const punct = headline.search(/[.。]/);
  const lead = punct >= 0 ? headline.slice(0, punct + 1) : headline;
  const rest = punct >= 0 ? headline.slice(punct + 1).trim() : '';

  return (
    <div className="bg-background relative pt-28 sm:pt-40">
      <div className="mx-auto max-w-7xl px-4">
        <div className="mx-auto text-left">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            <span className="text-muted-foreground">{lead}</span>
            {rest ? (
              <>
                <br />
                <span className="text-foreground">{rest}</span>
              </>
            ) : null}
          </h1>
        </div>

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div className="mx-auto grid max-w-7xl gap-6 pt-16 md:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      </div>

      <FaqSection
        eyebrow="Frequently asked questions"
        title={tI18nHardcoded.raw(
          'autoAppPublicMarketingPricingPageJsxTextPricingQuestionsa7129c6e',
        )}
        items={FAQ}
      />
    </div>
  );
}
