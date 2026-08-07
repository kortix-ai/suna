/**
 * What a customer is told when their plan has no managed inference.
 *
 * Both the free tier and every v3 credit plan (Starter / Team / Scale) block
 * managed models, but for opposite reasons, and one message cannot serve both.
 * "Upgrade your plan" is true for free and plainly false for a Starter
 * subscriber — they are paying; managed models are simply not bundled, and the
 * remedy is a provider key, not a bigger plan.
 *
 * Getting this wrong sends a paying customer to the pricing page to buy
 * something they already have.
 */
import { describe, expect, test } from 'bun:test';
import { noManagedModelsError } from './resolve-candidates';

describe('no-managed-models message', () => {
  test('an UNPAID plan is told to upgrade', () => {
    const err = noManagedModelsError('anthropic/claude-sonnet-4', false);
    expect(err.message).toContain('requires a paid plan');
    expect(String(err.suggestion)).toContain('Upgrade your plan');
  });

  test('a PAID plan is told to bring a key, never to upgrade', () => {
    const err = noManagedModelsError('anthropic/claude-sonnet-4', true);
    expect(err.message).not.toContain('requires a paid plan');
    expect(String(err.suggestion)).not.toContain('Upgrade your plan');
    expect(String(err.suggestion)).toContain('own provider key');
  });

  test('both name the model that was refused', () => {
    for (const paid of [true, false]) {
      expect(noManagedModelsError('openai/gpt-5', paid).message).toContain('openai/gpt-5');
    }
  });

  test('both keep the same machine-readable reason', () => {
    // Clients branch on the code, not the prose — changing it would be a
    // breaking API change dressed up as a copy fix.
    for (const paid of [true, false]) {
      expect(noManagedModelsError('m', paid).code).toBe('plan_upgrade_required');
    }
  });
});

/**
 * The BYOK failover must respect the managed-model entitlement.
 *
 * `resolveCandidates` queues a Kortix-managed model BEHIND the user's own key so
 * a rate-limited turn doesn't die. That gate read `tier === 'free'` — a literal
 * string, not the entitlement. It was harmless while every paid tier carried
 * `models: ['all']`, and became a hole the moment paid plans stopped including
 * inference: a Starter account whose own key returns 402/403/429 would fail over
 * to managed tokens its plan forbids, and skip the wallet admission gate on the
 * way, because that gate is bypassed for precisely these tiers.
 *
 * Asserted on source. The branch sits mid-function behind project-secret
 * resolution and a provider catalog; the property worth protecting is which
 * predicate decides it, and that is exactly what regressed.
 */
const RESOLVE_SRC = await Bun.file(
  new URL('./resolve-candidates.ts', import.meta.url).pathname,
).text();

describe('BYOK managed failover entitlement', () => {
  const SRC = RESOLVE_SRC;

  function code(): string {
    return SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  }

  test('the failover is gated on the entitlement, not on the literal free tier', () => {
    const src = code();
    expect(src).toContain('mayUseManagedModels');
    expect(src).toContain('!accountIsFreeTierForModels(tier)');
    // The regression shape: returning the managed candidates under isFreeTier.
    expect(src).not.toMatch(/return isFreeTier[\s\S]{0,120}byokFallbackCandidates/);
  });

  test('the platform fee still keys on free-vs-paid, a different question', () => {
    // A credit plan pays the 10% BYOK platform fee — it is paid. Folding the two
    // questions back into one variable is what caused the bypass.
    const src = code();
    expect(src).toContain("tier === 'free'");
    expect(src).toMatch(/markup: isFreeTier \? 0 : PLATFORM_FEE_MARKUP/);
  });

  test('self-hosted keeps the failover', () => {
    // Billing disabled means no tiers at all; withdrawing the fallback there
    // would break self-hosted turns that currently survive a key error.
    expect(code()).toContain('!config.KORTIX_BILLING_INTERNAL_ENABLED ||');
  });
});
