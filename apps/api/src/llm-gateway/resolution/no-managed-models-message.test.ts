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

/** Protect the zero-charge BYOK invariant at the routing boundary. */
const RESOLVE_SRC = await Bun.file(
  new URL('./resolve-candidates.ts', import.meta.url).pathname,
).text();

describe('BYOK billing invariant', () => {
  const SRC = RESOLVE_SRC;

  function code(): string {
    return SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  }

  test('BYOK always resolves with no Kortix billing', () => {
    const src = code();
    expect(src).toMatch(/billingMode:\s*'none'/);
    expect(src).toMatch(/markup:\s*0/);
  });

  test('BYOK never appends a Kortix-managed fallback', () => {
    const src = code();
    expect(src).not.toContain('byokFallbackCandidates');
    expect(src).not.toMatch(/return[^;]*byokDescriptors[^;]*managedCandidates/);
  });
});
