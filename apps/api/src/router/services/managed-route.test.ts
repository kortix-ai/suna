import { describe, expect, test } from 'bun:test';
import { getManagedModel, MANAGED_MODELS } from '@kortix/shared/llm-catalog';
import { resolveManagedRoute } from './managed-route';

// THE bedrock|zen|openrouter routing decision for the slim managed endpoint.
// Pure + config-free, so it is asserted directly against the real managed catalog.
describe('resolveManagedRoute', () => {
  test('managed Claude routes to Bedrock with the Bedrock upstream id', () => {
    const opus = resolveManagedRoute('claude-opus-4.8');
    expect(opus.upstream).toBe('bedrock');
    expect(opus.wireModel).toBe('us.anthropic.claude-opus-4-8');
    expect(opus.billingModel).toBe('claude-opus-4.8');
    expect(opus.managed?.transport).toBe('bedrock');

    const sonnet = resolveManagedRoute('claude-sonnet-4.6');
    expect(sonnet.upstream).toBe('bedrock');
    expect(sonnet.wireModel).toBe('us.anthropic.claude-sonnet-4-6');
  });

  test('managed non-Claude models route to OpenRouter with the verbatim slug', () => {
    const fusion = resolveManagedRoute('fusion');
    expect(fusion.upstream).toBe('openrouter');
    // The curated slug must forward verbatim (NOT prefix-stripped to `fusion`).
    expect(fusion.wireModel).toBe('openrouter/fusion');
    expect(fusion.billingModel).toBe('fusion');
    expect(fusion.managed).not.toBeNull();

    const deepseek = resolveManagedRoute('deepseek-v4-pro');
    expect(deepseek.upstream).toBe('openrouter');
    expect(deepseek.wireModel).toBe('deepseek/deepseek-v4-pro');
  });

  test('managed free models route to OpenCode Zen', () => {
    const zen = resolveManagedRoute('deepseek-v4-flash-free');
    expect(zen.upstream).toBe('zen');
    expect(zen.wireModel).toBe('deepseek-v4-flash-free');
    expect(zen.billingModel).toBe('deepseek-v4-flash-free');
    expect(zen.managed?.free).toBe(true);
  });

  test('a legacy/non-managed id passes through to OpenRouter unchanged', () => {
    const legacy = resolveManagedRoute('anthropic/claude-sonnet-4.6');
    expect(legacy.upstream).toBe('openrouter');
    expect(legacy.managed).toBeNull();
    expect(legacy.wireModel).toBe('anthropic/claude-sonnet-4.6');
    expect(legacy.billingModel).toBe('anthropic/claude-sonnet-4.6');
  });

  test('synthetic `auto` resolves to a concrete managed model and bills as it', () => {
    // Text-only → Fusion (OpenRouter).
    const text = resolveManagedRoute('auto', { messages: [{ role: 'user', content: 'hi' }] });
    expect(text.upstream).toBe('openrouter');
    expect(text.billingModel).toBe('fusion');
    expect(text.wireModel).toBe('openrouter/fusion');

    // Image-bearing → a vision-capable managed model (Claude on Bedrock).
    const vision = resolveManagedRoute('auto', {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ],
    });
    expect(vision.upstream).toBe('bedrock');
    expect(vision.billingModel).toBe('claude-sonnet-4.6');
  });

  // Curated pricing guards the $0-billing leak: every PAID managed model must
  // carry positive per-1M pricing (managed slugs don't resolve on models.dev, so
  // the slim endpoint bills from this table). Free Zen models price to $0.
  test('every managed model carries curated pricing; paid models are non-zero', () => {
    for (const m of MANAGED_MODELS) {
      expect(m.pricing).toBeDefined();
      if (m.free) {
        expect(m.pricing.input).toBe(0);
        expect(m.pricing.output).toBe(0);
      } else {
        expect(m.pricing.input).toBeGreaterThan(0);
        expect(m.pricing.output).toBeGreaterThan(0);
      }
    }
    // Bedrock/Claude must have curated cacheRead (responses carry no cost hint).
    expect(getManagedModel('claude-opus-4.8')?.pricing.cacheRead).toBeGreaterThan(0);
  });
});
