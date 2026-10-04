'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { BeamsBackdrop } from '@/components/ui/paper-wallpaper-shaders';
import { PillLink } from '@/features/marketing/os/primitives';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import { FaqSection, type FaqItem } from '@/features/marketing/faq';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';

const START_URL = '/auth';
const DEMO_URL = '/enterprise';

// Keyed by MARKETING plan id (display-only — see pricing-plans.ts). Never an
// API tier key.
const PLAN_CTAS: Record<(typeof PRICING_PLANS)[number]['id'], { cta: string; href: string }> = {
  free: { cta: 'Get started', href: START_URL },
  team_seat: { cta: 'Get started', href: START_URL },
  enterprise: { cta: 'Request demo', href: DEMO_URL },
};

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
  const { cta, href } = useLocalizedUiCatalog(PLAN_CTAS)[plan.id];

  return (
    <PricingPlanCard
      plan={plan}
      action={
        <PillLink
          tone={plan.highlight ? 'solid' : 'outline'}
          className="w-full justify-center"
          href={href}
        >
          {cta}
        </PillLink>
      }
    />
  );
}

export default function PricingPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const faq = useLocalizedUiCatalog(FAQ);
  const headline = String(
    tI18nHardcoded.raw('autoAppPublicMarketingPricingPageJsxTextSimplePerSeat194cf521'),
  );
  const punct = headline.search(/[.。]/);
  const lead = punct >= 0 ? headline.slice(0, punct + 1) : headline;
  const rest = punct >= 0 ? headline.slice(punct + 1).trim() : '';

  return (
    <div className="bg-background relative">
      <section
        data-kx-dark-hero=""
        className="dark bg-background text-foreground relative isolate flex min-h-[50svh] items-center overflow-hidden px-6 pt-40 pb-24"
      >
        <div className="kx-hero-veil absolute inset-0 -z-10" aria-hidden>
          <BeamsBackdrop fade="hero" />
        </div>
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-6 text-center">
          <KortixLogo size={16} />
          <h1 className="kx-hero-text text-4xl font-normal tracking-tight text-balance sm:text-6xl">
            <span className="text-foreground">{lead}</span>
            {rest ? (
              <>
                <br />
                <span className="text-foreground/75">{rest}</span>
              </>
            ) : null}
          </h1>
        </div>
      </section>

      <div className="relative z-10 mx-auto grid max-w-7xl gap-6 px-6 pt-16 pb-12 md:grid-cols-3">
        {PRICING_PLANS.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
      </div>

      <FaqSection
        eyebrow={tI18nHardcoded.raw('i18nComplete.texte956a9404b46')}
        title={tI18nHardcoded.raw(
          'autoAppPublicMarketingPricingPageJsxTextPricingQuestionsa7129c6e',
        )}
        items={faq}
      />
    </div>
  );
}
