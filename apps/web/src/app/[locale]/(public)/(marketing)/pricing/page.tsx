'use client';

import { Reveal } from '@/components/home/reveal';
import Link from '@/components/site-link';
import { Button } from '@/components/ui/marketing/button';
import SectionHeader from '@/features/marketing/component/section-header';
import {
  agentHoursForCredits,
  COMPUTE_RATES_USD,
  DEFAULT_COMPUTE_CREDITS_PER_HOUR,
  DEFAULT_COMPUTE_SPEC,
  DEFAULT_TIER_USD,
  formatWholeUsd,
  FREE_MONTHLY_CREDITS,
  MINUTES_PER_CREDIT,
  monthlyCreditsForUsd,
  PLATFORM_FEE_PERCENT,
  TOP_UP_BONUS_STEPS,
} from '@/features/billing/compute-pricing';
import { CreditTierSelect } from '@/features/billing/credit-tier-select';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan, PricingPlanId } from '@/features/billing/pricing-plans';
import { usePricingPlans } from '@/features/billing/use-pricing-plans';
import { FaqSection, type FaqItem } from '@/features/marketing/faq';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  ArrowRightIcon,
  BrainIcon,
  CheckCircleIcon,
  CpuIcon,
  GlobeHemisphereWestIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';
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
  'models',
  'topup',
  'change',
  'existing',
  'enterprise',
] as const;

/** The compute rate card rows, in display order. */
const RATE_ROWS = [
  { id: 'vcpu', usd: COMPUTE_RATES_USD.vcpuHour },
  { id: 'memory', usd: COMPUTE_RATES_USD.memoryGbHour },
  { id: 'disk', usd: COMPUTE_RATES_USD.diskGbMonth },
] as const;

/** `$0.0324` — a rate in USD with up to four decimals. */
function formatRateUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
}

/**
 * What every plan gets with managed models. Each claim traces to the gateway
 * routes in packages/llm-catalog (`OPENROUTER_POOL_PRIVACY`, the US endpoint
 * pins) and to kortix-brand `claims.md`; change them together.
 */
const HIGHLIGHTS = [
  { id: 'managed', icon: CpuIcon },
  { id: 'zdr', icon: ShieldCheckIcon },
  { id: 'us', icon: GlobeHemisphereWestIcon },
  { id: 'open', icon: BrainIcon },
] as const;

/** "Models are separate": the three ways a model call is paid, in display order. */
const MODEL_SOURCES = ['keys', 'chatgpt', 'kortix'] as const;

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
  const locale = useLocale();
  const plans = usePricingPlans();

  // Every number on this page comes from compute-pricing.ts, so the page
  // cannot drift from the billing code.
  const tierCredits = monthlyCreditsForUsd(DEFAULT_TIER_USD);
  const bonusSmallest = TOP_UP_BONUS_STEPS[TOP_UP_BONUS_STEPS.length - 1];
  const bonusLargest = TOP_UP_BONUS_STEPS[0];
  const facts = {
    creditsPerHour: DEFAULT_COMPUTE_CREDITS_PER_HOUR,
    minutes: MINUTES_PER_CREDIT,
    spec: DEFAULT_COMPUTE_SPEC,
    fee: PLATFORM_FEE_PERCENT,
    tierUsd: formatWholeUsd(DEFAULT_TIER_USD, locale),
    hours: new Intl.NumberFormat(locale).format(agentHoursForCredits(tierCredits)),
    smallestBonus: bonusSmallest.percent,
    smallestBonusUsd: formatWholeUsd(bonusSmallest.minUsd, locale),
    largestBonus: bonusLargest.percent,
    largestBonusUsd: formatWholeUsd(bonusLargest.minUsd, locale),
    vcpuRate: formatRateUsd(COMPUTE_RATES_USD.vcpuHour, locale),
    memoryRate: formatRateUsd(COMPUTE_RATES_USD.memoryGbHour, locale),
    diskRate: formatRateUsd(COMPUTE_RATES_USD.diskGbMonth, locale),
  };
  const faq: readonly FaqItem[] = FAQ_IDS.map((id) => ({
    id,
    question: t(`faq.${id}.question`),
    answer: t(`faq.${id}.answer`, facts),
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

        {/* ── Managed models, on every plan ────────────────────── */}
        <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {HIGHLIGHTS.map(({ id, icon: Icon }) => (
            <li key={id} className="bg-card flex flex-col gap-2 rounded-lg border p-6">
              <Icon className="text-foreground size-5" />
              <div className="text-foreground text-sm font-medium">
                {t(`highlights.${id}.title`)}
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                {t(`highlights.${id}.body`)}
              </p>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Agent hours: what one credit buys ────────────────── */}
      <section className="mx-auto max-w-7xl px-4 pt-24 md:pt-30">
        <SectionHeader
          eyebrow={t('hours.eyebrow')}
          title={t('hours.title', facts)}
          description={t('hours.description', facts)}
        />
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {(['rate', 'hour', 'tier'] as const).map((id, index) => (
            <Reveal key={id} delay={0.04 * index}>
              <div className="bg-card flex h-full flex-col gap-3 rounded-lg border p-6">
                <div className="text-2xl font-medium tracking-tight text-balance tabular-nums sm:text-3xl">
                  {t(`hours.${id}.value`, facts)}
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                  {t(`hours.${id}.note`, facts)}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <div className="bg-card mt-6 rounded-lg border p-6">
          <div className="text-foreground text-sm font-medium">{t('hours.rates.title')}</div>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">{t('hours.rates.note')}</p>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            {RATE_ROWS.map(({ id, usd }) => (
              <div key={id} className="flex flex-col gap-1">
                <dt className="text-muted-foreground font-mono text-xs uppercase">
                  {t(`hours.rates.${id}.label`)}
                </dt>
                <dd className="text-lg font-medium tabular-nums">
                  {t(`hours.rates.${id}.price`, { price: formatRateUsd(usd, locale) })}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Models are separate ──────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 pt-24 md:pt-30">
        <SectionHeader
          eyebrow={t('models.eyebrow')}
          title={t('models.title')}
          description={t('models.description')}
        />
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {MODEL_SOURCES.map((id, index) => (
            <Reveal key={id} delay={0.04 * index}>
              <div className="bg-card flex h-full flex-col gap-3 rounded-lg border p-6">
                <div className="text-muted-foreground font-mono text-xs uppercase">
                  {t(`models.${id}.tag`)}
                </div>
                <div className="text-lg font-medium tracking-tight">{t(`models.${id}.title`)}</div>
                <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                  {t(`models.${id}.body`, facts)}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="text-foreground mt-6 text-base font-medium text-balance">
          {t('models.summary')}
        </p>
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
