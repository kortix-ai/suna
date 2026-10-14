'use client';

import { Reveal } from '@/components/home/reveal';
import Link from '@/components/site-link';
import { Button } from '@/components/ui/marketing/button';
import SectionHeader from '@/features/marketing/component/section-header';
import {
  DEFAULT_COMPUTE_CREDITS_PER_HOUR,
  DEFAULT_TIER_USD,
  FREE_MONTHLY_CREDITS,
} from '@/features/billing/compute-pricing';
import { CreditTierSelect } from '@/features/billing/credit-tier-select';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan, PricingPlanId } from '@/features/billing/pricing-plans';
import { usePricingPlans } from '@/features/billing/use-pricing-plans';
import { FaqSection, type FaqItem } from '@/features/marketing/faq';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import { ArrowRightIcon, CheckCircleIcon } from '@phosphor-icons/react';
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

/**
 * "What credits power": the three sizes of work. The ranges come from measured
 * session cost (SESSION_CREDITS_* in compute-pricing.ts): median 6, p90 121.
 */
const WORK_SIZES = ['quick', 'task', 'long'] as const;

/** "How credits work". */
const HOW_IDS = ['rate', 'keys', 'compute'] as const;

function PlanCard({ plan }: { plan: PricingPlan }) {
  const { cta, href } = useLocalizedUiCatalog(PLAN_CTAS)[plan.id];
  const [monthlyUsd, setMonthlyUsd] = useState<number>(DEFAULT_TIER_USD);

  return (
    <PricingPlanCard
      plan={plan}
      priceSlot={
        plan.id === 'credits' ? (
          <CreditTierSelect value={monthlyUsd} onChange={setMonthlyUsd} />
        ) : undefined
      }
      action={
        <Button
          variant={plan.highlight ? 'default' : 'outline'}
          size="lg"
          className="w-full"
          asChild
        >
          <Link href={href}>{cta}</Link>
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

  return (
    <div className="bg-background relative pt-28 sm:pt-40">
      {/* ── Hero: the free offer first, as the reader's first question ─── */}
      <div className="mx-auto max-w-7xl px-4">
        <p className="text-muted-foreground font-mono text-xs uppercase">{t('hero.eyebrow')}</p>
        <h1 className="mt-4 max-w-3xl text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
          {t('hero.title')}
        </h1>
        <ul className="text-muted-foreground mt-6 flex flex-col gap-2 text-base sm:flex-row sm:gap-6">
          {(['b1', 'b2', 'b3'] as const).map((id) => (
            <li key={id} className="flex items-center gap-2">
              <CheckCircleIcon weight="fill" className="text-foreground size-4 shrink-0" />
              {t(`hero.${id}`, { credits: FREE_MONTHLY_CREDITS })}
            </li>
          ))}
        </ul>

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div className="mx-auto grid max-w-7xl gap-6 pt-12 md:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      </div>

      {/* ── What credits power ───────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 pt-24 md:pt-30">
        <SectionHeader
          eyebrow={t('power.eyebrow')}
          title={t('power.title')}
          description={t('power.description')}
        />
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {WORK_SIZES.map((size, index) => (
            <Reveal key={size} delay={0.04 * index}>
              <div className="bg-card flex h-full flex-col gap-3 rounded-lg border p-6">
                <div className="text-muted-foreground font-mono text-xs uppercase">
                  {t(`power.${size}.credits`)}
                </div>
                <div className="text-lg font-medium tracking-tight">{t(`power.${size}.title`)}</div>
                <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                  {t(`power.${size}.example`)}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="text-muted-foreground mt-4 text-xs">{t('power.source')}</p>
      </section>

      {/* ── How credits work ─────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 pt-24 md:pt-30">
        <SectionHeader eyebrow={t('how.eyebrow')} title={t('how.title')} />
        <div className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-3">
          {HOW_IDS.map((id) => (
            <div key={id} className="space-y-2">
              <div className="text-base font-medium tracking-tight">{t(`how.${id}.title`)}</div>
              <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                {t(`how.${id}.body`, { creditsPerHour: DEFAULT_COMPUTE_CREDITS_PER_HOUR })}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-10">
          <Button size="lg" asChild className="group">
            <Link href={START_URL}>
              {t('hero.cta')}
              <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>
      </section>

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
