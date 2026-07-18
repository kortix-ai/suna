import { describe, expect, test } from 'bun:test';
import { CATALOG } from './index';

// Regression coverage for the "nothing from models.dev is dropped in the
// baked catalog" pass — `CatalogModel` used to silently drop `description`,
// `interleaved`, `open_weights`, and `last_updated` even though models.dev's
// api.json carries them. apps/web/scripts/enrich-llm-catalog-capabilities.ts
// now mirrors them into catalog.generated.json; this asserts the REGENERATED
// baked snapshot actually carries at least one real example of each so a
// future edit that silently drops one of them again fails loudly here rather
// than only in a deep integration test.
describe('CATALOG (baked catalog.generated.json) — full field fidelity', () => {
  const allModels = CATALOG.providers.flatMap((p) => p.models);

  test('at least one model carries a `description`', () => {
    expect(allModels.some((m) => typeof m.description === 'string' && m.description.length > 0)).toBe(
      true,
    );
  });

  test('at least one model declares `interleaved`', () => {
    expect(allModels.some((m) => typeof m.interleaved === 'boolean')).toBe(true);
  });

  test('at least one model declares `open_weights`', () => {
    expect(allModels.some((m) => typeof m.open_weights === 'boolean')).toBe(true);
  });

  test('at least one model carries `last_updated`', () => {
    expect(allModels.some((m) => typeof m.last_updated === 'string' && m.last_updated.length > 0)).toBe(
      true,
    );
  });

  test('a known real reasoning model (anthropic/claude-opus-4-8) carries the full enriched field set', () => {
    const anthropic = CATALOG.providers.find((p) => p.id === 'anthropic');
    const opus = anthropic?.models.find((m) => m.id === 'claude-opus-4-8');
    expect(opus).toBeDefined();
    expect(typeof opus?.description).toBe('string');
    expect(opus?.reasoning_options?.[0]?.type).toBe('effort');
    expect(opus?.cost?.input).toBeGreaterThan(0);
    expect(opus?.modalities?.input?.length).toBeGreaterThan(0);
    expect(typeof opus?.structured_output).toBe('boolean');
    expect(typeof opus?.knowledge).toBe('string');
    expect(typeof opus?.last_updated).toBe('string');
  });
});
