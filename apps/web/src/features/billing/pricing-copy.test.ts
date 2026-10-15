import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

import { PRICING_FEATURE_COUNTS, PRICING_PLANS } from './pricing-plans';

const root = join(import.meta.dir, '../../..');
const locales = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es', 'sr'] as const;

type PricingCatalog = {
  billing: {
    pricing: {
      headline: string;
      plans: Record<string, Record<string, string>>;
      faq: Record<string, { question: string; answer: string }>;
      models: Record<string, any>;
    };
    credits: { planCard: { rate: string } };
  };
};

function catalog(locale: string): PricingCatalog {
  return JSON.parse(readFileSync(join(root, `translations/${locale}.json`), 'utf8'));
}

const english = catalog('en');
const pageSource = readFileSync(
  join(root, 'src/app/[locale]/(public)/(marketing)/pricing/page.tsx'),
  'utf8',
);

describe('pricing copy', () => {
  test('PRICING_PLANS (server-rendered SEO copy) equals the English catalog', () => {
    for (const plan of PRICING_PLANS) {
      const entry = english.billing.pricing.plans[plan.id];
      expect(entry.name).toBe(plan.name);
      expect(entry.note).toBe(plan.note);
      if (plan.unit) expect(entry.unit).toBe(plan.unit);
      if (plan.id === 'enterprise') expect(entry.price).toBe(plan.price);
      expect(plan.features).toEqual(
        Array.from({ length: PRICING_FEATURE_COUNTS[plan.id] }, (_, i) => entry[`f${i + 1}`]),
      );
      expect(entry[`f${PRICING_FEATURE_COUNTS[plan.id] + 1}`]).toBeUndefined();
    }
  });

  test('there are three plans: free, credits, enterprise', () => {
    expect(PRICING_PLANS.map((plan) => plan.id)).toEqual(['free', 'credits', 'enterprise']);
  });

  test('every FAQ id the page renders exists in every locale', () => {
    const faqIds = Object.keys(english.billing.pricing.faq);
    for (const id of faqIds) expect(pageSource).toContain(`'${id}'`);
    for (const locale of locales) {
      const faq = catalog(locale).billing.pricing.faq;
      expect(Object.keys(faq).sort()).toEqual([...faqIds].sort());
    }
  });

  test('no seat or per-user pricing in any plan, headline or FAQ answer, in English', () => {
    const copy = JSON.stringify(english.billing.pricing.headline) + JSON.stringify(PRICING_PLANS);
    expect(copy.toLowerCase()).not.toMatch(/per[- ]seat|\bseats?\b|per user|per member/);
    // The one allowed mention: the FAQ that tells a per-seat customer what became of their plan.
    for (const [id, item] of Object.entries(english.billing.pricing.faq)) {
      if (id === 'existing') continue;
      expect(`${item.question} ${item.answer}`.toLowerCase()).not.toMatch(/per[- ]seat|\bseats?\b/);
    }
  });

  test('the credit rate is stated as 1 credit = $0.01', () => {
    expect(english.billing.credits.planCard.rate).toContain('1 credit = $0.01');
    expect(english.billing.pricing.faq.credit.answer).toContain('1 credit is $0.01');
  });

  test('the FAQ states the tier range and the one rate, and names no tier most popular', () => {
    const answer = english.billing.pricing.faq.amounts.answer;
    expect(answer).toContain('$50 a month (5,000 credits)');
    expect(answer).toContain('$10,000 a month (1,000,000 credits)');
    expect(answer).not.toContain('most popular');
    expect(answer).toContain('100 credits per dollar');
  });

  test('the FAQ answers what happened to existing plans and to members', () => {
    expect(english.billing.pricing.faq.existing.answer).toContain('same monthly price');
    expect(english.billing.pricing.faq.members.answer).toContain('free and unlimited');
    expect(english.billing.pricing.faq.rollover.answer).toContain('roll over for one month');
  });

  test('models are separate: three sources, base price plus the fee only for Kortix models', () => {
    const models = english.billing.pricing.models;
    expect(Object.keys(models).filter((key) => typeof models[key] === 'object')).toEqual([
      'keys',
      'chatgpt',
      'kortix',
    ]);
    expect(models.keys.tag).toBe('No credits');
    expect(models.chatgpt.tag).toBe('No credits');
    expect(models.kortix.body).toContain('{fee}% platform fee');
    expect(models.summary).toContain('only for the agent computer');
    expect(english.billing.pricing.faq.models.answer).toContain('{fee}% platform fee');
  });

  test('the top-up FAQ states the bonus ladder from compute-pricing, not literals', () => {
    const answer = english.billing.pricing.faq.topup.answer;
    for (const token of ['{smallestBonus}', '{smallestBonusUsd}', '{largestBonus}', '{largestBonusUsd}']) {
      expect(answer).toContain(token);
    }
  });
});
