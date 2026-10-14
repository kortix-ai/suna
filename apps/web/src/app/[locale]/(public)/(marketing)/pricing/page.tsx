'use client';

import Link from '@/components/site-link';
import { Button } from '@/components/ui/marketing/button';
import { CreditPlanPicker } from '@/features/billing/credit-plan-picker';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan, PricingPlanId } from '@/features/billing/pricing-plans';
import { usePricingPlans } from '@/features/billing/use-pricing-plans';
import { FaqSection, type FaqItem } from '@/features/marketing/faq';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

const START_URL = '/auth';
const DEMO_URL = '/enterprise';

// Keyed by MARKETING plan id (display-only — see pricing-plans.ts). Never an
// API tier key.
const PLAN_CTAS: Record<PricingPlanId, { cta: string; href: string }> = {
  free: { cta: 'Get started', href: START_URL },
  credits: { cta: 'Get started', href: START_URL },
  enterprise: { cta: 'Request demo', href: DEMO_URL },
};

/** The FAQ ids, in display order. Question and answer live in `billing.pricing.faq.<id>`. */
const FAQ_IDS = [
  'free',
  'credit',
  'amounts',
  'members',
  'rollover',
  'topup',
  'change',
  'existing',
  'enterprise',
] as const;

function PlanCard({ plan }: { plan: PricingPlan }) {
  const { cta, href } = useLocalizedUiCatalog(PLAN_CTAS)[plan.id];
  const t = useTranslations('billing.credits.planCard');
  // Pro, so the card opens on the amount most teams start from.
  const [monthlyUsd, setMonthlyUsd] = useState<number | null>(100);

  return (
    <PricingPlanCard
      plan={plan}
      priceSlot={
        plan.id === 'credits' ? (
          <div className="space-y-3">
            <CreditPlanPicker value={monthlyUsd} onChange={setMonthlyUsd} />
            <p className="text-muted-foreground text-xs text-balance">{t('rate')}</p>
          </div>
        ) : undefined
      }
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
  const t = useTranslations('billing.pricing');
  const plans = usePricingPlans();
  const faq: readonly FaqItem[] = FAQ_IDS.map((id) => ({
    id,
    question: t(`faq.${id}.question`),
    answer: t(`faq.${id}.answer`),
  }));
  const headline = t('headline');
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
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
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
