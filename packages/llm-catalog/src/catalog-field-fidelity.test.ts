import { describe, expect, test } from 'bun:test';
import { CATALOG, PROVIDER_LABELS, generationControlCapabilities } from './index';

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
    expect(
      allModels.some((m) => typeof m.description === 'string' && m.description.length > 0),
    ).toBe(true);
  });

  test('at least one model declares `interleaved`', () => {
    expect(allModels.some((m) => typeof m.interleaved === 'boolean')).toBe(true);
  });

  test('at least one model declares `open_weights`', () => {
    expect(allModels.some((m) => typeof m.open_weights === 'boolean')).toBe(true);
  });

  test('at least one model carries `last_updated`', () => {
    expect(
      allModels.some((m) => typeof m.last_updated === 'string' && m.last_updated.length > 0),
    ).toBe(true);
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

  // MUST-FIX regression (adversarial review of PR #5010): the old
  // `normalizeReasoningOptions` required `Array.isArray(option.values)`,
  // which silently dropped models.dev's `budget_tokens` shape
  // (`{type:'budget_tokens', min, max?}` — no `values`) and its `toggle`
  // shape (`{type:'toggle'}` — neither). That's 57.8% of every model with
  // `reasoning_options`, INCLUDING every mainline Claude model — none of
  // which carries an `effort` entry at all. A test that only ever exercises
  // an `effort`-type model (like the opus-4-8 case above) passes even with
  // that bug present, so this is the case that actually catches it.
  test('a budget_tokens-only reasoning model (anthropic/claude-haiku-4-5) carries reasoning_options and yields an effort control', () => {
    const anthropic = CATALOG.providers.find((p) => p.id === 'anthropic');
    const haiku = anthropic?.models.find((m) => m.id === 'claude-haiku-4-5');
    expect(haiku).toBeDefined();
    // The real shape: no `values` at all — only `type` (+ `min`/`max`).
    expect(haiku?.reasoning_options).toEqual([{ type: 'budget_tokens', min: 1024 }]);
    expect(haiku?.reasoning_options?.[0]?.values).toBeUndefined();

    // The actual product fix: a budget_tokens model still gets a real,
    // usable effort control end-to-end — never nothing just because it
    // doesn't happen to be the `effort` shape.
    const caps = generationControlCapabilities(haiku);
    expect(caps.reasoningEffort?.values).toEqual(['low', 'medium', 'high']);
  });

  // A `toggle` reasoning_options entry (`{type:'toggle'}`, no values/min/max)
  // must ingest without crashing or being silently dropped, and must NOT
  // synthesize an effort control (on/off is not an effort enum) — this is
  // the "don't crash, don't fabricate" branch generationControlCapabilities
  // documents.
  test('a toggle reasoning model (openrouter/qwen/qwen3.5-122b-a10b) carries the toggle shape and yields no effort control', () => {
    const openrouter = CATALOG.providers.find((p) => p.id === 'openrouter');
    const model = openrouter?.models.find((m) => m.id === 'qwen/qwen3.5-122b-a10b');
    expect(model).toBeDefined();
    expect(model?.reasoning_options).toEqual([{ type: 'toggle' }]);

    const caps = generationControlCapabilities(model);
    expect(caps.reasoningEffort).toBeUndefined();
  });

  // MUST-FIX regression: the old ingest kept `interleaved` only when
  // `typeof === 'boolean'`, silently dropping models.dev's far more common
  // object shape (`{field:'reasoning_content'}` — 623/657 real models, vs 34
  // booleans). The existing "at least one model declares `interleaved`" test
  // above passes even with that bug present (a boolean-only model still
  // exists) — this asserts the object shape specifically round-trips.
  test('an object-shaped interleaved model (stepfun-ai/step-3.7-flash) carries interleaved verbatim', () => {
    const stepfun = CATALOG.providers.find((p) => p.id === 'stepfun-ai');
    const model = stepfun?.models.find((m) => m.id === 'step-3.7-flash');
    expect(model).toBeDefined();
    expect(model?.interleaved).toEqual({ field: 'reasoning_content' });
  });
});

describe('PROVIDER_LABELS', () => {
  // Regression: MiniMax (minimax.io / minimaxi.com) is its own distinct BYOK
  // provider, not Moonshot — both regional variants used to collapse onto
  // the 'Moonshot' label, which then drives the picker's group label
  // (pickerGroupLabel) and would mislabel every MiniMax model as Moonshot.
  test('minimax and minimax-cn are labeled "MiniMax", not "Moonshot"', () => {
    expect(PROVIDER_LABELS.minimax).toBe('MiniMax');
    expect(PROVIDER_LABELS['minimax-cn']).toBe('MiniMax');
  });
});
