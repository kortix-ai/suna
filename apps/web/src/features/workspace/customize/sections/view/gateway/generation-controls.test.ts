import { describe, expect, test } from 'bun:test';

import { catalogModelForGateway } from './generation-controls';

describe('catalogModelForGateway — client-side capability lookup', () => {
  test('resolves a BYOK provider/model id', () => {
    const model = catalogModelForGateway('openai/gpt-5.6-sol');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
    expect(model?.reasoning_options?.[0]?.values).toContain('xhigh');
  });

  test('resolves a codex/<id> wire model via the underlying openai/<id> entry', () => {
    const model = catalogModelForGateway('codex/gpt-5.6-sol');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
  });

  test('resolves a managed bare id with a permissive synthetic fallback', () => {
    const model = catalogModelForGateway('claude-opus-4.8');
    expect(model).toBeDefined();
    expect(model?.reasoning).toBe(true);
  });

  test('resolves the synthetic auto model', () => {
    const model = catalogModelForGateway('auto');
    expect(model?.tool_call).toBe(true);
    expect(model?.temperature).toBe(true);
  });

  test('returns undefined for an unknown wire model', () => {
    expect(catalogModelForGateway('nonexistent-provider/nonexistent-model')).toBeUndefined();
  });
});
