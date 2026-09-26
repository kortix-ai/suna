import { describe, expect, test } from 'bun:test';
import type { Catalog } from '@kortix/llm-catalog';

import { gatewayCodexModels, gatewayModelCatalog, gatewayModelsAll } from './catalog-models';
import { codexModelIds } from './codex-models';
import { SERVED_MANAGED_MODELS } from './served-managed-models';

// The sandbox agent server injects this catalog into OpenCode verbatim and does NO
// client-side limit backfill — so the gateway MUST guarantee a usable context window
// on every served model, or OpenCode can't size conversations and a long session
// pins at 100% context. These tests lock that server-side guarantee.
//
// The managed lineup and its prices are owned by @kortix/llm-catalog
// (managed.test.ts). This file owns the mapping from a lineup entry to the
// served record, so a lineup change needs no edit here.
describe('gatewayModelCatalog — served catalog', () => {
  const full = gatewayModelCatalog('proj');

  test('serves managed DeepSeek V4.1 with vision, tools, and a context limit', () => {
    expect(full['deepseek-v4.1-flash']).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      provider: 'kortix',
      attachment: true,
      tool_call: true,
      temperature: true,
      limit: { context: 1_048_576, output: 16_384 },
      cost: { input: 0.2, output: 0.65, cache_read: 0.03 },
    });
  });

  test.each(SERVED_MANAGED_MODELS.map((model) => [model.id, model] as const))(
    '%s is served under Kortix with its curated vision, limit, and price',
    (id, model) => {
      const pricing = model.pricing!;
      expect(full[id]).toMatchObject({
        name: model.name,
        provider: model.providerBrand ?? 'kortix',
        attachment: model.vision,
        limit: model.limit,
      });
      // Exact: an extra or renamed price field fails.
      expect(full[id]?.cost).toEqual({
        input: pricing.inputPerMillion,
        output: pricing.outputPerMillion,
        ...(pricing.cachedInputPerMillion != null ? { cache_read: pricing.cachedInputPerMillion } : {}),
        ...(pricing.cacheWritePerMillion != null ? { cache_write: pricing.cacheWritePerMillion } : {}),
      });
    },
  );

  test('every served model carries a positive context limit', () => {
    const missing = Object.entries(full)
      .filter(([, m]) => !(typeof m.limit?.context === 'number' && m.limit.context > 0))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('synthetic auto is absent, and an anonymous caller sees exactly the served managed ids', () => {
    expect(full.auto).toBeUndefined();
    expect(Object.keys(gatewayModelCatalog(undefined)).sort()).toEqual(
      SERVED_MANAGED_MODELS.map((model) => model.id).sort(),
    );
  });

  // The capabilities come from the OpenAI catalog record: every one rejects a
  // client temperature; only some take the `none` effort.
  const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
  test.each([
    ['codex/gpt-6-astra', 'GPT-6 Astra (ChatGPT)', EFFORT],
    ['codex/gpt-6-sol', 'GPT-6 Sol (ChatGPT)', ['none', ...EFFORT]],
    ['codex/gpt-6-luna', 'GPT-6 Luna (ChatGPT)', ['none', ...EFFORT]],
    ['codex/gpt-5.6-sol', 'GPT-5.6 Sol (ChatGPT)', ['none', ...EFFORT]],
  ])('project catalog advertises %s through the ChatGPT subscription', (id, name, effort) => {
    expect(full[id]).toMatchObject({
      name,
      provider: 'codex',
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    });
    expect(full[id]?.reasoning_options).toContainEqual({ type: 'effort', values: effort });
  });

  test('BYOK Anthropic serves Claude Opus 5.5 from the bundled record', () => {
    expect(full['anthropic/claude-opus-5-5']).toMatchObject({
      name: 'Claude Opus 5.5',
      provider: 'anthropic',
      released: '2026-09-22',
      release_date: '2026-09-22',
      family: 'claude-opus',
      temperature: false,
      limit: { context: 1_000_000, output: 128_000 },
      cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    });
  });

  test('native OpenCode Zen free models are not served by the gateway catalog', () => {
    for (const id of ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'big-pickle']) {
      expect(full[`opencode/${id}`], `opencode/${id}`).toBeUndefined();
    }
  });

  // Regression coverage for the "every provider shows as Kortix" picker bug:
  // every served model MUST carry the REAL upstream provider id explicitly,
  // never leaving the client to string-split the wire model id (fragile —
  // see model-selector.tsx's pickerGroupId / use-model-store.ts's subProviderOf).
  test('every served model carries an explicit `provider` field', () => {
    // BYOK catalog entries brand as their real upstream provider.
    expect(full['anthropic/claude-opus-4-8']?.provider).toBe('anthropic');
    // Managed models brand as `kortix`.
    expect(full['deepseek-v4.1-flash']?.provider).toBe('kortix');
    expect(full['glm-5.3-flash']?.provider).toBe('kortix');
    // Codex (ChatGPT subscription) models brand as their own `codex` provider,
    // distinct from the raw `openai` BYOK provider.
    expect(full['codex/gpt-5.6-sol']?.provider).toBe('codex');

    const missingProvider = Object.entries(full)
      .filter(([, m]) => typeof m.provider !== 'string' || m.provider.length === 0)
      .map(([id]) => id);
    expect(missingProvider).toEqual([]);
  });

  test('each catalog shape is built once per runtime-catalog revision, not per call', () => {
    expect(gatewayModelCatalog('proj')).toBe(full);
    const free = gatewayModelCatalog('proj', { freeManagedOnly: true });
    expect(gatewayModelCatalog('proj', { freeManagedOnly: true })).toBe(free);
  });
});

// Every models.dev field the runtime reads must reach OpenCode unchanged.
// Regressions: description/open_weights/last_updated were dropped before the
// served shape (PR #5010 review), and a `budget_tokens`-only reasoning entry
// (mainline Claude) used to vanish.
describe('served catalog field passthrough', () => {
  const [codexId] = codexModelIds();
  const enriched = {
    released: '2026-01-02',
    family: 'synthetic',
    reasoning: true,
    reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
    tool_call: true,
    attachment: true,
    temperature: false,
    structured_output: true,
    knowledge: '2025-12',
    modalities: { input: ['text', 'image'], output: ['text'] },
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
    description: 'A synthetic model.',
    open_weights: false,
    last_updated: '2026-01-03',
    limit: { context: 100_000, input: 90_000, output: 8_000 },
  };
  const catalog = {
    source: 'synthetic',
    fetched_at: '2026-01-01T00:00:00.000Z',
    provider_count: 2,
    model_count: 3,
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { id: 'enriched', name: 'Enriched', ...enriched },
          { id: 'bare', name: 'Bare', limit: { context: 0, output: 0 } },
        ],
      },
      { id: 'openai', name: 'OpenAI', models: [{ id: codexId!, name: 'Codex Base', ...enriched }] },
    ],
  } as unknown as Catalog;
  const { released, family, ...capabilities } = enriched;

  test('a BYOK record carries every enriched field verbatim', () => {
    expect(gatewayModelsAll(catalog)['anthropic/enriched']).toEqual({
      name: 'Enriched',
      provider: 'anthropic',
      released,
      release_date: released,
      family,
      ...capabilities,
    });
  });

  test('a BYOK record without enriched capabilities gets permissive defaults and the default window', () => {
    expect(gatewayModelsAll(catalog)['anthropic/bare']).toEqual({
      name: 'Bare',
      provider: 'anthropic',
      released: undefined,
      release_date: undefined,
      family: undefined,
      reasoning: true,
      tool_call: true,
      attachment: false,
      temperature: false,
      limit: { context: 200_000, output: 32_000 },
    });
  });

  test('a ChatGPT subscription record carries the openai record fields verbatim', () => {
    expect(gatewayCodexModels(catalog)[`codex/${codexId}`]).toEqual({
      name: 'Codex Base (ChatGPT)',
      provider: 'codex',
      released,
      release_date: released,
      family,
      ...capabilities,
    });
  });
});

describe('gatewayModelCatalog — free-tier visibility', () => {
  const freeFull = gatewayModelCatalog('proj', { freeManagedOnly: true });

  // Managed ids are bare; every BYOK and codex id carries a provider prefix.
  test('free tier sees no managed Kortix model', () => {
    expect(Object.keys(freeFull).filter((id) => !id.includes('/'))).toEqual([]);
  });

  test('free tier still sees BYOK catalog models (own connected keys work)', () => {
    expect(freeFull['anthropic/claude-opus-4-8']).toBeDefined();
  });

  test('anonymous + free-only = empty catalog', () => {
    const empty = gatewayModelCatalog(undefined, { freeManagedOnly: true });
    expect(empty).toEqual({});
  });
});

describe('ChatGPT subscription pricing', () => {
  test('subscription rows retain the published model price context', () => {
    const models = gatewayModelCatalog('proj');
    const subscription = models['codex/gpt-5.6-sol']!;
    const api = models['openai/gpt-5.6-sol']!;
    expect(subscription.cost).toEqual(api.cost);
    expect(subscription.cost!.input).toBeGreaterThan(0);
    expect(subscription.limit!.context).toBeGreaterThan(0);
  });
});
