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
/**
 * Same convention as `workspace-vocabulary.test.ts`: strip comments before
 * asserting on the source. A doc comment may *name* a billing number to
 * explain why the code does not hardcode it, and only the code itself is
 * evidence about what renders. The `[^:]` guard keeps `https://` intact.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const calculatorCode = stripComments(calculatorSource);
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
const pricingHeroKey = 'autoAppPublicMarketingPricingPageJsxTextEverySeatGets58d131e8';
const pricingHeadingKey = 'autoAppPublicMarketingPricingPageJsxTextCreditsPowerEverything0f094b3e';
const pricingExplainerKey = 'autoAppPublicMarketingPricingPageJsxTextOneSimpleBalancef877f3a6';

const pricingCopy = [
  pricingPageSource,
  calculatorSource,
  planSource,
  englishTranslations.hardcodedUi[pricingHeroKey],
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

  test('derives every credit figure instead of typing it in a second time', () => {
    // Seats are the billing unit. The earlier "team members" control implied
    // per-member billing and was removed for exactly that reason.
    expect(calculatorSource).not.toContain('teamMembers');
    expect(calculatorSource).toContain('label="Team seats"');
    expect(calculatorSource).toContain('label="Agent Computer runtime"');

    // Every figure reads from compute-pricing.ts. A second typed-in copy of a
    // billing number has drifted wrong in this file before.
    expect(calculatorSource).toContain("from '@/features/billing/compute-pricing'");
    expect(calculatorSource).toContain('TEAM_CREDITS_PER_SEAT');
    expect(calculatorSource).toContain('DEFAULT_COMPUTE_HOURLY_PRICE_USD');
    expect(calculatorSource).toContain('CREDITS_PER_USD');
    expect(calculatorCode).not.toContain('2,500');
    expect(calculatorCode).not.toContain('2500');
    expect(calculatorCode).not.toContain('$40');

    // The receipt still names the two figures the reader came for.
    expect(calculatorSource).toContain('Pooled credits / month');
    expect(calculatorSource).toContain('Runtime the pool covers');
  });

  test('keeps the model billing correction in every translated pricing page', () => {
    for (const [locale, tokenTerm] of Object.entries(translatedTokenTerms)) {
      const translations = JSON.parse(
        readFileSync(join(import.meta.dir, `../../../translations/${locale}.json`), 'utf8'),
      ) as {
        hardcodedUi: Record<string, string>;
      };

      expect(translations.hardcodedUi[pricingHeroKey]).toContain('Agent Computer');
      expect(translations.hardcodedUi[pricingExplainerKey]).toContain(tokenTerm);
    }
  });
});

/**
 * The seat grant is stated in two packages and they drift silently.
 *
 * apps/api owns the real number (`INCLUDED_CREDITS_PER_SEAT_USD`); apps/web
 * restates it for the pricing page, the calculator and the post-checkout toast.
 * Nothing connected them, so the toast sat at a hardcoded $20 while the API
 * granted $25 — quoting a customer a grant $5/seat smaller than the one they
 * had just paid for, on the screen right after they paid.
 *
 * Read from the API source rather than importing it: apps/web must not take a
 * build dependency on apps/api, but it can still refuse to disagree with it.
 */
describe('seat grant agrees with the API', () => {
  const apiTiersSource = readFileSync(
    join(import.meta.dir, '../../../../api/src/billing/services/tiers.ts'),
    'utf8',
  );

  function apiConstant(name: string): number {
    const m = apiTiersSource.match(new RegExp(`export const ${name} = (\\d+(?:\\.\\d+)?)`));
    if (!m) throw new Error(`${name} not found in apps/api tiers.ts`);
    return Number(m[1]);
  }

  test('SEAT_GRANT_USD equals INCLUDED_CREDITS_PER_SEAT_USD', async () => {
    const { SEAT_GRANT_USD } = await import('./compute-pricing');
    expect(SEAT_GRANT_USD).toBe(apiConstant('INCLUDED_CREDITS_PER_SEAT_USD'));
  });

  test('the pooled-credit figure is that grant in credits', async () => {
    const { TEAM_CREDITS_PER_SEAT, CREDITS_PER_USD } = await import('./compute-pricing');
    expect(TEAM_CREDITS_PER_SEAT / CREDITS_PER_USD).toBe(
      apiConstant('INCLUDED_CREDITS_PER_SEAT_USD'),
    );
  });

  test('the seat PRICE is not confused with the seat GRANT', () => {
    // $40 is charged, $25 is granted. Conflating them is the exact error the
    // seat-management card shipped ("adds $40/mo and grants $40 of credits").
    expect(apiConstant('PER_SEAT_PRICE_USD')).not.toBe(
      apiConstant('INCLUDED_CREDITS_PER_SEAT_USD'),
    );
  });
});
