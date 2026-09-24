import { describe, expect, test } from 'bun:test';

import { catalogModelForWireModel, gatewayCodexModels, gatewayModelCatalog } from './catalog-models';

// The sandbox agent server injects this catalog into OpenCode verbatim and does NO
// client-side limit backfill — so the gateway MUST guarantee a usable context window
// on every served model, or OpenCode can't size conversations and a long session
// pins at 100% context. These tests lock that server-side guarantee.
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
      cost: { input: 0.2, output: 0.6, cache_read: 0.006 },
    });
  });

  test('serves Kimi K3 with image input', () => {
    expect(full['kimi-k3']).toMatchObject({
      provider: 'kortix', attachment: true, tool_call: true,
      cost: { input: 2.5, output: 10.95, cache_read: 0.25 },
    });
    expect(full['deepseek-v4-flash-0731']).toBeUndefined();
    expect(full['kimi-k3-fast']).toBeUndefined();
  });

  test('brands managed DeepSeek V4.1 Flash with the Kortix provider', () => {
    expect(full['deepseek-v4.1-flash']?.provider).toBe('kortix');
  });

  test('serves the CoreWeave GLM 5.3 Flash price and vision capability', () => {
    expect(full['glm-5.3-flash']?.cost).toEqual({
      input: 0.15,
      output: 0.5,
      cache_read: 0.05,
    });
    expect(full['glm-5.3-flash']).toMatchObject({ provider: 'kortix', attachment: true });
  });

  test('does not serve retired DeepSeek V4 Pro under Kortix', () => {
    expect(full['deepseek-v4-pro-0813']).toBeUndefined();
  });

  test('does not serve other retired text-only managed models', () => {
    for (const id of ['deepseek-v4-flash', 'glm-5.3-flash-text']) {
      expect(full[id], id).toBeUndefined();
    }
  });

  test('every served model carries a positive context limit', () => {
    const missing = Object.entries(full)
      .filter(([, m]) => !(typeof m.limit?.context === 'number' && m.limit.context > 0))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('synthetic auto is absent; anonymous callers get managed-only', () => {
    expect(full.auto).toBeUndefined();
    expect(full['deepseek-v4.1-flash']).toBeDefined();
    expect(full['glm-5.3-flash']).toBeDefined();

    const managedOnly = gatewayModelCatalog(undefined);
    expect(managedOnly.auto).toBeUndefined();
    // anonymous = managed-only; with a project, BYOK + codex widen the catalog
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(managedOnly).length);
  });

  test('project catalog advertises the GPT-5.6 Codex family', () => {
    expect(full['codex/gpt-6-astra']).toMatchObject({
      name: 'GPT-6 Astra (ChatGPT)',
      provider: 'codex',
      reasoning: true,
      tool_call: true,
    });
    expect(full['codex/gpt-5.6-sol']).toMatchObject({
      name: 'GPT-5.6 Sol (ChatGPT)',
      reasoning: true,
      tool_call: true,
    });
    expect(full['codex/gpt-5.6-terra']).toBeDefined();
    expect(full['codex/gpt-5.6-luna']).toBeDefined();
  });

  // Released 2026-09-22 for ChatGPT and Codex. The capabilities come from the
  // OpenAI catalog record: both reject a client temperature and take `none`.
  test.each([
    ['codex/gpt-6-sol', 'GPT-6 Sol (ChatGPT)'],
    ['codex/gpt-6-luna', 'GPT-6 Luna (ChatGPT)'],
  ])('project catalog advertises %s through the ChatGPT subscription', (id, name) => {
    expect(full[id]).toMatchObject({
      name,
      provider: 'codex',
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    });
    expect(full[id]?.reasoning_options).toContainEqual({
      type: 'effort',
      values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  test('BYOK Anthropic serves Claude Opus 5.5 from the bundled record', () => {
    expect(full['anthropic/claude-opus-5-5']).toMatchObject({
      name: 'Claude Opus 5.5',
      provider: 'anthropic',
      released: '2026-09-22',
      family: 'claude-opus',
      temperature: false,
      limit: { context: 1_000_000, output: 128_000 },
      cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    });
  });

  test('native OpenCode Zen free models are not served by the gateway catalog', () => {
    for (const id of ['deepseek-v4-flash-free', 'mimo-v2.5-free']) {
      expect(full[`opencode/${id}`], `opencode/${id}`).toBeUndefined();
    }
    expect(full['north-mini-code-free']).toBeUndefined();
    expect(full['nemotron-3-ultra-free']).toBeUndefined();
    expect(full['big-pickle']).toBeUndefined();
    expect(full['opencode/big-pickle']).toBeUndefined();
  });

  test('BYOK catalog entries preserve models.dev metadata for picker visibility', () => {
    const anthropic = full['anthropic/claude-opus-4-8'];
    expect(anthropic).toBeDefined();
    expect(anthropic?.name).toBe('Claude Opus 4.8');
    expect(anthropic?.released).toBeDefined();
    expect(anthropic?.release_date).toBe(anthropic?.released);
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

  test('served catalog carries the full useful models.dev field set (nothing dropped before opencode)', () => {
    // A real reasoning model with a tunable effort knob must carry
    // reasoning_options through — the chat runtime's priority field.
    const opus = full['anthropic/claude-opus-4-8'];
    expect(opus?.reasoning_options?.[0]?.type).toBe('effort');
    expect(opus?.reasoning_options?.[0]?.values?.length).toBeGreaterThan(0);
    expect(opus?.cost).toBeDefined();
    expect(typeof opus?.cost?.input).toBe('number');
    expect(opus?.modalities?.input).toContain('image');
    expect(typeof opus?.structured_output).toBe('boolean');
    expect(typeof opus?.knowledge).toBe('string');

    // Codex models carry the same enriched field set (previously hand-built
    // without reasoning_options/cost/modalities/structured_output/knowledge).
    const codexModel = full['codex/gpt-5.6-sol'];
    expect(codexModel?.reasoning_options?.[0]?.values).toContain('xhigh');
  });

  // MUST-FIX regression (adversarial review of PR #5010): description,
  // open_weights, and last_updated used to stop at LlmProviderModel (the web
  // catalog module) and never reach the served GatewayModel — dropped
  // silently between the catalog layer and what opencode/the client actually
  // see, despite the PR's "full trace" claim.
  test('served catalog threads description/open_weights/last_updated through (not just reasoning_options/cost/modalities)', () => {
    const opus = full['anthropic/claude-opus-4-8'];
    expect(typeof opus?.description).toBe('string');
    expect((opus?.description ?? '').length).toBeGreaterThan(0);
    expect(typeof opus?.open_weights).toBe('boolean');
    expect(typeof opus?.last_updated).toBe('string');
  });

  // MUST-FIX regression (adversarial review of PR #5010): mainline Claude
  // models publish ONLY a `budget_tokens` reasoning_options entry (no
  // `effort` entry at all) — the old normalizeReasoningOptions dropped any
  // entry without `values`, so this field silently vanished by the time it
  // reached opencode for exactly the models most likely to be selected.
  test('a budget_tokens-only Claude model (claude-haiku-4-5) still carries reasoning_options through to the served catalog', () => {
    const haiku = full['anthropic/claude-haiku-4-5'];
    expect(haiku).toBeDefined();
    expect(haiku?.reasoning_options).toEqual([{ type: 'budget_tokens', min: 1024 }]);
  });

  test('catalog is a memoized singleton (built once, not per call)', () => {
    expect(gatewayModelCatalog('proj')).toBe(full);
  });
});

describe('gatewayModelCatalog — free-tier visibility', () => {
  const freeFull = gatewayModelCatalog('proj', { freeManagedOnly: true });

  test('free tier sees no managed Kortix models', () => {
    expect(freeFull.auto).toBeUndefined();
    for (const id of ['claude-opus-4.8', 'claude-sonnet-4.6', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-0731', 'kimi-k3', 'gpt-6-astra']) {
      expect(freeFull[id], id).toBeUndefined();
    }
  });

  test('free tier still sees BYOK catalog models (own connected keys work)', () => {
    expect(freeFull['anthropic/claude-opus-4-8']).toBeDefined();
  });

  test('anonymous + free-only = empty catalog', () => {
    const empty = gatewayModelCatalog(undefined, { freeManagedOnly: true });
    expect(empty).toEqual({});
  });

  test('free-tier catalog is its own memoized singleton', () => {
    expect(gatewayModelCatalog('proj', { freeManagedOnly: true })).toBe(freeFull);
  });
});

describe('catalogModelForWireModel — generation-controls capability lookup', () => {
  test('resolves a BYOK provider/model id to its live catalog capability record', () => {
    const model = catalogModelForWireModel('openai/gpt-5.6-sol');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
    expect(model?.reasoning_options?.[0]?.values).toContain('xhigh');
  });

  test('resolves a codex/<id> wire model via the underlying openai/<id> catalog entry', () => {
    const model = catalogModelForWireModel('codex/gpt-5.6-sol');
    expect(model?.reasoning).toBe(true);
    expect(model?.temperature).toBe(false);
  });

  test('resolves a managed bare id to its image-capable gateway record', () => {
    const flash = catalogModelForWireModel('glm-5.3-flash');
    expect(flash).toBeDefined();
    expect(flash?.id).toBe('glm-5.3-flash');
    expect(flash?.reasoning).toBe(true);
    expect(flash?.temperature).toBe(true);
    expect(flash?.limit?.context).toBe(1_048_576);
  });

  test('does not resolve stale synthetic auto model ids', () => {
    expect(catalogModelForWireModel('auto')).toBeUndefined();
    expect(catalogModelForWireModel('kortix/auto')).toBeUndefined();
  });

  test('returns undefined for a completely unknown wire model', () => {
    expect(catalogModelForWireModel('nonexistent-provider/nonexistent-model')).toBeUndefined();
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

  test('the subscription row retains paid context tiers', () => {
    const model = gatewayCodexModels()['codex/gpt-5.6-sol']!;
    expect(model.cost).toEqual(gatewayModelCatalog('proj')['openai/gpt-5.6-sol']!.cost);
  });
});
