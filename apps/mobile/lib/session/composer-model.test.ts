import { describe, expect, test } from 'bun:test';

import {
  composerModelLabel,
  effectiveComposerModel,
  isModelUnavailable,
  selectComposerModel,
} from './composer-model';

const options = [
  { modelID: 'claude-sonnet-4-6', modelName: 'Sonnet 4.6' },
  { modelID: 'gpt-5', modelName: 'GPT-5' },
];

describe('composer model pill', () => {
  test('labels the pick, else the project default, and hides with no catalog', () => {
    expect(composerModelLabel(options, 'gpt-5', 'claude-sonnet-4-6')).toBe('GPT-5');
    expect(composerModelLabel(options, null, 'claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(composerModelLabel(options, null, undefined)).toBe('Default');
    expect(composerModelLabel([], null, 'claude-sonnet-4-6')).toBeNull();
  });

  test('picking the default clears the pick; any other model pins it', () => {
    expect(selectComposerModel('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBeNull();
    expect(selectComposerModel('gpt-5', 'claude-sonnet-4-6')).toBe('gpt-5');
    expect(effectiveComposerModel(null, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(effectiveComposerModel('gpt-5', 'claude-sonnet-4-6')).toBe('gpt-5');
    expect(effectiveComposerModel(null, undefined)).toBeNull();
  });
});

describe('model availability (KRTX-251)', () => {
  test('the catalog loaded and offers no model: unavailable', () => {
    expect(isModelUnavailable({ hasCatalog: true, loading: false, modelCount: 0 })).toBe(true);
  });

  test('the catalog is still loading: not unavailable, the send is not blocked', () => {
    expect(isModelUnavailable({ hasCatalog: false, loading: true, modelCount: 0 })).toBe(false);
    expect(isModelUnavailable({ hasCatalog: true, loading: true, modelCount: 0 })).toBe(false);
  });

  test('the gateway is disabled (no catalog): not unavailable', () => {
    expect(isModelUnavailable({ hasCatalog: false, loading: false, modelCount: 0 })).toBe(false);
  });

  test('at least one model: available', () => {
    expect(isModelUnavailable({ hasCatalog: true, loading: false, modelCount: 3 })).toBe(false);
  });
});
