import { describe, expect, test } from 'bun:test';

import { catalogModelForWireModel, gatewayModelCatalog } from './catalog-models';

// The sandbox agent server injects this catalog into OpenCode verbatim and does NO
// client-side limit backfill — so the gateway MUST guarantee a usable context window
// on every served model, or OpenCode can't size conversations and a long session
// pins at 100% context. These tests lock that server-side guarantee.
describe('gatewayModelCatalog — served catalog', () => {
  const full = gatewayModelCatalog('proj');

  test('every served model carries a positive context limit', () => {
    const missing = Object.entries(full)
      .filter(([, m]) => !(typeof m.limit?.context === 'number' && m.limit.context > 0))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('AUTO + managed lineup present; anonymous callers get managed-only', () => {
    expect(full.auto).toBeDefined();
    expect(full['claude-opus-4.8']).toBeDefined();
    expect(full['glm-5.2']).toBeDefined();

    const managedOnly = gatewayModelCatalog(undefined);
    expect(managedOnly.auto).toBeDefined();
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

  test('catalog is a memoized singleton (built once, not per call)', () => {
    expect(gatewayModelCatalog('proj')).toBe(full);
  });
});

describe('gatewayModelCatalog — free-tier visibility', () => {
  const freeFull = gatewayModelCatalog('proj', { freeManagedOnly: true });

  test('free tier sees no managed Kortix models', () => {
    expect(freeFull.auto).toBeUndefined();
    for (const id of ['claude-opus-4.8', 'claude-sonnet-4.6', 'glm-5.2', 'qwen3.7-max', 'deepseek-v4-flash']) {
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
  test('resolves a managed bare id to its REAL catalog capabilities via pricingRef, not the synthetic fallback', () => {
    const opus = catalogModelForWireModel('claude-opus-4.8');
    expect(opus).toBeDefined();
    expect(opus?.id).toBe('claude-opus-4-8');
    expect(opus?.reasoning).toBe(true);
    expect(opus?.temperature).toBe(false);
    expect(opus?.reasoning_options?.[0]?.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(opus?.limit?.output).toBe(128_000);

    const sonnet = catalogModelForWireModel('claude-sonnet-4.6');
    expect(sonnet).toBeDefined();
    expect(sonnet?.id).toBe('claude-sonnet-4-6');
    expect(sonnet?.reasoning).toBe(true);
    expect(sonnet?.temperature).toBe(true);
    expect(sonnet?.reasoning_options?.[0]?.values).toEqual(['low', 'medium', 'high', 'max']);
  });

  test('resolves the synthetic auto model to a permissive capability record', () => {
    const model = catalogModelForWireModel('auto');
    expect(model?.tool_call).toBe(true);
    expect(model?.temperature).toBe(true);
  });

  test('returns undefined for a completely unknown wire model', () => {
    expect(catalogModelForWireModel('nonexistent-provider/nonexistent-model')).toBeUndefined();
  });
});
