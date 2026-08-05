import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pricingPageSource = readFileSync(
  join(import.meta.dir, '../../../src/app/(public)/(marketing)/pricing/page.tsx'),
  'utf8',
);
const calculatorSource = readFileSync(
  join(import.meta.dir, 'compute-credit-calculator.tsx'),
  'utf8',
);
const planSource = readFileSync(join(import.meta.dir, 'pricing-plans.ts'), 'utf8');
const englishTranslations = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../translations/en.json'), 'utf8'),
) as {
  hardcodedUi: Record<string, string>;
};
const translatedTokenTerms = {
  de: 'Token',
  es: 'tokens',
  fr: 'tokens',
  it: 'token',
  ja: 'トークン',
  pt: 'tokens',
  zh: 'token',
} as const;
const pricingHeadingKey = 'autoAppPublicMarketingPricingPageJsxTextCreditsPowerEverything0f094b3e';
const pricingExplainerKey = 'autoAppPublicMarketingPricingPageJsxTextOneSimpleBalancef877f3a6';

const pricingCopy = [
  pricingPageSource,
  calculatorSource,
  planSource,
  englishTranslations.hardcodedUi[pricingHeadingKey],
  englishTranslations.hardcodedUi[pricingExplainerKey],
].join('\n');
const normalizedPricingCopy = pricingCopy.replace(/\s+/g, ' ');

describe('pricing model billing copy', () => {
  test('does not claim that managed models avoid token billing', () => {
    expect(normalizedPricingCopy.toLowerCase()).not.toContain('no token math');
  });

  test('presents managed models as optional token-based usage', () => {
    expect(normalizedPricingCopy).toContain('Pay for the computer. Bring your own model.');
    expect(normalizedPricingCopy).toContain(
      'Optional managed models use Team credits based on token usage.',
    );
    expect(normalizedPricingCopy).toContain('Optional managed model usage is token-based');
    expect(normalizedPricingCopy).toContain('input, output, and cached tokens use Team credits');
  });

  test('leads with the compute-first heading', () => {
    expect(englishTranslations.hardcodedUi[pricingHeadingKey]).toBe(
      'Pay for the computer. Bring your own model.',
    );
    const h1Block = pricingPageSource.slice(
      pricingPageSource.indexOf('<h1'),
      pricingPageSource.indexOf('</h1>'),
    );
    expect(h1Block).toContain(pricingHeadingKey);
  });

  test('derives the hero hourly price from the pricing constants', () => {
    expect(pricingPageSource).toContain('DEFAULT_COMPUTE_HOURLY_PRICE_USD.toFixed(2)');
    expect(pricingPageSource).toContain('/ hour');
    expect(pricingPageSource).toContain('estimateDefaultCompute(FREE_MONTHLY_CREDITS)');
    expect(pricingPageSource).toContain('estimateDefaultCompute(TEAM_CREDITS_PER_SEAT)');
  });

  test('states per-second billing and zero idle cost with the price', () => {
    expect(normalizedPricingCopy).toContain('Billed by the second');
    expect(normalizedPricingCopy).toContain('$0 while idle');
    expect(normalizedPricingCopy).toContain('2 vCPU · 4 GiB RAM · 20 GiB storage');
  });

  test('shows the rounded per-seat Agent Computer hours', () => {
    expect(calculatorSource).toContain('aria-label="hours"');
    expect(calculatorSource).toContain('2,500');
    expect(calculatorSource).toContain('<span>125</span>');
    expect(calculatorSource).toContain(
      '1 Team seat equals 2,500 pooled credits equals 125 Agent Computer hours per month.',
    );
    expect(calculatorSource).toContain('Agent Computer hours / month');
    expect(calculatorSource).not.toContain('teamMembers');
    expect(calculatorSource).not.toContain('<Slider');
  });

  test('keeps the model billing correction in every translated pricing page', () => {
    for (const [locale, tokenTerm] of Object.entries(translatedTokenTerms)) {
      const translations = JSON.parse(
        readFileSync(join(import.meta.dir, `../../../translations/${locale}.json`), 'utf8'),
      ) as {
        hardcodedUi: Record<string, string>;
      };

      expect(translations.hardcodedUi[pricingHeadingKey]).toBeTruthy();
      expect(translations.hardcodedUi[pricingExplainerKey]).toContain(tokenTerm);
    }
  });
});
