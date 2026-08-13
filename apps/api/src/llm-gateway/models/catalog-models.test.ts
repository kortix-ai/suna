import { describe, expect, test } from 'bun:test';

import { catalogModelForWireModel, gatewayModelCatalog } from './catalog-models';

// The sandbox agent server injects this catalog into OpenCode verbatim and does NO
// client-side limit backfill — so the gateway MUST guarantee a usable context window
// on every served model, or OpenCode can't size conversations and a long session
// pins at 100% context. These tests lock that server-side guarantee.
describe('gatewayModelCatalog — served catalog', () => {
  const full = gatewayModelCatalog('proj');

  test('brands managed DeepSeek V4 Flash with the Kortix provider', () => {
    expect(full['deepseek-v4-flash']?.provider).toBe('kortix');
  });

  test('serves Aster GLM pricing instead of a models.dev provider price', () => {
    expect(full['glm-5.2']?.cost).toEqual({
      input: 1,
      output: 4,
      cache_read: 0.2,
      cache_write: 1,
    });
  });

  // Regression: managedModels() used to hardcode `temperature: true` for the
  // whole managed lineup. gpt-5.6-luna REJECTS a client-sent temperature —
  // OpenCode reads this served record, so advertising support 400s every
  // Luna turn. Capabilities must come from the real catalog record via
  // pricingRef; curated vision/limit still win.
  test('managed gpt-5.6-luna serves its REAL capabilities (temperature:false, effort ladder)', () => {
    const luna = full['gpt-5.6-luna'];
    expect(luna).toBeDefined();
    expect(luna?.temperature).toBe(false);
    expect(luna?.reasoning_options?.[0]?.values).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // Curated fields win over the models.dev record.
    expect(luna?.attachment).toBe(true);
    expect(luna?.limit?.context).toBe(1_050_000);
    // Unresolvable pricingRef (glm-5.2) keeps the permissive defaults.
    expect(full['glm-5.2']?.temperature).toBe(true);
  });

  test('serves Grok 4.6 capabilities and context-tier pricing from models.dev', () => {
    expect(full['grok-4.6']).toMatchObject({
      name: 'Grok 4.6',
      provider: 'kortix',
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
      tool_call: true,
      attachment: true,
      structured_output: true,
      temperature: true,
      limit: { context: 500_000, output: 500_000 },
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.5,
        context_over_200k: { input: 4, output: 12, cache_read: 1 },
      },
    });
  });

  test('serves DeepSeek V4 Pro 0813 with its real capabilities and prices', () => {
    expect(full['deepseek-v4-pro-0813']).toMatchObject({
      name: 'DeepSeek V4 Pro 0813',
      provider: 'kortix',
      reasoning: true,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
      ],
      tool_call: true,
      attachment: false,
      temperature: true,
      limit: { context: 1_048_575, output: 384_000 },
      cost: { input: 1.74, output: 3.48, cache_read: 0.145 },
    });
  });

  test('every served model carries a positive context limit', () => {
    const missing = Object.entries(full)
      .filter(([, m]) => !(typeof m.limit?.context === 'number' && m.limit.context > 0))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('synthetic auto is absent; anonymous callers get managed-only', () => {
    expect(full.auto).toBeUndefined();
    expect(full['deepseek-v4-flash']).toBeDefined();
    expect(full['glm-5.2']).toBeDefined();

    const managedOnly = gatewayModelCatalog(undefined);
    expect(managedOnly.auto).toBeUndefined();
    // anonymous = managed-only; with a project, BYOK + codex widen the catalog
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(managedOnly).length);
  });

  test('project catalog advertises the GPT-5.6 Codex family', () => {
    expect(full['codex/gpt-5.6-sol']).toMatchObject({
      name: 'GPT-5.6 Sol (ChatGPT)',
      reasoning: true,
      tool_call: true,
    });
    expect(full['codex/gpt-5.6-terra']).toBeDefined();
    expect(full['codex/gpt-5.6-luna']).toBeDefined();
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
    expect(full['deepseek-v4-flash']?.provider).toBe('kortix');
    expect(full['glm-5.2']?.provider).toBe('kortix');
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
    for (const id of ['claude-opus-4.8', 'claude-sonnet-4.6', 'glm-5.2', 'kimi-k3', 'deepseek-v4-flash']) {
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

  // MUST-FIX regression (adversarial review of PR #4995): `claude-opus-4.8`'s
  // `pricingRef` used to be the DOTTED display id, which never matches
  // models.dev's DASHED catalog id — this lookup silently missed and fell
  // back to a permissive synthetic record (temperature:true, no
  // reasoning_options) instead of the model's REAL capabilities
  // (temperature:false, reasoning_options up to 'xhigh'/'max'). Assert the
  // REAL entry, not just `reasoning:true` (which the synthetic fallback also
  // satisfied and so wouldn't have caught the regression).
  // 2026-08-10 slim-down: the Claude managed ids this test used are
  // deactivated. deepseek-v4-flash keeps the regression covered — its
  // pricingRef ('openrouter/deepseek/deepseek-v4-flash') resolves to the REAL
  // models.dev openrouter entry, whose reasoning_options ('high'/'xhigh') the
  // synthetic fallback would not carry. (glm-5.2's 'z-ai/glm-5.2' is
  // DELIBERATELY unresolvable — z-ai is not a models.dev provider id — so it
  // cannot serve as the regression fixture.)
  test('resolves a managed bare id to its REAL catalog capabilities via pricingRef, not the synthetic fallback', () => {
    const flash = catalogModelForWireModel('deepseek-v4-flash');
    expect(flash).toBeDefined();
    expect(flash?.id).toBe('deepseek/deepseek-v4-flash');
    expect(flash?.reasoning).toBe(true);
    expect(flash?.temperature).toBe(true);
    expect(flash?.reasoning_options?.[0]?.values).toEqual(['high', 'xhigh']);
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
