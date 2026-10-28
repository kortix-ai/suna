import { describe, expect, test } from 'bun:test';

import { TEST_MANAGED_LINEUP } from '../../__tests__/fixtures/managed-lineup';
import { catalogModelForWireModel, hasImageOutput } from './catalog-models';
import { __setManagedLineupForTest } from './managed-models';

__setManagedLineupForTest(TEST_MANAGED_LINEUP);

// The real runtime catalog (the bundled models.dev snapshot).
describe('hasImageOutput', () => {
  test('a model the catalog lists with image output has it, image-only or text and image', () => {
    for (const model of ['openai/gpt-image-1', 'xai/grok-imagine-image', 'google/gemini-2.5-flash-image', 'openrouter/google/gemini-2.5-flash-image']) {
      expect(hasImageOutput(model), model).toBe(true);
    }
  });

  test('a text model has no image output', () => {
    for (const model of ['openai/gpt-5.5', 'anthropic/claude-sonnet-5-5', 'xai/grok-4.6']) {
      expect(catalogModelForWireModel(model)?.modalities?.output, model).toEqual(['text']);
      expect(hasImageOutput(model), model).toBe(false);
    }
  });

  test('an id the catalog does not carry has no image output', () => {
    for (const model of ['openai/no-such-model', 'no-such-provider/model', 'no-such-managed-model']) {
      expect(hasImageOutput(model), model).toBe(false);
    }
  });

  // Platinum's model list carries input modalities only, so a managed record
  // says text output (managedCatalogModel), even for a vision model.
  test('a managed model has no image output', () => {
    const vision = TEST_MANAGED_LINEUP.find((model) => model.vision);
    expect(catalogModelForWireModel(vision!.id)?.modalities?.input).toContain('image');
    expect(hasImageOutput(vision!.id)).toBe(false);
  });
});
