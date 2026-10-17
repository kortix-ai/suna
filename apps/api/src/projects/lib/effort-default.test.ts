/**
 * The project default reasoning effort (`effort-default.ts`).
 *
 * The contract under test: a stored project default becomes the prompt's
 * `variant` ONLY when the serving model publishes that exact effort value —
 * the same gate `clampGenerationConfig` runs for the routing-policy write
 * path and the gateway resolution layer. An effort the model doesn't publish
 * must never ride a prompt (the gateway refuses an unknown effort with a 400;
 * OpenCode would silently apply nothing), and an unset or unparseable project
 * default must change nothing.
 */

import { describe, expect, test } from 'bun:test';

import type { CatalogModel } from '@kortix/llm-catalog';

import {
  KNOWN_EFFORT_VALUES,
  effortVariantForPrompt,
  normalizeDefaultReasoningEffort,
  promptWireModel,
} from './effort-default';

/** A minimal catalog model with the given reasoning_options — enough for
 *  `generationControlCapabilities` to derive the effort values. */
function modelWithReasoningOptions(
  reasoning_options: CatalogModel['reasoning_options'],
): CatalogModel {
  return { id: 'test/model', name: 'Test', reasoning: true, reasoning_options } as CatalogModel;
}

/** A fabricated catalog record like the gateway synthesizes for a managed
 *  slug with no models.dev entry: no reasoning_options at all. */
const noEffortModel = { id: 'test/plain', name: 'Plain', reasoning: true } as CatalogModel;

describe('KNOWN_EFFORT_VALUES', () => {
  test('is derived from the catalog, not a hardcoded ladder', () => {
    expect(KNOWN_EFFORT_VALUES.size).toBeGreaterThan(0);
    // The three tiers every budget_tokens model (Claude) accepts.
    for (const value of ['low', 'medium', 'high']) {
      expect(KNOWN_EFFORT_VALUES.has(value)).toBe(true);
    }
  });
});

describe('normalizeDefaultReasoningEffort', () => {
  test('passes a published label through and trims it', () => {
    expect(normalizeDefaultReasoningEffort(' high ')).toBe('high');
    expect(normalizeDefaultReasoningEffort('low')).toBe('low');
  });

  test('rejects an unpublished label, emptiness and non-strings', () => {
    expect(normalizeDefaultReasoningEffort('ultra')).toBe(null);
    expect(normalizeDefaultReasoningEffort('')).toBe(null);
    expect(normalizeDefaultReasoningEffort(7)).toBe(null);
    expect(normalizeDefaultReasoningEffort(null)).toBe(null);
    expect(normalizeDefaultReasoningEffort(undefined)).toBe(null);
  });
});

describe('promptWireModel', () => {
  test('the prompt override wins over the session pin', () => {
    expect(
      promptWireModel({ providerID: 'kortix', modelID: 'gpt-5.6-sol' }, 'kortix/claude-opus-4.8'),
    ).toBe('gpt-5.6-sol');
  });

  test('the session pin resolves through its opencode ref form', () => {
    // Gateway models are stored as `kortix/<wire>` refs.
    expect(promptWireModel(null, 'kortix/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    // Native BYOK models are stored as `provider/model`.
    expect(promptWireModel(null, 'anthropic/claude-opus-4.8')).toBe('anthropic/claude-opus-4.8');
  });

  test('nothing known → null', () => {
    expect(promptWireModel(null, null)).toBe(null);
    expect(promptWireModel(null, undefined)).toBe(null);
    expect(promptWireModel({}, undefined)).toBe(null);
  });
});

describe('effortVariantForPrompt', () => {
  test('injects the stored effort when the model publishes it', () => {
    expect(
      effortVariantForPrompt({
        stored: 'high',
        sessionModelRef: 'kortix/test-model',
        resolveCatalogModel: () => modelWithReasoningOptions([{ type: 'effort', values: ['low', 'medium', 'high'] }]),
      }),
    ).toBe('high');
  });

  test('drops an effort the model does not publish (xhigh on a Claude-class budget model)', () => {
    const budgetModel = modelWithReasoningOptions([{ type: 'budget_tokens', min: 1024 }]);
    expect(
      effortVariantForPrompt({
        stored: 'xhigh',
        sessionModelRef: 'kortix/test-model',
        resolveCatalogModel: () => budgetModel,
      }),
    ).toBeUndefined();
    // The synthesized tiers it does publish go through.
    expect(
      effortVariantForPrompt({
        stored: 'medium',
        sessionModelRef: 'kortix/test-model',
        resolveCatalogModel: () => budgetModel,
      }),
    ).toBe('medium');
  });

  test('drops the value for a model with no effort control at all', () => {
    expect(
      effortVariantForPrompt({ stored: 'high', sessionModelRef: 'kortix/test-model', resolveCatalogModel: () => noEffortModel }),
    ).toBeUndefined();
  });

  test('drops the value when the model is unknown to the catalog', () => {
    expect(
      effortVariantForPrompt({ stored: 'high', sessionModelRef: 'kortix/test-model', resolveCatalogModel: () => undefined }),
    ).toBeUndefined();
  });

  test('no stored value or an invalid one changes nothing', () => {
    for (const stored of [undefined, null, '', 'ultra', 5]) {
      expect(
        effortVariantForPrompt({
          stored,
          resolveCatalogModel: () =>
            modelWithReasoningOptions([{ type: 'effort', values: ['low', 'medium', 'high'] }]),
        }),
      ).toBeUndefined();
    }
  });

  test('the prompt override selects the model, not the session pin', () => {
    const supports = modelWithReasoningOptions([{ type: 'effort', values: ['low', 'xhigh'] }]);
    const refuses = modelWithReasoningOptions([{ type: 'effort', values: ['low'] }]);
    expect(
      effortVariantForPrompt({
        stored: 'xhigh',
        modelOverride: { providerID: 'kortix', modelID: 'gpt-5.6-sol' },
        sessionModelRef: 'kortix/claude-opus-4.8',
        // One stub that answers differently per wire id.
        resolveCatalogModel: (wire) => (wire === 'gpt-5.6-sol' ? supports : refuses),
      }),
    ).toBe('xhigh');
    expect(
      effortVariantForPrompt({
        stored: 'xhigh',
        sessionModelRef: 'kortix/claude-opus-4.8',
        resolveCatalogModel: (wire) => (wire === 'gpt-5.6-sol' ? supports : refuses),
      }),
    ).toBeUndefined();
  });

  test('the real bundled catalog resolves a managed slug through its pricingRef', () => {
    // Not a stub: the production path. `deepseek-v4.1-flash` is the platform's
    // managed default and publishes none/low/high/max via its pricingRef.
    expect(promptWireModel(null, 'kortix/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(effortVariantForPrompt({ stored: 'max', sessionModelRef: 'kortix/deepseek-v4.1-flash' })).toBe('max');
    // …and an effort it does not publish is dropped, never sent.
    expect(effortVariantForPrompt({ stored: 'medium', sessionModelRef: 'kortix/deepseek-v4.1-flash' })).toBeUndefined();
  });
});
